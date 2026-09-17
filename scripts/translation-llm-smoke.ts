// scripts/translation-llm-smoke.ts
// Manual live check of the LLM translator adapter against the real provider. NEVER run in CI:
// it makes billed network calls. Jest's rootDir is `src`, and lint/format target `src` + `test`,
// so nothing automated picks this file up.
//
// Usage:
//   XAI_API_KEY=$(cat ../Credentials/openwa-testkey | tr -d '[:space:]') \
//     npx ts-node --transpile-only scripts/translation-llm-smoke.ts
//
// Optional: SMOKE_TEXT=<sample> replaces probe A's message. Doing so SKIPS the name and profanity
// checks, which assume the built-in sample's "Doug" and its Spanish profanity; a custom sample
// containing neither would fail them spuriously. Probe B always uses its built-in text.
//
// The key is only ever read from the environment. It is never logged: the fetch tee below
// inspects response bodies only, never the request headers.
import {
  OpenAiCompatibleClient,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
} from '../src/plugins/extensions/translation/llm-openai-compatible.client';
import { TranslateResult } from '../src/plugins/extensions/translation/core/ports';

/**
 * Tee the raw `choices[0].message.content` off every chat completion so the report can show
 * exactly what the model emitted — before `canonicalizeLang`/`pickTranslation` normalize it.
 * Observing the raw spelling is the whole point of the zh-Hans probe.
 */
const rawContents: string[] = [];
function installFetchTee(): void {
  const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await realFetch(input, init);
    if (String(input).includes('/chat/completions')) {
      try {
        const body = (await res.clone().json()) as { choices?: Array<{ message?: { content?: string } }> };
        rawContents.push(body.choices?.[0]?.message?.content ?? '<no content>');
      } catch {
        rawContents.push('<unparseable response body>');
      }
    }
    return res;
  };
}

const NOW = new Date().toISOString();

async function main(): Promise<void> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('Set XAI_API_KEY (read it from the credentials file; do not paste it into the shell history).');
    process.exit(1);
  }
  installFetchTee();

  const client = new OpenAiCompatibleClient({
    baseUrl: process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    apiKey,
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    timeoutMs: 20000,
  });

  console.log('== models ==');
  console.log('base url:', process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL);
  console.log('model:   ', client.currentModel());
  for (const m of await client.listModels()) console.log(m);

  // ---- Probe A: profanity + glossary name, group speaks en/es/ru (matches the VM's LibreTranslate set).
  console.log('\n== probe A: translate with context (profanity + glossary name) ==');
  const resA = await client.translateAll({
    text: process.env.SMOKE_TEXT ?? 'Joder, qué puto calor hace hoy. Doug, ¿ya estás fuera?',
    senderName: 'Carlos',
    candidateLangs: ['en', 'es', 'ru'],
    hintLang: 'es',
    glossary: ['Doug', 'Carlos'],
    history: [
      { author: 'Doug', lang: 'en', text: 'Are you guys on the terrace already?', at: NOW },
      { author: 'Carlos', lang: 'es', text: 'Casi, bajando ahora', at: NOW },
    ],
    allowExternal: true,
  });
  console.log(JSON.stringify(resA, null, 2));
  console.log('raw model content A:', rawContents[0]);

  // ---- Probe B: the BCP-47 script-subtag case. `zh-Hans` is LibreTranslate's spelling and therefore
  // the group's own spelling. canonicalizeLang/pickTranslation were written from reasoning about what
  // the model would echo back; this probe is the observation.
  console.log('\n== probe B: zh-Hans script subtag ==');
  const resB = await client.translateAll({
    text: 'Vale, pero el cabrón del jefe dijo que hay que entregarlo mañana. Doug, ¿tú qué opinas?',
    senderName: 'Carlos',
    candidateLangs: ['en', 'es', 'zh-Hans'],
    hintLang: 'es',
    glossary: ['Doug', 'Carlos'],
    history: [
      { author: 'Doug', lang: 'en', text: 'Did the client sign off on the deadline?', at: NOW },
      { author: 'Carlos', lang: 'es', text: 'Todavía no, estoy esperando', at: NOW },
    ],
    allowExternal: true,
  });
  console.log(JSON.stringify(resB, null, 2));
  const rawB = rawContents[1] ?? '<missing>';
  console.log('raw model content B:', rawB);
  console.log('raw source spelling B:  ', rawSourceOf(rawB));
  console.log('raw translation keys B: ', JSON.stringify(rawKeysOf(rawB)));

  const enA = textFor(resA, 'en');
  console.log('\nper-target name check A:', JSON.stringify(nameReport(resA, 'Doug')));
  console.log('per-target name check B:', JSON.stringify(nameReport(resB, 'Doug')));
  // Every check below asserts something the MODEL could get wrong. Deliberately absent:
  // `detected === 'es'` (the client assigns `detected: source`, so it only restates sourceIsEs)
  // and "source not echoed as a target" (the client's own loop skips the source language). Both
  // would pass regardless of what the provider returned.
  const checks: Record<string, boolean> = {
    // Probe A
    sourceIsEs: resA.source === 'es',
    hasRu: resA.translations.some(t => t.lang === 'ru'),
    // Probe B
    zhSourceIsEs: resB.source === 'es',
    zhHasZhHansExactSpelling: resB.translations.some(t => t.lang === 'zh-Hans'),
    zhHasHanText: /[一-鿿]/.test(textFor(resB, 'zh-Hans')),
    zhKeepsNameInLatinTargets: keepsNameInLatinTargets(resB, 'Doug'),
  };
  // Probe A's content assertions only hold for the built-in sample. A caller-supplied SMOKE_TEXT
  // need contain neither "Doug" nor anything that translates to English profanity, so asserting
  // them against it would report a spurious failure rather than a real one.
  if (process.env.SMOKE_TEXT) {
    console.log('\nSMOKE_TEXT set: skipping the name and profanity checks (they assume the built-in sample).');
  } else {
    // Asserted only for Latin-script targets. The model transliterates "Doug" to "Даг"/"Дуг" in
    // Russian; the owner accepted that (spec §18), so it must not turn this check red. The
    // per-target nameReport above still prints every language, Russian and Chinese included.
    checks.keepsNameInLatinTargets = keepsNameInLatinTargets(resA, 'Doug');
    checks.keepsProfanity = /fuck|damn|hell|shit|bloody|piss/i.test(enA);
  }
  console.log('\nchecks:', checks);
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  if (failed.length > 0) {
    console.error('FAILED CHECKS:', failed.join(', '));
    process.exit(2);
  }
  console.log('all checks passed');
}

function textFor(res: TranslateResult, lang: string): string {
  return res.translations.find(t => t.lang === lang)?.text ?? '';
}

/**
 * Latin-alphabet targets: the only ones where "did the name survive verbatim?" is a fair question.
 * Anything not listed is treated as non-Latin, so an unrecognised code is reported but not asserted.
 */
const LATIN_SCRIPT_LANGS = new Set([
  'ca',
  'da',
  'de',
  'en',
  'es',
  'fi',
  'fr',
  'id',
  'it',
  'nl',
  'pl',
  'pt',
  'ro',
  'sv',
  'tr',
  'vi',
]);

/**
 * A glossary name must survive verbatim in every LATIN-SCRIPT target. Transliteration into a
 * non-Latin script ("Doug" -> "Дуг" in Russian) is accepted behaviour — the project owner decided
 * that, see spec §18 — so those targets are printed by nameReport() but never asserted here.
 */
function keepsNameInLatinTargets(res: TranslateResult, name: string): boolean {
  const latinTargets = res.translations.filter(t => LATIN_SCRIPT_LANGS.has(t.lang));
  return latinTargets.length > 0 && latinTargets.every(t => t.text.includes(name));
}

/**
 * Per-target breakdown for EVERY target, non-Latin scripts included, so the human running the
 * smoke test still sees exactly what each language did even where the result is not asserted.
 */
function nameReport(res: TranslateResult, name: string): Record<string, boolean> {
  return Object.fromEntries(res.translations.map(t => [t.lang, t.text.includes(name)]));
}

/** Pull the model's own, un-canonicalized `source` out of the raw completion content. */
function rawSourceOf(content: string): string {
  const parsed = looseParse(content);
  const source = parsed?.source;
  return typeof source === 'string' ? source : '<unreadable>';
}

/** Pull the model's own translation-map keys, exactly as spelled, out of the raw completion content. */
function rawKeysOf(content: string): string[] {
  const map = looseParse(content)?.translations;
  return typeof map === 'object' && map !== null ? Object.keys(map as Record<string, unknown>) : ['<unreadable>'];
}

function looseParse(content: string): { source?: unknown; translations?: unknown } | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(content.slice(start, end + 1)) as { source?: unknown; translations?: unknown };
  } catch {
    return undefined;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
