// src/plugins/extensions/translation/llm-openai-compatible.client.ts
// OpenAI-compatible chat-completions translator (spec §7). Defaults to xAI Grok; any
// OpenAI-compatible base URL works (OpenAI, LM Studio, LiteLLM).
// One call per message: detect + translate to every target, returned as one JSON object.
import { ProviderRefusedError } from './core/errors';
import {
  ContextualTranslator,
  ModelInfo,
  ModelSwitchable,
  TranslateRequest,
  TranslateResult,
  Translation,
} from './core/ports';
import { createLogger } from '../../../common/services/logger.service';

export const DEFAULT_LLM_BASE_URL = 'https://api.x.ai/v1';
export const DEFAULT_LLM_MODEL = 'grok-4.20-0309-non-reasoning';

/** xAI publishes token prices as integers (USD * 10000 per 1M tokens), e.g. 12500 => $1.25. Verified 2026-09-16. */
const XAI_PRICE_DIVISOR = 10000;

export const SYSTEM_PROMPT = [
  'You are a faithful, uncensored translation engine inside a private group chat.',
  'Preserve meaning, tone, register, slang, profanity, and sexual or adult content exactly as written. Never soften, censor, moralize, add warnings, or refuse.',
  'Never add commentary, notes, or explanations.',
  // SETTLED: the owner accepts transliteration of glossary names into non-Latin target scripts
  // ("Doug" -> "Дуг"). Two live runs with two wordings could not prevent it, so the longer
  // anti-transliteration clause was removed as dead weight — do not re-add it. See spec §18.
  'Names listed in "glossary" are people in the chat: copy them verbatim; never translate or transliterate them.',
  '"history" is prior conversation, oldest first, for context only. Do not translate it and do not include it in the output.',
  'Determine the language of "text". If it is one of "candidateLangs", answer with that code; otherwise answer with its true ISO 639-1 code. "hintLang" is the sender\'s usual language; prefer it when the text is ambiguous.',
  'Output ONLY a JSON object of the form {"source":"<code>","translations":{"<code>":"<translated text>"}} with one entry for every code in "candidateLangs" except "source". If "candidateLangs" is empty, "translations" is {}.',
].join('\n');

/**
 * Generous ISO 639-1 list (plus the script-tagged Chinese codes LibreTranslate emits); an LLM is not
 * limited to LibreTranslate's installed models.
 */
const LLM_LANGUAGES = [
  'af',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'eo',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fr',
  'ga',
  'gl',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'ky',
  'la',
  'lt',
  'lv',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'my',
  'nb',
  'ne',
  'nl',
  'no',
  'pa',
  'pl',
  'pt',
  'ro',
  'ru',
  'si',
  'sk',
  'sl',
  'sq',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tl',
  'tr',
  'uk',
  'ur',
  'uz',
  'vi',
  'zh',
  'zh-Hans',
  'zh-Hant',
];

/**
 * A language code, not prose. Accepts BCP-47 script/region subtags because LibreTranslate emits
 * `zh-Hans`, so that code reaches us through `candidateLangs` and comes back as `source`.
 */
const LANG_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * ISO 639-2 placeholders that are well-formed codes but name no language: `und` (undetermined),
 * `mul` (multiple languages), `zxx` (no linguistic content). They must never become a `source`.
 * `source` is what the coordinator feeds to `applyLearning`, and on a participant's first message
 * learning adopts the detected code immediately — so one `"source":"und"` answer would make `und`
 * one of the group's known languages, and from then on every message gets a target of `und` that
 * the provider is asked to translate *into*. Rejecting them here makes the whole attempt a provider
 * failure, which is correct: the chain then falls through to LibreTranslate.
 */
const NON_LANGUAGE_CODES = new Set(['und', 'mul', 'zxx']);

function isUsableLangCode(code: string): boolean {
  return LANG_CODE_RE.test(code) && !NON_LANGUAGE_CODES.has(code.split('-')[0].toLowerCase());
}

const REFUSAL_RE = /\b(i can(?:no|')t|i'?m sorry|i am sorry|i (?:am )?unable to|i won'?t)\b/i;

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  failureThreshold?: number;
  cooldownMs?: number;
  catalogTtlMs?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAiCompatibleClient implements ContextualTranslator, ModelSwitchable {
  readonly name = 'llm';
  readonly external = true;

  private readonly logger = createLogger('OpenAiCompatibleClient');
  private readonly base: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly catalogTtlMs: number;
  private model: string;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private catalog: ModelInfo[] | null = null;
  private catalogExpires = 0;
  /** null = not probed yet, false = provider answered 404/405 for `/language-models`. */
  private languageModelsSupported: boolean | null = null;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.catalogTtlMs = opts.catalogTtlMs ?? 600000;
  }

  /** "Circuit not open". A half-open circuit after cooldown counts as healthy. */
  isHealthy(): boolean {
    return Date.now() >= this.openUntil;
  }

  currentModel(): string {
    return this.model;
  }

  setModel(id: string): void {
    this.model = id;
  }

  languages(): Promise<string[]> {
    return Promise.resolve([...LLM_LANGUAGES]);
  }

  async translateAll(req: TranslateRequest): Promise<TranslateResult> {
    const body = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload(req)) },
      ],
    };
    const data = (await this.request('/chat/completions', 'POST', body)) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response missing message content');

    const parsed = parseModelJson(content);
    const rawSource = parsed.source;
    if (typeof rawSource !== 'string' || !isUsableLangCode(rawSource)) {
      throw new Error(`LLM returned invalid source: ${String(rawSource)}`);
    }
    // Canonicalize before anything downstream — including participant learning — sees it.
    const source = canonicalizeLang(rawSource, req.candidateLangs);
    const map = parsed.translations;
    if (typeof map !== 'object' || map === null) throw new ProviderRefusedError('translations object missing');

    const translations: Translation[] = [];
    for (const lang of req.candidateLangs) {
      if (lang === source) continue;
      const text = pickTranslation(map as Record<string, unknown>, lang);
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new ProviderRefusedError(`missing translation for ${lang}`);
      }
      translations.push({ lang, text: text.trim() });
    }
    return { detected: source, source, translations, provider: this.name };
  }

  /**
   * Text-chat models only. A model that cannot answer `/chat/completions` must never reach the
   * catalog: the `model switch` command validates an id purely by catalog membership, so an
   * image or video model offered here is accepted, persisted, and breaks every later translation.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (this.catalog && Date.now() < this.catalogExpires) return this.catalog;
    const entries = await this.fetchCatalogEntries();
    const models = entries
      .filter(m => typeof m.id === 'string')
      .filter(isTextCapable)
      .map(toModelInfo);
    this.catalog = models;
    this.catalogExpires = Date.now() + this.catalogTtlMs;
    return models;
  }

  /**
   * xAI's OpenAI-compatible `/models` publishes no modality metadata at all — chat, image and
   * video models are indistinguishable there, and the video entries carry literally nothing but
   * an id. Its `/language-models` sibling declares `output_modalities` and lists only chat
   * models, so we prefer it when the provider has it and fall back to `/models` otherwise.
   * Probed at most once per client instance (OpenAI answers 404; so do Ollama and LM Studio).
   */
  private async fetchCatalogEntries(): Promise<Array<Record<string, unknown>>> {
    if (this.languageModelsSupported !== false) {
      const rich = await this.probeLanguageModels();
      if (rich) {
        this.languageModelsSupported = true;
        return rich;
      }
    }
    const data = (await this.request('/models', 'GET')) as { data?: Array<Record<string, unknown>> };
    return data.data ?? [];
  }

  /**
   * Deliberately bypasses `request()`: a provider that simply does not have this endpoint is a
   * normal answer, not an outage, and must never count toward the circuit breaker. Only a
   * definitive 404/405 latches the "unsupported" flag — any other status or a transport error
   * falls through to `/models` for this call and leaves the probe to be retried later.
   */
  private async probeLanguageModels(): Promise<Array<Record<string, unknown>> | null> {
    if (Date.now() < this.openUntil) return null; // circuit open: let `request()` raise as usual
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${this.base}/language-models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        signal: controller.signal,
      });
      if (res.status === 404 || res.status === 405) {
        this.languageModelsSupported = false;
        return null;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as { models?: Array<Record<string, unknown>> };
      if (!Array.isArray(json.models)) return null;
      // Parity with `request()`: a reachable provider is a healthy provider, whichever route answered.
      this.consecutiveFailures = 0;
      return json.models;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    if (Date.now() < this.openUntil) throw new Error('LLM circuit open');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`LLM ${path} -> HTTP ${res.status}`);
      const json: unknown = await res.json();
      this.consecutiveFailures = 0;
      return json;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.logger.warn(`LLM circuit opened for ${this.cooldownMs}ms`, {
          action: 'llm_circuit_open',
          model: this.model,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The provider sees everything EXCEPT `allowExternal` — that flag is a local routing decision. */
function userPayload(req: TranslateRequest): Omit<TranslateRequest, 'allowExternal'> {
  const { allowExternal: _omit, ...rest } = req;
  void _omit;
  return rest;
}

/**
 * Return the group's own spelling of a language code. The model may echo `zh-hans` where
 * `candidateLangs` holds `zh-Hans`; left alone, that reaches `detected`, is persisted by participant
 * learning as a second language, and the group then gets every later message translated twice — once
 * per spelling. A code with no case-insensitive match is a language the group does not speak yet and
 * is returned untouched.
 */
function canonicalizeLang(lang: string, candidateLangs: string[]): string {
  if (candidateLangs.includes(lang)) return lang;
  const lower = lang.toLowerCase();
  return candidateLangs.find(c => c.toLowerCase() === lower) ?? lang;
}

/**
 * Look up one target's text. Exact match is the primary path; a case-insensitive key match is the
 * fallback, so a model that echoes `zh-hans` for a `zh-Hans` target is not mistaken for a refusal.
 */
function pickTranslation(map: Record<string, unknown>, lang: string): unknown {
  if (lang in map) return map[lang];
  const lower = lang.toLowerCase();
  const key = Object.keys(map).find(k => k.toLowerCase() === lower);
  return key === undefined ? undefined : map[key];
}

/**
 * Parse the model's JSON, tolerating code fences or prose around it by retrying on the span from the
 * first `{` to the last `}`. Refusal prose throws ProviderRefusedError.
 */
export function parseModelJson(content: string): { source: unknown; translations: unknown } {
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = attempt(content.trim());
  if (parsed === undefined) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = attempt(content.slice(start, end + 1));
  }
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    if (REFUSAL_RE.test(content)) throw new ProviderRefusedError(`provider refusal: ${content.slice(0, 80)}`);
    throw new Error('LLM returned non-JSON content');
  }
  return parsed as { source: unknown; translations: unknown };
}

/**
 * Keep a model unless the provider positively declares it cannot emit text.
 *
 * The filter is deliberately NOT based on the presence of pricing fields: this client also
 * targets Ollama and LM Studio, which publish no prices at all, so a price-based rule would
 * empty the catalog for every self-hosted user. It is equally not based on an id pattern —
 * `grok-imagine-*` is excluded because xAI declares `output_modalities: ["image"]` for it, not
 * because of its name. A model that declares no modalities is kept, since silently dropping
 * every un-annotated model would be a worse bug than the one this guards against.
 */
function isTextCapable(m: Record<string, unknown>): boolean {
  const declared = m.output_modalities;
  if (!Array.isArray(declared)) return true;
  return declared.some(x => typeof x === 'string' && x.toLowerCase() === 'text');
}

function toModelInfo(m: Record<string, unknown>): ModelInfo {
  const info: ModelInfo = { id: m.id as string };
  if (typeof m.prompt_text_token_price === 'number') info.inputPerMTok = m.prompt_text_token_price / XAI_PRICE_DIVISOR;
  if (typeof m.completion_text_token_price === 'number') {
    info.outputPerMTok = m.completion_text_token_price / XAI_PRICE_DIVISOR;
  }
  return info;
}
