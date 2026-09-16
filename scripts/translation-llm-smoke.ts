// scripts/translation-llm-smoke.ts
// Manual live check of the LLM translator adapter against the real provider. NEVER run in CI:
// it makes billed network calls. Jest's rootDir is `src`, and lint/format target `src` + `test`,
// so nothing automated picks this file up.
//
// Usage:
//   XAI_API_KEY=$(cat ../Credentials/openwa-testkey | tr -d '[:space:]') \
//     npx ts-node --transpile-only scripts/translation-llm-smoke.ts
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
  const checks = {
    // Probe A
    sourceIsEs: resA.source === 'es',
    detectedIsEs: resA.detected === 'es',
    // Checked across EVERY target, not just English: the model preserved "Doug" in English and
    // Chinese but transliterated it to "Даг" in Russian, which an English-only check never saw.
    keepsNameInEveryTarget: keepsNameEverywhere(resA, 'Doug'),
    keepsProfanity: /fuck|damn|hell|shit|bloody|piss/i.test(enA),
    hasRu: resA.translations.some(t => t.lang === 'ru'),
    noSourceEcho: !resA.translations.some(t => t.lang === resA.source),
    // Probe B
    zhSourceIsEs: resB.source === 'es',
    zhHasZhHansExactSpelling: resB.translations.some(t => t.lang === 'zh-Hans'),
    zhHasHanText: /[一-鿿]/.test(textFor(resB, 'zh-Hans')),
    zhKeepsNameInEveryTarget: keepsNameEverywhere(resB, 'Doug'),
  };
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

/** A glossary name must survive verbatim in EVERY target, including non-Latin scripts. */
function keepsNameEverywhere(res: TranslateResult, name: string): boolean {
  return res.translations.length > 0 && res.translations.every(t => t.text.includes(name));
}

/** Per-target breakdown, so a failure names the language that dropped the glossary term. */
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
