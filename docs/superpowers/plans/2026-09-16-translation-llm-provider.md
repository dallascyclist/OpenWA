# Translation LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the group-translation plugin translate through an OpenAI-compatible LLM (Grok first) with conversation context, fall back to LibreTranslate when the LLM fails or refuses, let each group opt out of cloud processing, and let a designated operator switch models from chat.

**Architecture:** A new framework-free `ContextualTranslator` port replaces the coordinator's detect-then-fan-out loop with one `translateAll(request)` call. A `FallbackChain` tries an `OpenAiCompatibleClient` (external) then a `LibreTranslateContextual` wrapper (local) in order. A per-chat `ConversationContext` ring buffer supplies the last N original turns. The coordinator gains three command families (`privacy`, `model`, richer `status`) and posts one-time degraded/recovered notices per group.

**Tech Stack:** NestJS 11 plugin (TypeScript, strict null checks, `nodenext` module resolution, no path aliases), Jest with colocated `*.spec.ts`, global `fetch` (Node 20+), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-translation-llm-provider-design.md` — read it first. The decisions log (section 3) explains every "why"; this plan only tells you "how".

## Execution and review protocol (from spec section 16)

- **Implementer:** Claude Opus, one task at a time, cold context. Every task below restates its intent so you never need to infer it.
- **Reviewer:** Claude Fable reviews after **every task** against the spec section named in the task, and once more at the end (Task 15). Do not start the next task until the review for the current one is done.
- **TDD:** failing spec first, run it and watch it fail, implement, run it and watch it pass, commit. Never skip the "watch it fail" step; it proves the test is real.
- Before every review handoff run: `npm test -- src/plugins/extensions/translation`, `npm run lint`, `npm run format -- --check`. Fix anything red before handing off.
- Work on branch `feat/translation-llm-provider` created from `_local-test-combined` (Task 0).

## Global Constraints

- `src/plugins/extensions/translation/core/` must contain **no** NestJS, TypeORM, or engine imports. Only `ports.ts`, other `core/` files, and Node built-ins.
- Use relative imports only. There are no path aliases.
- Logging inside adapters uses `createLogger('Scope')` from `src/common/services/logger.service.ts` with a structured second argument containing an `action` field. Inside `core/`, log only through the `TranslationLogger` port.
- Never commit secrets. The xAI test key lives at `/Users/dougd/OpenWA/Credentials/openwa-testkey` (outside the repo); reference it by path in commands, never paste its value anywhere.
- Default model id: `grok-4.20-0309-non-reasoning`. Default base URL: `https://api.x.ai/v1`. xAI price fields divide by `10000` to give USD per 1M tokens.
- Do not modify `libretranslate.client.ts`, `plugin-chat.gateway.ts`, or `plugin-config.store.ts`.
- Behaviour delivered to the WhatsApp group for existing features must not change. Existing tests may only be edited where the plan says so and only in the way it says.
- `npm run format -- --check` is enforced by CI. Run `npm run format` if it complains.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/plugins/extensions/translation/core/ports.ts` | modify | All shared types and ports |
| `src/plugins/extensions/translation/core/errors.ts` | create | `ProviderRefusedError`, `AllProvidersFailedError` |
| `src/plugins/extensions/translation/core/conversation-context.ts` | create | Per-chat ring buffer of original turns |
| `src/plugins/extensions/translation/core/libretranslate.contextual.ts` | create | Adapts the old `Translator` port to `ContextualTranslator` |
| `src/plugins/extensions/translation/core/fallback-chain.ts` | create | Ordered providers, external skip, health polling |
| `src/plugins/extensions/translation/core/command.parser.ts` | modify | `privacy`, `model` verbs |
| `src/plugins/extensions/translation/core/reply.formatter.ts` | modify | Disclosure, notices, model list, richer status |
| `src/plugins/extensions/translation/core/translation.coordinator.ts` | modify | Uses the new port, context, privacy, notices, model commands |
| `src/plugins/extensions/translation/llm-openai-compatible.client.ts` | create | Grok / OpenAI-compatible adapter |
| `src/plugins/extensions/translation/plugin-model.store.ts` | create | Persists the chosen model in plugin storage |
| `src/plugins/extensions/translation/index.ts` | modify | Wires chain, context, stores, config keys |
| `src/plugins/extensions/extensions.module.ts` | modify | `configSchema` entries for the new keys |
| `scripts/translation-llm-smoke.ts` | create | Manual live check against the real provider |
| `docs/…/2026-09-16-translation-llm-provider-design.md` §15a | modify | VM ops notes for the new secret and config keys (tracked home) |
| `CLAUDE.md` | modify | same notes, local convenience only — git-ignored, cannot be committed |

---

### Task 0: Branch and baseline

**Intent:** Isolate the work and prove the starting point is green so every later red is yours.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/dougd/OpenWA/OpenWA
git checkout _local-test-combined
git checkout -b feat/translation-llm-provider
```

- [ ] **Step 2: Run the translation suite and record the baseline**

Run: `npm test -- src/plugins/extensions/translation`
Expected: `Test Suites: 6 passed`, `Tests: 35 passed`. If not, stop and report; do not proceed on a red baseline.

- [ ] **Step 3: Lint and format baseline**

Run: `npm run lint && npm run format -- --check`
Expected: both exit 0.

---

### Task 1: Ports and errors

**Intent:** Define every new type once, in `ports.ts`, so all later tasks share exact names. This task has no runtime behaviour; its test is the compiler.

**Files:**
- Modify: `src/plugins/extensions/translation/core/ports.ts`
- Create: `src/plugins/extensions/translation/core/errors.ts`
- Test: `src/plugins/extensions/translation/core/errors.spec.ts`

**Interfaces:**
- Produces: everything below. Later tasks import these names verbatim.

- [ ] **Step 1: Write the failing test for the error classes**

Create `src/plugins/extensions/translation/core/errors.spec.ts`:

```ts
import { ProviderRefusedError, AllProvidersFailedError } from './errors';

describe('translation errors', () => {
  it('ProviderRefusedError is an Error with a stable name', () => {
    const e = new ProviderRefusedError('missing target en');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProviderRefusedError');
    expect(e.message).toBe('missing target en');
  });

  it('AllProvidersFailedError carries per-provider reasons', () => {
    const e = new AllProvidersFailedError(['llm: HTTP 500', 'libretranslate: circuit open']);
    expect(e.name).toBe('AllProvidersFailedError');
    expect(e.reasons).toEqual(['llm: HTTP 500', 'libretranslate: circuit open']);
    expect(e.message).toContain('llm: HTTP 500');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/errors.spec.ts`
Expected: FAIL, "Cannot find module './errors'".

- [ ] **Step 3: Create errors.ts**

```ts
// src/plugins/extensions/translation/core/errors.ts
// Framework-free error types shared by providers and the fallback chain.

/** A provider answered but declined or mangled the job (content refusal, missing target). Never counts toward a circuit breaker. */
export class ProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRefusedError';
  }
}

/** Every provider in the chain failed for this request. */
export class AllProvidersFailedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`all translation providers failed: ${reasons.join('; ')}`);
    this.name = 'AllProvidersFailedError';
  }
}
```

- [ ] **Step 4: Extend ports.ts**

Append the following to `src/plugins/extensions/translation/core/ports.ts`, and make the two small edits noted.

Edit 1: in `GroupState`, add two optional fields after `announced: boolean;`:

```ts
  /** Per-group privacy override; undefined => instance default (`CoordinatorOptions.defaultPrivacy`). */
  privacy?: PrivacyMode;
  /** One-time cloud disclosure already posted in this group. */
  privacyDisclosed?: boolean;
```

Edit 2: extend `CommandName` and `ParsedCommand`:

```ts
export type CommandName =
  | 'help'
  | 'status'
  | 'on'
  | 'off'
  | 'setlang'
  | 'auto'
  | 'ignore'
  | 'unignore'
  | 'grant'
  | 'revoke'
  | 'privacy'
  | 'model';

export type ModelAction = 'show' | 'list' | 'switch';

export interface ParsedCommand {
  name: CommandName;
  lang?: string; // setlang only
  target?: CommandTarget; // setlang/auto/ignore/unignore/grant/revoke
  privacy?: PrivacyMode; // privacy only; undefined => show current
  modelAction?: ModelAction; // model only
  modelId?: string; // model switch only
}
```

Append (new types):

```ts
export type PrivacyMode = 'cloud' | 'local';

export interface EffectivePrivacy {
  mode: PrivacyMode;
  source: 'group' | 'instance';
}

/** One prior message, ORIGINAL text only. Never a translation. */
export interface ContextTurn {
  author: string; // display name (pushName) or the wid's user part
  lang: string; // ISO 639-1 known at the time, or 'und'
  text: string;
  at: string; // ISO timestamp
}

export interface TranslateRequest {
  text: string;
  senderName: string;
  candidateLangs: string[]; // group's known languages; may be empty on a group's first message
  hintLang: string | null; // sender's learned/pinned language
  glossary: string[]; // participant display names; never translate
  history: ContextTurn[]; // oldest first; excludes the current message
  summary?: string; // RESERVED (spec D4); always undefined in this cut
  allowExternal: boolean; // false => external providers must be skipped
}

export interface TranslateResult {
  detected: string; // raw detection; feeds participant learning
  source: string; // language translated FROM after the sanity rule
  translations: Translation[]; // one per candidateLangs entry !== source (fewer on partial failure)
  provider: string; // 'llm' | 'libretranslate'
}

export interface ContextualTranslator {
  readonly name: string;
  readonly external: boolean;
  translateAll(req: TranslateRequest): Promise<TranslateResult>;
  languages(): Promise<string[]>;
  isHealthy(): boolean;
}

/** Reserved (spec D4). Not implemented or wired in this cut. */
export interface SummaryProvider {
  summarize(turns: ContextTurn[], previousSummary?: string): Promise<string>;
}

export interface ModelInfo {
  id: string;
  inputPerMTok?: number; // USD per 1M input tokens, when the provider exposes pricing
  outputPerMTok?: number; // USD per 1M output tokens
}

/** Implemented by providers whose model can be changed at runtime. */
export interface ModelSwitchable {
  listModels(): Promise<ModelInfo[]>;
  currentModel(): string;
  setModel(id: string): void;
}

export interface ModelSelection {
  model: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ModelStore {
  load(): Promise<ModelSelection | null>;
  save(sel: ModelSelection): Promise<void>;
}

export interface ProviderHealth {
  name: string;
  external: boolean;
  healthy: boolean;
}
```

- [ ] **Step 5: Run the error test and the compiler**

Run: `npm test -- src/plugins/extensions/translation/core/errors.spec.ts && npx tsc --noEmit -p tsconfig.json`
Expected: test PASS; tsc exits 0 (nothing consumes the new types yet, so no breakage).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/extensions/translation/core/ports.ts src/plugins/extensions/translation/core/errors.ts src/plugins/extensions/translation/core/errors.spec.ts
git commit -m "feat(translation): ports for contextual translator, privacy, model switching; error types"
```

**Review focus (Fable):** spec section 5 types match exactly; no framework imports in `core/`.

---

### Task 2: ConversationContext ring buffer

**Intent:** Give the LLM memory. A per-chat buffer of the last N original messages, capped by turn count and total characters, always keeping at least the newest turn. Spec section 9.

**Files:**
- Create: `src/plugins/extensions/translation/core/conversation-context.ts`
- Test: `src/plugins/extensions/translation/core/conversation-context.spec.ts`

**Interfaces:**
- Consumes: `ContextTurn` from Task 1.
- Produces: `class ConversationContext { constructor(opts: { maxTurns: number; maxChars: number }); get(sessionId, chatId): ContextTurn[]; append(sessionId, chatId, turn: ContextTurn): void; clear(sessionId, chatId): void }`

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/extensions/translation/core/conversation-context.spec.ts
import { ConversationContext } from './conversation-context';
import { ContextTurn } from './ports';

const turn = (text: string, author = 'A', lang = 'en'): ContextTurn => ({ author, lang, text, at: '2026-09-16T00:00:00Z' });

describe('ConversationContext', () => {
  it('returns an empty history for an unknown chat', () => {
    const ctx = new ConversationContext({ maxTurns: 3, maxChars: 100 });
    expect(ctx.get('s', 'g@g.us')).toEqual([]);
  });

  it('appends oldest-first and returns a copy', () => {
    const ctx = new ConversationContext({ maxTurns: 3, maxChars: 100 });
    ctx.append('s', 'g@g.us', turn('one'));
    ctx.append('s', 'g@g.us', turn('two'));
    const h = ctx.get('s', 'g@g.us');
    expect(h.map(t => t.text)).toEqual(['one', 'two']);
    h.push(turn('leak'));
    expect(ctx.get('s', 'g@g.us')).toHaveLength(2);
  });

  it('evicts the oldest turn beyond maxTurns', () => {
    const ctx = new ConversationContext({ maxTurns: 2, maxChars: 1000 });
    ['a', 'b', 'c'].forEach(t => ctx.append('s', 'g', turn(t)));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['b', 'c']);
  });

  it('evicts oldest turns beyond maxChars but always keeps the newest', () => {
    const ctx = new ConversationContext({ maxTurns: 10, maxChars: 10 });
    ctx.append('s', 'g', turn('12345'));
    ctx.append('s', 'g', turn('67890'));
    ctx.append('s', 'g', turn('x'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['67890', 'x']);
    ctx.append('s', 'g', turn('this one alone is longer than ten'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['this one alone is longer than ten']);
  });

  it('isolates chats and sessions', () => {
    const ctx = new ConversationContext({ maxTurns: 5, maxChars: 1000 });
    ctx.append('s1', 'g', turn('s1'));
    ctx.append('s2', 'g', turn('s2'));
    ctx.append('s1', 'h', turn('h'));
    expect(ctx.get('s1', 'g').map(t => t.text)).toEqual(['s1']);
    expect(ctx.get('s2', 'g').map(t => t.text)).toEqual(['s2']);
    expect(ctx.get('s1', 'h').map(t => t.text)).toEqual(['h']);
  });

  it('clear() empties one chat only', () => {
    const ctx = new ConversationContext({ maxTurns: 5, maxChars: 1000 });
    ctx.append('s', 'g', turn('g'));
    ctx.append('s', 'h', turn('h'));
    ctx.clear('s', 'g');
    expect(ctx.get('s', 'g')).toEqual([]);
    expect(ctx.get('s', 'h')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/conversation-context.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/plugins/extensions/translation/core/conversation-context.ts
// In-memory, per-chat ring buffer of ORIGINAL message turns used as LLM context (spec §9).
// Not persisted by design; lost on restart.
import { ContextTurn } from './ports';

export interface ConversationContextOptions {
  maxTurns: number;
  maxChars: number;
}

export class ConversationContext {
  private readonly buffers = new Map<string, ContextTurn[]>();

  constructor(private readonly opts: ConversationContextOptions) {}

  private key(sessionId: string, chatId: string): string {
    return `${sessionId}:${chatId}`;
  }

  get(sessionId: string, chatId: string): ContextTurn[] {
    return [...(this.buffers.get(this.key(sessionId, chatId)) ?? [])];
  }

  append(sessionId: string, chatId: string, turn: ContextTurn): void {
    const k = this.key(sessionId, chatId);
    const buf = this.buffers.get(k) ?? [];
    buf.push(turn);
    while (buf.length > this.opts.maxTurns) buf.shift();
    // Character cap: evict oldest-first but always keep the newest turn.
    while (buf.length > 1 && totalChars(buf) > this.opts.maxChars) buf.shift();
    this.buffers.set(k, buf);
  }

  clear(sessionId: string, chatId: string): void {
    this.buffers.delete(this.key(sessionId, chatId));
  }
}

function totalChars(turns: ContextTurn[]): number {
  return turns.reduce((n, t) => n + t.text.length, 0);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/core/conversation-context.spec.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/conversation-context.ts src/plugins/extensions/translation/core/conversation-context.spec.ts
git commit -m "feat(translation): per-chat conversation context ring buffer"
```

**Review focus (Fable):** spec §9 caps; newest-turn guarantee; no framework imports.

---

### Task 3: LibreTranslateContextual wrapper

**Intent:** Put today's LibreTranslate behaviour behind the new port so it can be the last link in the chain. It reproduces exactly what the coordinator does now: detect, apply the sanity rule using the hint, translate into every candidate except the source, tolerate partial failures. Spec §4 and §6.

**Files:**
- Create: `src/plugins/extensions/translation/core/libretranslate.contextual.ts`
- Test: `src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts`

**Interfaces:**
- Consumes: `Translator`, `ContextualTranslator`, `TranslateRequest`, `TranslateResult`, `TranslationLogger` (Task 1).
- Produces: `class LibreTranslateContextual implements ContextualTranslator { constructor(inner: Translator, logger?: TranslationLogger); name = 'libretranslate'; external = false }`

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts
import { LibreTranslateContextual } from './libretranslate.contextual';
import { TranslateRequest, Translator } from './ports';

function fakeTranslator() {
  const detect = jest.fn();
  const translate = jest.fn();
  const languages = jest.fn().mockResolvedValue(['en', 'es']);
  const isHealthy = jest.fn().mockReturnValue(true);
  const t: Translator = { detect, translate, languages, isHealthy };
  return { t, detect, translate, languages, isHealthy };
}

const req = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  text: 'hola',
  senderName: 'Ana',
  candidateLangs: ['en', 'es', 'ru'],
  hintLang: 'es',
  glossary: [],
  history: [],
  allowExternal: true,
  ...over,
});

describe('LibreTranslateContextual', () => {
  it('is a local provider named libretranslate', () => {
    const { t } = fakeTranslator();
    const p = new LibreTranslateContextual(t);
    expect(p.name).toBe('libretranslate');
    expect(p.external).toBe(false);
  });

  it('detects, then translates into every candidate except the source', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'es', confidence: 0.9 });
    translate.mockImplementation((_q: string, _s: string, target: string) => Promise.resolve(`[${target}]`));
    const out = await new LibreTranslateContextual(t).translateAll(req());
    expect(out).toEqual({
      detected: 'es',
      source: 'es',
      translations: [
        { lang: 'en', text: '[en]' },
        { lang: 'ru', text: '[ru]' },
      ],
      provider: 'libretranslate',
    });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenCalledWith('hola', 'es', 'en');
  });

  it('applies the sanity rule: unknown detection falls back to hintLang but detected is reported raw', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    translate.mockResolvedValue('x');
    const out = await new LibreTranslateContextual(t).translateAll(req({ candidateLangs: ['en', 'es'], hintLang: 'es' }));
    expect(out.detected).toBe('gl');
    expect(out.source).toBe('es');
    expect(translate).toHaveBeenCalledWith('hola', 'es', 'en');
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('uses the raw detection when there is no hint', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    translate.mockResolvedValue('x');
    const out = await new LibreTranslateContextual(t).translateAll(req({ candidateLangs: ['en'], hintLang: null }));
    expect(out.source).toBe('gl');
    expect(translate).toHaveBeenCalledWith('hola', 'gl', 'en');
  });

  it('keeps successful targets when one translate call fails and warns', async () => {
    const { t, detect, translate } = fakeTranslator();
    const warn = jest.fn();
    detect.mockResolvedValue({ lang: 'es', confidence: 0.9 });
    translate.mockImplementation((_q: string, _s: string, target: string) =>
      target === 'ru' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
    );
    const out = await new LibreTranslateContextual(t, { debug: jest.fn(), info: jest.fn(), warn }).translateAll(req());
    expect(out.translations).toEqual([{ lang: 'en', text: 'ok' }]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: 'translation_translate_failed', target: 'ru' }));
  });

  it('propagates a detect failure', async () => {
    const { t, detect } = fakeTranslator();
    detect.mockRejectedValue(new Error('down'));
    await expect(new LibreTranslateContextual(t).translateAll(req())).rejects.toThrow('down');
  });

  it('delegates languages() and isHealthy()', async () => {
    const { t, isHealthy } = fakeTranslator();
    isHealthy.mockReturnValue(false);
    const p = new LibreTranslateContextual(t);
    expect(await p.languages()).toEqual(['en', 'es']);
    expect(p.isHealthy()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/plugins/extensions/translation/core/libretranslate.contextual.ts
// Adapts the legacy detect/translate `Translator` port to `ContextualTranslator` (spec §4, §6).
// Reproduces the coordinator's former behaviour: detect, sanity-check the source against the
// group's languages (falling back to the sender's known language), fan out per target.
import { ContextualTranslator, Translation, TranslateRequest, TranslateResult, TranslationLogger, Translator } from './ports';

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

export class LibreTranslateContextual implements ContextualTranslator {
  readonly name = 'libretranslate';
  readonly external = false;

  constructor(
    private readonly inner: Translator,
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}

  isHealthy(): boolean {
    return this.inner.isHealthy();
  }

  languages(): Promise<string[]> {
    return this.inner.languages();
  }

  async translateAll(req: TranslateRequest): Promise<TranslateResult> {
    const detected = (await this.inner.detect(req.text)).lang;
    const source = req.candidateLangs.includes(detected) ? detected : (req.hintLang ?? detected);
    const targets = req.candidateLangs.filter(l => l !== source);
    const settled = await Promise.allSettled(targets.map(t => this.inner.translate(req.text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        translations.push({ lang: targets[i], text: r.value });
      } else {
        this.logger.warn('translate call failed', {
          action: 'translation_translate_failed',
          source,
          target: targets[i],
          error: String(r.reason),
        });
      }
    });
    return { detected, source, translations, provider: this.name };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/libretranslate.contextual.ts src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts
git commit -m "feat(translation): LibreTranslate adapter for the contextual translator port"
```

**Review focus (Fable):** sanity rule matches the coordinator's existing one line-for-line; `detected` stays raw.

---

### Task 4: FallbackChain

**Intent:** Try providers in order, skip external ones when the group is local-only, never skip on health (an open circuit throws instantly and recovers on its own), report which provider answered, and expose per-provider health for notices. Spec §8.

**Files:**
- Create: `src/plugins/extensions/translation/core/fallback-chain.ts`
- Test: `src/plugins/extensions/translation/core/fallback-chain.spec.ts`

**Interfaces:**
- Consumes: `ContextualTranslator`, `ProviderHealth`, `TranslationLogger` (Task 1); `ProviderRefusedError`, `AllProvidersFailedError` (Task 1).
- Produces: `class FallbackChain implements ContextualTranslator { constructor(providers: ContextualTranslator[], logger?: TranslationLogger); providerHealth(): ProviderHealth[] }`

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/extensions/translation/core/fallback-chain.spec.ts
import { FallbackChain } from './fallback-chain';
import { AllProvidersFailedError, ProviderRefusedError } from './errors';
import { ContextualTranslator, TranslateRequest, TranslateResult } from './ports';

function provider(name: string, external: boolean) {
  const translateAll = jest.fn<Promise<TranslateResult>, [TranslateRequest]>();
  const languages = jest.fn().mockResolvedValue([name]);
  const isHealthy = jest.fn().mockReturnValue(true);
  const p: ContextualTranslator = { name, external, translateAll, languages, isHealthy };
  return { p, translateAll, languages, isHealthy };
}

const ok = (provider: string): TranslateResult => ({ detected: 'es', source: 'es', translations: [{ lang: 'en', text: 'hi' }], provider });
const req = (allowExternal = true): TranslateRequest => ({
  text: 'hola', senderName: 'A', candidateLangs: ['en', 'es'], hintLang: 'es', glossary: [], history: [], allowExternal,
});

describe('FallbackChain', () => {
  it('returns the first provider result', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.translateAll.mockResolvedValue(ok('llm'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req());
    expect(out.provider).toBe('llm');
    expect(lt.translateAll).not.toHaveBeenCalled();
  });

  it('skips external providers when allowExternal is false', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req(false));
    expect(out.provider).toBe('libretranslate');
    expect(llm.translateAll).not.toHaveBeenCalled();
  });

  it('falls through on a throw and logs it, flagging refusals', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    const warn = jest.fn();
    llm.translateAll.mockRejectedValue(new ProviderRefusedError('missing target en'));
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p], { debug: jest.fn(), info: jest.fn(), warn }).translateAll(req());
    expect(out.provider).toBe('libretranslate');
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'translation_provider_failed', provider: 'llm', refused: true }),
    );
  });

  it('does NOT skip an unhealthy provider (its own circuit throws fast)', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.isHealthy.mockReturnValue(false);
    llm.translateAll.mockRejectedValue(new Error('LLM circuit open'));
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req());
    expect(llm.translateAll).toHaveBeenCalledTimes(1);
    expect(out.provider).toBe('libretranslate');
  });

  it('throws AllProvidersFailedError with every reason when all fail', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.translateAll.mockRejectedValue(new Error('HTTP 500'));
    lt.translateAll.mockRejectedValue(new Error('down'));
    const chain = new FallbackChain([llm.p, lt.p]);
    await expect(chain.translateAll(req())).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(chain.translateAll(req())).rejects.toThrow(/llm: .*HTTP 500.*libretranslate: .*down/);
  });

  it('providerHealth() reports each provider by polling isHealthy()', () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.isHealthy.mockReturnValue(false);
    expect(new FallbackChain([llm.p, lt.p]).providerHealth()).toEqual([
      { name: 'llm', external: true, healthy: false },
      { name: 'libretranslate', external: false, healthy: true },
    ]);
  });

  it('isHealthy() is true if any provider is healthy; languages() prefers a healthy local provider', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    const chain = new FallbackChain([llm.p, lt.p]);
    expect(chain.isHealthy()).toBe(true);
    expect(await chain.languages()).toEqual(['libretranslate']);
    lt.isHealthy.mockReturnValue(false);
    expect(await chain.languages()).toEqual(['llm']);
    llm.isHealthy.mockReturnValue(false);
    expect(chain.isHealthy()).toBe(false);
    await expect(chain.languages()).rejects.toThrow('no healthy translation provider');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/fallback-chain.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/plugins/extensions/translation/core/fallback-chain.ts
// Ordered provider chain (spec §8): first provider that answers wins. External providers are skipped
// when the request forbids them. Health is never used to skip: an open circuit throws instantly
// inside the provider and the provider's own cooldown is what lets it recover.
import { AllProvidersFailedError, ProviderRefusedError } from './errors';
import { ContextualTranslator, ProviderHealth, TranslateRequest, TranslateResult, TranslationLogger } from './ports';

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

export class FallbackChain implements ContextualTranslator {
  readonly name = 'chain';
  readonly external = false;

  constructor(
    private readonly providers: ContextualTranslator[],
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}

  async translateAll(req: TranslateRequest): Promise<TranslateResult> {
    const reasons: string[] = [];
    for (const p of this.providers) {
      if (p.external && !req.allowExternal) continue;
      try {
        return await p.translateAll(req);
      } catch (err) {
        const refused = err instanceof ProviderRefusedError;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn('translation provider failed; trying next', {
          action: 'translation_provider_failed',
          provider: p.name,
          refused,
          reason,
        });
        reasons.push(`${p.name}: ${reason}`);
      }
    }
    throw new AllProvidersFailedError(reasons);
  }

  isHealthy(): boolean {
    return this.providers.some(p => p.isHealthy());
  }

  async languages(): Promise<string[]> {
    const pick = this.providers.find(p => !p.external && p.isHealthy()) ?? this.providers.find(p => p.isHealthy());
    if (!pick) throw new Error('no healthy translation provider');
    return pick.languages();
  }

  providerHealth(): ProviderHealth[] {
    return this.providers.map(p => ({ name: p.name, external: p.external, healthy: p.isHealthy() }));
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/core/fallback-chain.spec.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/fallback-chain.ts src/plugins/extensions/translation/core/fallback-chain.spec.ts
git commit -m "feat(translation): fallback chain over contextual translators"
```

**Review focus (Fable):** no health-based skipping (spec §8 rationale); refusal flag in the log.

---

### Task 5: PluginModelStore

**Intent:** Persist the operator's model choice so a container restart (which re-PUTs plugin config on the VM) does not revert it. Spec §11a persistence.

**Files:**
- Create: `src/plugins/extensions/translation/plugin-model.store.ts`
- Test: `src/plugins/extensions/translation/plugin-model.store.spec.ts`

**Interfaces:**
- Consumes: `ModelStore`, `ModelSelection` (Task 1); `PluginStorage` from `../../../core/plugins`.
- Produces: `class PluginModelStore implements ModelStore { constructor(storage: PluginStorage) }`, storage key `llm:model`.

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/extensions/translation/plugin-model.store.spec.ts
import { PluginModelStore } from './plugin-model.store';

function makeStorage() {
  const data = new Map<string, unknown>();
  return {
    get: jest.fn((k: string) => Promise.resolve(data.has(k) ? data.get(k) : null)),
    set: jest.fn((k: string, v: unknown) => {
      data.set(k, v);
      return Promise.resolve();
    }),
    delete: jest.fn((k: string) => {
      data.delete(k);
      return Promise.resolve();
    }),
    list: jest.fn(() => Promise.resolve([...data.keys()])),
  };
}

describe('PluginModelStore', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await new PluginModelStore(makeStorage() as never).load()).toBeNull();
  });

  it('round-trips a selection under the llm:model key', async () => {
    const storage = makeStorage();
    const store = new PluginModelStore(storage as never);
    const sel = { model: 'grok-4.3', updatedAt: '2026-09-16T00:00:00Z', updatedBy: '1@c.us' };
    await store.save(sel);
    expect(storage.set).toHaveBeenCalledWith('llm:model', sel);
    expect(await store.load()).toEqual(sel);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/plugin-model.store.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/plugins/extensions/translation/plugin-model.store.ts
import { ModelSelection, ModelStore } from './core/ports';
import { PluginStorage } from '../../../core/plugins';

const KEY = 'llm:model';

/**
 * Persists the operator's runtime model choice (`/tr model switch`) in plugin KV storage so it
 * survives restarts and the VM's post-boot config re-PUT (spec §11a).
 */
export class PluginModelStore implements ModelStore {
  constructor(private readonly storage: PluginStorage) {}

  load(): Promise<ModelSelection | null> {
    return this.storage.get<ModelSelection>(KEY);
  }

  save(sel: ModelSelection): Promise<void> {
    return this.storage.set(KEY, sel);
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/plugin-model.store.spec.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/plugin-model.store.ts src/plugins/extensions/translation/plugin-model.store.spec.ts
git commit -m "feat(translation): persist runtime model selection in plugin storage"
```

---

### Task 6: OpenAiCompatibleClient, translation path

**Intent:** The Grok adapter. One chat-completions call per message, strict JSON validation, refusal detection that falls through to LibreTranslate, and a circuit breaker that ignores refusals. Spec §7.

**Files:**
- Create: `src/plugins/extensions/translation/llm-openai-compatible.client.ts`
- Test: `src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts`

**Interfaces:**
- Consumes: Task 1 types and errors; `createLogger` from `../../../common/services/logger.service`.
- Produces: `class OpenAiCompatibleClient implements ContextualTranslator, ModelSwitchable`, `interface OpenAiCompatibleOptions { baseUrl; apiKey; model; timeoutMs; failureThreshold?; cooldownMs?; catalogTtlMs? }`, exported constants `DEFAULT_LLM_MODEL`, `DEFAULT_LLM_BASE_URL`, `SYSTEM_PROMPT`, and exported helper `parseModelJson(content: string)`. Model listing is added in Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts
import { OpenAiCompatibleClient, parseModelJson } from './llm-openai-compatible.client';
import { ProviderRefusedError } from './core/errors';
import { TranslateRequest } from './core/ports';

const req = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  text: 'hola Doug',
  senderName: 'Ana',
  candidateLangs: ['en', 'es', 'ru'],
  hintLang: 'es',
  glossary: ['Doug', 'Ana'],
  history: [{ author: 'Doug', lang: 'en', text: 'hi', at: '2026-09-16T00:00:00Z' }],
  allowExternal: true,
  ...over,
});

const completion = (content: string) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ choices: [{ message: { content } }] }),
});

function client(over: Partial<ConstructorParameters<typeof OpenAiCompatibleClient>[0]> = {}) {
  return new OpenAiCompatibleClient({
    baseUrl: 'https://api.x.ai/v1/',
    apiKey: 'k',
    model: 'grok-test',
    timeoutMs: 1000,
    ...over,
  });
}

describe('OpenAiCompatibleClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is an external provider named llm', () => {
    const c = client();
    expect(c.name).toBe('llm');
    expect(c.external).toBe(true);
    expect(c.currentModel()).toBe('grok-test');
  });

  it('posts a chat completion with system + JSON user payload and parses the result', async () => {
    const fetchMock = jest
      .fn<Promise<unknown>, [string, RequestInit?]>()
      .mockResolvedValue(completion('{"source":"es","translations":{"en":"hi Doug","ru":"привет Doug"}}'));
    global.fetch = fetchMock as never;

    const out = await client().translateAll(req());

    expect(out).toEqual({
      detected: 'es',
      source: 'es',
      translations: [
        { lang: 'en', text: 'hi Doug' },
        { lang: 'ru', text: 'привет Doug' },
      ],
      provider: 'llm',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init?.body as string) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('grok-test');
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/glossary/);
    const user = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    expect(user).toMatchObject({ text: 'hola Doug', candidateLangs: ['en', 'es', 'ru'], hintLang: 'es', glossary: ['Doug', 'Ana'] });
    expect(user).not.toHaveProperty('allowExternal');
  });

  it('extracts JSON wrapped in code fences or prose', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('Sure!\n```json\n{"source":"es","translations":{"en":"hi","ru":"x"}}\n```')) as never;
    const out = await client().translateAll(req());
    expect(out.translations[0]).toEqual({ lang: 'en', text: 'hi' });
  });

  it('throws ProviderRefusedError when a required target is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"es","translations":{"en":"hi"}}')) as never;
    await expect(client().translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
  });

  it('throws ProviderRefusedError on refusal prose instead of JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion("I'm sorry, but I can't help with that request.")) as never;
    await expect(client().translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
  });

  it('throws a plain Error on non-JSON that is not a refusal', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('hola => hello')) as never;
    const p = client().translateAll(req());
    await expect(p).rejects.toThrow(/non-JSON/);
    await expect(p).rejects.not.toBeInstanceOf(ProviderRefusedError);
  });

  it('rejects an invalid source code', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"Spanish","translations":{"en":"hi","ru":"x"}}')) as never;
    await expect(client().translateAll(req())).rejects.toThrow(/invalid source/);
  });

  it('returns empty translations when candidateLangs is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"de","translations":{}}')) as never;
    const out = await client().translateAll(req({ candidateLangs: [], hintLang: null }));
    expect(out).toEqual({ detected: 'de', source: 'de', translations: [], provider: 'llm' });
  });

  it('aborts on timeout and counts it as a failure', async () => {
    global.fetch = jest.fn((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    ) as never;
    await expect(client({ timeoutMs: 10 }).translateAll(req())).rejects.toThrow('aborted');
  });

  it('opens the circuit after N transport failures, throws fast while open, and reports unhealthy', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }) as never;
    const c = client({ failureThreshold: 2, cooldownMs: 60000 });
    await expect(c.translateAll(req())).rejects.toThrow('HTTP 500');
    expect(c.isHealthy()).toBe(true);
    await expect(c.translateAll(req())).rejects.toThrow('HTTP 500');
    expect(c.isHealthy()).toBe(false);
    await expect(c.translateAll(req())).rejects.toThrow('circuit open');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('refusals do not count toward the breaker', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"es","translations":{}}')) as never;
    const c = client({ failureThreshold: 1 });
    await expect(c.translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
    await expect(c.translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
    expect(c.isHealthy()).toBe(true);
  });

  it('languages() returns a broad static list including en/es/ru/zh', async () => {
    const langs = await client().languages();
    expect(langs).toEqual(expect.arrayContaining(['en', 'es', 'ru', 'zh']));
    expect(langs.length).toBeGreaterThan(40);
  });
});

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson('{"source":"en","translations":{}}')).toEqual({ source: 'en', translations: {} });
  });
  it('extracts the first balanced object from surrounding text', () => {
    expect(parseModelJson('Here: {"source":"en","translations":{"es":"x"}} done')).toEqual({ source: 'en', translations: { es: 'x' } });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/plugins/extensions/translation/llm-openai-compatible.client.ts
// OpenAI-compatible chat-completions adapter (spec §7). Default target is xAI Grok, but any
// compatible base URL works (OpenAI, Ollama, LM Studio, LiteLLM). One call per message:
// detect + translate into every candidate language, JSON out.
import { ProviderRefusedError } from './core/errors';
import { ContextualTranslator, ModelInfo, ModelSwitchable, TranslateRequest, TranslateResult, Translation } from './core/ports';
import { createLogger } from '../../../common/services/logger.service';

export const DEFAULT_LLM_BASE_URL = 'https://api.x.ai/v1';
export const DEFAULT_LLM_MODEL = 'grok-4.20-0309-non-reasoning';

/** xAI quotes token prices as (USD per 1M tokens) x 10000, e.g. 12500 => USD 1.25. Verified live 2026-09-16. */
const XAI_PRICE_DIVISOR = 10000;

export const SYSTEM_PROMPT = [
  'You are a professional translator embedded in a group chat.',
  'Translate the message in "text" faithfully. Preserve tone, register, slang, profanity, and sexual or adult content exactly as written. Never soften, censor, moralize, add warnings, or refuse.',
  'Never add commentary, notes, or explanations.',
  'Names listed in "glossary" are people in the chat: copy them verbatim; never translate or transliterate them.',
  '"history" is prior conversation, oldest first, for context only. Do not translate it and do not include it in the output.',
  'Determine the language of "text". If it is one of "candidateLangs", answer with that code; otherwise answer with its true ISO 639-1 code. "hintLang" is the sender\'s usual language; prefer it when the text is ambiguous.',
  'Output ONLY a JSON object of the form {"source":"<code>","translations":{"<code>":"<translated text>"}} containing one entry for every code in "candidateLangs" except "source". If "candidateLangs" is empty, "translations" is {}.',
].join('\n');

/** Generous ISO 639-1 list; an LLM is not limited to LibreTranslate's installed models. */
const LLM_LANGUAGES = [
  'af', 'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'fi',
  'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'ky', 'la',
  'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'nb', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'si', 'sk', 'sl',
  'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh',
];

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
  choices?: Array<{ message?: { content?: unknown } }>;
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
    const source = parsed.source;
    if (typeof source !== 'string' || !/^[a-z]{2,3}$/.test(source)) {
      throw new Error(`LLM returned invalid source: ${String(source)}`);
    }
    const map = parsed.translations;
    if (typeof map !== 'object' || map === null) throw new ProviderRefusedError('translations object missing');

    const translations: Translation[] = [];
    for (const lang of req.candidateLangs) {
      if (lang === source) continue;
      const text = (map as Record<string, unknown>)[lang];
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new ProviderRefusedError(`missing target ${lang}`);
      }
      translations.push({ lang, text: text.trim() });
    }
    return { detected: source, source, translations, provider: this.name };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.catalog && Date.now() < this.catalogExpires) return this.catalog;
    const data = (await this.request('/models', 'GET')) as { data?: Array<Record<string, unknown>> };
    const models = (data.data ?? []).filter(m => typeof m.id === 'string').map(toModelInfo);
    this.catalog = models;
    this.catalogExpires = Date.now() + this.catalogTtlMs;
    return models;
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
        this.logger.warn(`LLM circuit opened for ${this.cooldownMs}ms`, { action: 'llm_circuit_open', model: this.model });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function userPayload(req: TranslateRequest): Omit<TranslateRequest, 'allowExternal'> {
  const { allowExternal: _omit, ...rest } = req;
  void _omit;
  return rest;
}

/** Parse the model's JSON, tolerating fences/prose. Refusal prose throws ProviderRefusedError. */
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
    if (REFUSAL_RE.test(content)) throw new ProviderRefusedError(`refusal: ${content.slice(0, 80)}`);
    throw new Error('LLM returned non-JSON content');
  }
  return parsed as { source: unknown; translations: unknown };
}

function toModelInfo(m: Record<string, unknown>): ModelInfo {
  const info: ModelInfo = { id: m.id as string };
  if (typeof m.prompt_text_token_price === 'number') info.inputPerMTok = m.prompt_text_token_price / XAI_PRICE_DIVISOR;
  if (typeof m.completion_text_token_price === 'number') info.outputPerMTok = m.completion_text_token_price / XAI_PRICE_DIVISOR;
  return info;
}
```

Note: `listModels` is included here because it shares `request()`; Task 7 only adds its tests and the cache behaviour check.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts`
Expected: 14 passed. If the timeout test hangs, the fake fetch is not honouring `signal`; fix the test, not the client.

- [ ] **Step 5: Lint, then commit**

Run: `npm run lint && npm run format -- --check` (run `npm run format` if needed).

```bash
git add src/plugins/extensions/translation/llm-openai-compatible.client.ts src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts
git commit -m "feat(translation): OpenAI-compatible LLM translator adapter (Grok default)"
```

**Review focus (Fable):** every system-prompt bullet from spec §7 is present; refusals bypass the breaker; `allowExternal` never leaves the process.

---

### Task 7: OpenAiCompatibleClient, model catalog

**Intent:** Prove `listModels()` handles both the plain OpenAI shape and xAI's priced shape, caches, and that `setModel` changes the next request. Spec §7 "Model switching".

**Files:**
- Modify: `src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts` (append tests)
- Modify only if a test fails: `src/plugins/extensions/translation/llm-openai-compatible.client.ts`

- [ ] **Step 1: Append the tests**

Add inside the existing `describe('OpenAiCompatibleClient', ...)` block:

```ts
  it('listModels() parses the OpenAI shape without prices', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ object: 'list', data: [{ id: 'gpt-x', object: 'model' }] }),
    }) as never;
    const c = client({ baseUrl: 'https://api.openai.com/v1' });
    expect(await c.listModels()).toEqual([{ id: 'gpt-x' }]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('listModels() converts xAI price fields to USD per 1M tokens', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ id: 'grok-4.3', prompt_text_token_price: 12500, completion_text_token_price: 25000 }],
        }),
    }) as never;
    expect(await client().listModels()).toEqual([{ id: 'grok-4.3', inputPerMTok: 1.25, outputPerMTok: 2.5 }]);
  });

  it('listModels() caches the catalog', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: 'a' }] }) }) as never;
    const c = client();
    await c.listModels();
    await c.listModels();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('setModel() changes the model on the next request', async () => {
    const fetchMock = jest.fn().mockResolvedValue(completion('{"source":"es","translations":{"en":"hi","ru":"x"}}'));
    global.fetch = fetchMock as never;
    const c = client();
    c.setModel('grok-4.6');
    await c.translateAll(req());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe('grok-4.6');
    expect(c.currentModel()).toBe('grok-4.6');
  });
```

- [ ] **Step 2: Run and watch**

Run: `npm test -- src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts`
Expected: 18 passed. These should pass against the Task 6 implementation; if any fails, fix the client to match the test, not the reverse.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts src/plugins/extensions/translation/llm-openai-compatible.client.ts
git commit -m "test(translation): model catalog parsing, pricing conversion, cache, setModel"
```

---

### Task 8: Command parser and reply formatter

**Intent:** Teach the parser the `privacy` and `model` verbs, and give the formatter every new piece of text: disclosure, health notices, model list, privacy summary, and the richer status. Spec §10, §11, §11a.

**Files:**
- Modify: `src/plugins/extensions/translation/core/command.parser.ts`
- Modify: `src/plugins/extensions/translation/core/reply.formatter.ts`
- Modify: `src/plugins/extensions/translation/core/command.parser.spec.ts` (append)
- Modify: `src/plugins/extensions/translation/core/reply.formatter.spec.ts` (append + one edit)

**Interfaces:**
- Produces (formatter): `buildDisclosureText(prefix)`, `formatHealthNotice(p: ProviderHealth)`, `formatModelList(models: ModelInfo[], active: string)`, `formatPrivacy(p: EffectivePrivacy, prefix)`, and **changed signature** `formatStatus(state, health: ProviderHealth[], privacy: EffectivePrivacy, activeModel?: string)`.

- [ ] **Step 1: Append parser tests**

Add to `command.parser.spec.ts` inside the existing `describe`:

```ts
  it('parses privacy with and without a mode', () => {
    expect(parseCommand('/tr privacy', '/tr')).toEqual({ name: 'privacy' });
    expect(parseCommand('/tr privacy local', '/tr')).toEqual({ name: 'privacy', privacy: 'local' });
    expect(parseCommand('/tr privacy CLOUD', '/tr')).toEqual({ name: 'privacy', privacy: 'cloud' });
    expect(parseCommand('/tr privacy bogus', '/tr')).toEqual({ name: 'privacy' });
  });

  it('parses model show/list/switch', () => {
    expect(parseCommand('/tr model', '/tr')).toEqual({ name: 'model', modelAction: 'show' });
    expect(parseCommand('/tr model list', '/tr')).toEqual({ name: 'model', modelAction: 'list' });
    expect(parseCommand('/tr model switch grok-4.6', '/tr')).toEqual({ name: 'model', modelAction: 'switch', modelId: 'grok-4.6' });
    expect(parseCommand('/tr model switch', '/tr')).toEqual({ name: 'model', modelAction: 'switch' });
    expect(parseCommand('/tr model nonsense', '/tr')).toEqual({ name: 'model', modelAction: 'show' });
  });
```

- [ ] **Step 2: Run parser spec and watch the new tests fail**

Run: `npm test -- src/plugins/extensions/translation/core/command.parser.spec.ts`
Expected: 2 new failures (`privacy`/`model` are unknown verbs and return null).

- [ ] **Step 3: Implement parser changes**

In `command.parser.ts`: add `'privacy'` and `'model'` to the `COMMANDS` set, import `PrivacyMode` and `ModelAction` from `./ports`, and insert before the `if (NEEDS_TARGET.has(name))` line:

```ts
  if (name === 'privacy') {
    const mode = args[0]?.toLowerCase();
    return mode === 'cloud' || mode === 'local' ? { name, privacy: mode as PrivacyMode } : { name };
  }

  if (name === 'model') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'list') return { name, modelAction: 'list' as ModelAction };
    if (sub === 'switch') {
      const modelId = args[1]; // case-sensitive: model ids are exact
      return modelId ? { name, modelAction: 'switch' as ModelAction, modelId } : { name, modelAction: 'switch' as ModelAction };
    }
    return { name, modelAction: 'show' as ModelAction };
  }
```

- [ ] **Step 4: Run parser spec and watch it pass**

Run: `npm test -- src/plugins/extensions/translation/core/command.parser.spec.ts`
Expected: all pass.

- [ ] **Step 5: Update and append formatter tests**

In `reply.formatter.spec.ts`, replace the existing `formatStatus` test with this one, and append the others. Update the import line to:

```ts
import { formatCombinedReply, buildHelpText, formatStatus, buildDisclosureText, formatHealthNotice, formatModelList, formatPrivacy } from './reply.formatter';
import { GroupState } from './ports';
```

```ts
  it('formatStatus reports active state, providers, privacy, model, and participants', () => {
    const state: GroupState = {
      sessionId: 's',
      chatId: 'c@g.us',
      active: true,
      participants: { '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' } },
      delegatedControllers: [],
      announced: true,
    };
    const out = formatStatus(
      state,
      [
        { name: 'llm', external: true, healthy: false },
        { name: 'libretranslate', external: false, healthy: true },
      ],
      { mode: 'cloud', source: 'instance' },
      'grok-4.3',
    );
    expect(out).toMatch(/active/i);
    expect(out).toContain('AI translator (grok-4.3): degraded');
    expect(out).toContain('Basic translator (libretranslate): ok');
    expect(out).toContain('Privacy: cloud (instance default)');
    expect(out).toContain('en');
  });

  it('formatStatus shows the AI translator as disabled when absent and off (privacy) in a local group', () => {
    const state: GroupState = { sessionId: 's', chatId: 'c', active: true, participants: {}, delegatedControllers: [], announced: true };
    const absent = formatStatus(state, [{ name: 'libretranslate', external: false, healthy: true }], { mode: 'cloud', source: 'instance' });
    expect(absent).toContain('AI translator: disabled');
    const local = formatStatus(
      state,
      [{ name: 'llm', external: true, healthy: true }, { name: 'libretranslate', external: false, healthy: false }],
      { mode: 'local', source: 'group' },
      'm',
    );
    expect(local).toContain('AI translator (m): off (privacy)');
    expect(local).toContain('Basic translator (libretranslate): unreachable');
    expect(local).toContain('Privacy: local (group override)');
  });

  it('buildHelpText mentions privacy and model commands', () => {
    const out = buildHelpText('/tr');
    expect(out).toContain('/tr privacy');
    expect(out).toContain('/tr model');
  });

  it('buildDisclosureText names the external provider and the opt-out command', () => {
    const out = buildDisclosureText('/tr');
    expect(out).toMatch(/external AI/i);
    expect(out).toContain('/tr privacy local');
  });

  it('formatHealthNotice distinguishes provider and direction', () => {
    expect(formatHealthNotice({ name: 'llm', external: true, healthy: false })).toBe(
      '⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.',
    );
    expect(formatHealthNotice({ name: 'llm', external: true, healthy: true })).toBe('✅ AI translation is back.');
    expect(formatHealthNotice({ name: 'libretranslate', external: false, healthy: false })).toBe('⚠️ Basic translation is temporarily unavailable.');
    expect(formatHealthNotice({ name: 'libretranslate', external: false, healthy: true })).toBe('✅ Basic translation is back.');
  });

  it('formatModelList marks the active model, shows prices, and truncates at 30', () => {
    const models = Array.from({ length: 32 }, (_, i) => ({ id: `m${i}`, inputPerMTok: 1.25, outputPerMTok: 2.5 }));
    const out = formatModelList(models, 'm1');
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/models/i);
    expect(out).toContain('▶ m1 — in $1.25 / out $2.50 per 1M tok');
    expect(out).toContain('• m0 — in $1.25 / out $2.50 per 1M tok');
    expect(out).toContain('(+2 more)');
    expect(formatModelList([{ id: 'plain' }], 'x')).toContain('• plain');
  });

  it('formatPrivacy explains the effective mode', () => {
    expect(formatPrivacy({ mode: 'local', source: 'group' }, '/tr')).toContain('local (group override)');
    expect(formatPrivacy({ mode: 'cloud', source: 'instance' }, '/tr')).toContain('cloud (instance default)');
  });
```

- [ ] **Step 6: Run formatter spec and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/reply.formatter.spec.ts`
Expected: FAIL on missing exports / wrong `formatStatus` signature.

- [ ] **Step 7: Implement formatter changes**

Replace the imports and `buildHelpText` / `formatStatus` in `reply.formatter.ts` and add the new functions:

```ts
import { Translation, GroupState, ProviderHealth, EffectivePrivacy, ModelInfo } from './ports';
```

```ts
export function buildHelpText(prefix: string): string {
  return [
    '👋 Translation bot. I am OFF in this group until an admin runs `' + prefix + ' on`.',
    'Commands:',
    `${prefix} on / ${prefix} off — enable/disable translation here`,
    `${prefix} setlang <code> [me|@user|number] — pin a language (default: you)`,
    `${prefix} auto [me|@user|number] — go back to auto-detect`,
    `${prefix} ignore <@user|number> / ${prefix} unignore <@user|number>`,
    `${prefix} grant <@user|number> / ${prefix} revoke <@user|number> — delegate control (admins)`,
    `${prefix} privacy [cloud|local] — show or set whether an external AI service may translate here`,
    `${prefix} model [list|switch <id>] — operator only: view or change the AI model`,
    `${prefix} status — show settings`,
    `${prefix} help — this message`,
  ].join('\n');
}

export function buildDisclosureText(prefix: string): string {
  return (
    'ℹ️ Translations in this group are produced by an external AI service; message text is sent to that provider for translation. ' +
    `An admin can switch to local-only translation with \`${prefix} privacy local\`.`
  );
}

function providerLabel(p: ProviderHealth): string {
  return p.name === 'llm' ? 'AI translation' : 'Basic translation';
}

export function formatHealthNotice(p: ProviderHealth): string {
  const label = providerLabel(p);
  if (p.healthy) return `✅ ${label} is back.`;
  return p.name === 'llm'
    ? `⚠️ ${label} is temporarily unavailable; using basic translation until it recovers.`
    : `⚠️ ${label} is temporarily unavailable.`;
}

export function formatPrivacy(p: EffectivePrivacy, prefix: string): string {
  const where = p.source === 'group' ? 'group override' : 'instance default';
  return [
    `Privacy: ${p.mode} (${where})`,
    p.mode === 'cloud'
      ? `Messages are sent to an external AI service for translation. Switch with \`${prefix} privacy local\`.`
      : `Only the local translator is used here. Switch with \`${prefix} privacy cloud\`.`,
  ].join('\n');
}

const MODEL_LIST_MAX = 30;

export function formatModelList(models: ModelInfo[], active: string): string {
  const lines = [`Available models (${models.length}):`];
  for (const m of models.slice(0, MODEL_LIST_MAX)) {
    const mark = m.id === active ? '▶' : '•';
    const price =
      m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
        ? ` — in $${m.inputPerMTok.toFixed(2)} / out $${m.outputPerMTok.toFixed(2)} per 1M tok`
        : '';
    lines.push(`${mark} ${m.id}${price}`);
  }
  if (models.length > MODEL_LIST_MAX) lines.push(`(+${models.length - MODEL_LIST_MAX} more)`);
  return lines.join('\n');
}

export function formatStatus(
  state: GroupState,
  health: ProviderHealth[],
  privacy: EffectivePrivacy,
  activeModel?: string,
): string {
  const lines: string[] = [];
  lines.push(`Translation: ${state.active ? 'ACTIVE' : 'inactive'}`);

  const llm = health.find(h => h.name === 'llm');
  if (!llm) {
    lines.push('AI translator: disabled');
  } else {
    const status = privacy.mode === 'local' ? 'off (privacy)' : llm.healthy ? 'ok' : 'degraded';
    lines.push(`AI translator (${activeModel ?? 'unknown'}): ${status}`);
  }
  for (const h of health.filter(x => x.name !== 'llm')) {
    lines.push(`Basic translator (${h.name}): ${h.healthy ? 'ok' : 'unreachable'}`);
  }
  lines.push(`Privacy: ${privacy.mode} (${privacy.source === 'group' ? 'group override' : 'instance default'})`);

  const entries = Object.entries(state.participants);
  if (entries.length === 0) {
    lines.push('No participants learned yet.');
  } else {
    lines.push('Participants:');
    for (const [wid, p] of entries) {
      const lang = p.lang ?? 'unknown';
      const flags = `${p.source}${p.enabled ? '' : ', ignored'}`;
      lines.push(`• ${wid}: ${lang} (${flags})`);
    }
  }
  if (state.delegatedControllers.length > 0) {
    lines.push(`Delegated controllers: ${state.delegatedControllers.join(', ')}`);
  }
  return lines.join('\n');
}
```

Keep `formatCombinedReply`, `FLAGS`, and `label` unchanged.

- [ ] **Step 8: Run both specs, then the whole translation suite**

Run: `npm test -- src/plugins/extensions/translation/core`
Expected: parser and formatter pass. **The coordinator spec will now fail to compile** because `formatStatus`'s signature changed. That is expected and is fixed in Task 9. Confirm the only failing suite is `translation.coordinator.spec.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/plugins/extensions/translation/core/command.parser.ts src/plugins/extensions/translation/core/command.parser.spec.ts src/plugins/extensions/translation/core/reply.formatter.ts src/plugins/extensions/translation/core/reply.formatter.spec.ts
git commit -m "feat(translation): parse privacy/model commands; disclosure, notice, model-list and richer status text"
```

**Review focus (Fable):** wording matches spec §10/§11; no behaviour change to `formatCombinedReply`.

---

### Task 9: Coordinator on the new port, with context

**Intent:** The heart of the change. Replace detect-then-fan-out with one `translateAll` call, feed and maintain the context buffer, and keep every existing group-facing behaviour identical. Spec §6, §9.

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-4, 8.
- Produces (constructor, keep positional for compatibility):

```ts
export interface CoordinatorOptions {
  prefix: string;
  minLength: number;
  maxLength: number;
  denyReply: boolean;
  defaultPrivacy?: PrivacyMode; // default 'cloud'
  operatorWids?: string[]; // default []
}
export interface CoordinatorExtras {
  context?: ConversationContext; // default: new ConversationContext({ maxTurns: 10, maxChars: 2000 })
  models?: ModelSwitchable; // undefined => /tr model replies "not configured"
  modelStore?: ModelStore;
  providerHealth?: () => ProviderHealth[]; // default: () => [{ name: translator.name, external: translator.external, healthy: translator.isHealthy() }]
}
constructor(translator: ContextualTranslator, store, gateway, opts, logger?, extras?: CoordinatorExtras)
```

- [ ] **Step 1: Migrate the test fixture**

In `translation.coordinator.spec.ts`:

1. Change the imports to:

```ts
import { TranslationCoordinator, CoordinatorOptions, CoordinatorExtras } from './translation.coordinator';
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator, TranslationLogger, ContextualTranslator } from './ports';
import { LibreTranslateContextual } from './libretranslate.contextual';
import { ConversationContext } from './conversation-context';
```

2. In `makeDeps`, after `const translator: Translator = { detect, translate, languages, isHealthy };` add:

```ts
  const contextual: ContextualTranslator = new LibreTranslateContextual(translator, logger);
  const context = new ConversationContext({ maxTurns: 10, maxChars: 2000 });
  const extras: CoordinatorExtras = { context };
```

and change the returned object so `translator` is the **contextual** wrapper, and also return `context` and `extras`:

```ts
  return { store, gateway, translator: contextual, raw: translator, context, extras, logger, saved, mocks: { ... unchanged ... } };
```

(`logger` must be defined before `contextual`; move the `const logger` line up if needed.)

3. Every `new TranslationCoordinator(translator, store, gateway, OPTS)` call keeps working because `translator` is now the wrapper. Where a test passes `logger` as the fifth arg, keep it.

- [ ] **Step 2: Add the new tests (append inside the describe)**

```ts
  it('sends one contextual request with candidates, hint, glossary and prior history (excluding the current message)', async () => {
    const state = freshState({
      active: true,
      announced: true,
      participants: {
        '111@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: '', pushName: 'Ana' },
        '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: '', pushName: 'Doug' },
      },
    });
    const { store, gateway, context, extras, mocks } = makeDeps(state);
    const translateAll = jest.fn().mockResolvedValue({ detected: 'es', source: 'es', translations: [{ lang: 'en', text: 'hi' }], provider: 'llm' });
    const fake: ContextualTranslator = { name: 'llm', external: true, translateAll, languages: mocks.languages, isHealthy: () => true };
    context.append('s', 'g@g.us', { author: 'Doug', lang: 'en', text: 'earlier', at: 'x' });
    const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);

    await c.handleMessage('s', msg({ body: 'hola Doug', author: '111@c.us', pushName: 'Ana' }));

    expect(translateAll).toHaveBeenCalledTimes(1);
    const req = translateAll.mock.calls[0][0];
    expect(req).toMatchObject({
      text: 'hola Doug',
      senderName: 'Ana',
      hintLang: 'es',
      allowExternal: true,
    });
    expect(req.candidateLangs.sort()).toEqual(['en', 'es']);
    expect(req.glossary.sort()).toEqual(['Ana', 'Doug']);
    expect(req.history.map((t: { text: string }) => t.text)).toEqual(['earlier']);
    expect(mocks.sendCombinedReply).toHaveBeenCalledWith('s', 'g@g.us', 'M1', expect.stringContaining('hi'));
    // The current message is appended AFTER translating.
    expect(context.get('s', 'g@g.us').map(t => t.text)).toEqual(['earlier', 'hola Doug']);
    expect(context.get('s', 'g@g.us')[1]).toMatchObject({ author: 'Ana', lang: 'es' });
  });

  it('records an ignored participant message in context without translating it', async () => {
    const state = freshState({
      active: true,
      announced: true,
      participants: { '111@c.us': { lang: 'es', source: 'learned', enabled: false, samples: 2, updatedAt: '' } },
    });
    const { store, gateway, translator, context, extras, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: 'hola', author: '111@c.us' }));
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(context.get('s', 'g@g.us')).toEqual([expect.objectContaining({ text: 'hola', lang: 'es' })]);
  });

  it('still records the turn (lang und) when every provider fails, and stays silent', async () => {
    const state = freshState({ active: true, announced: true });
    const { store, gateway, translator, context, extras, mocks } = makeDeps(state);
    mocks.detect.mockRejectedValue(new Error('down'));
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: 'hola' }));
    expect(mocks.sendCombinedReply).not.toHaveBeenCalled();
    expect(context.get('s', 'g@g.us')).toEqual([expect.objectContaining({ text: 'hola', lang: 'und' })]);
  });

  it('clears the context on /tr off', async () => {
    const state = freshState({ active: true, announced: true });
    const { store, gateway, translator, context, extras, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
    context.append('s', 'g@g.us', { author: 'x', lang: 'en', text: 'old', at: 'x' });
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: '/tr off' }));
    expect(context.get('s', 'g@g.us')).toEqual([]);
  });

  it('filters provider translations down to the computed targets', async () => {
    // Sender speaks es, group knows en/es/ru; provider returns en+ru; sender's own language is excluded anyway.
    const state = freshState({
      active: true,
      announced: true,
      participants: {
        '111@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
        '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
        '333@c.us': { lang: 'ru', source: 'learned', enabled: false, samples: 2, updatedAt: '' },
      },
    });
    const { store, gateway, extras, mocks } = makeDeps(state);
    const translateAll = jest.fn().mockResolvedValue({
      detected: 'es', source: 'es', provider: 'llm',
      translations: [{ lang: 'en', text: 'hi' }, { lang: 'ru', text: 'privet' }],
    });
    const fake: ContextualTranslator = { name: 'llm', external: true, translateAll, languages: mocks.languages, isHealthy: () => true };
    const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: 'hola', author: '111@c.us' }));
    const sent = mocks.sendCombinedReply.mock.calls[0][3] as string;
    expect(sent).toContain('hi');
    expect(sent).not.toContain('privet'); // ru participant is ignored => not a target
  });
```

- [ ] **Step 3: Run the coordinator spec and watch it fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts`
Expected: compile failure (constructor/port mismatch, `formatStatus` signature).

- [ ] **Step 4: Implement the coordinator changes**

In `translation.coordinator.ts`:

1. Replace the imports block with:

```ts
import {
  ChatGateway,
  ConfigStore,
  GroupState,
  InboundMessage,
  ParsedCommand,
  ParticipantState,
  TranslationLogger,
  CommandTarget,
  ContextualTranslator,
  TranslateRequest,
  TranslateResult,
  PrivacyMode,
  EffectivePrivacy,
  ModelSwitchable,
  ModelStore,
  ProviderHealth,
} from './ports';
import { parseCommand } from './command.parser';
import { buildHelpText, formatCombinedReply, formatStatus } from './reply.formatter';
import { ConversationContext } from './conversation-context';
```

2. Replace `CoordinatorOptions` and add `CoordinatorExtras`:

```ts
export interface CoordinatorOptions {
  prefix: string;
  minLength: number;
  maxLength: number;
  denyReply: boolean;
  /** Instance default when a group has no override (spec D7). */
  defaultPrivacy?: PrivacyMode;
  /** WhatsApp IDs allowed to run `/tr model *` (spec D11). */
  operatorWids?: string[];
}

export interface CoordinatorExtras {
  context?: ConversationContext;
  models?: ModelSwitchable;
  modelStore?: ModelStore;
  providerHealth?: () => ProviderHealth[];
}
```

3. Replace the constructor:

```ts
  private readonly context: ConversationContext;
  private readonly extras: CoordinatorExtras;

  constructor(
    private readonly translator: ContextualTranslator,
    private readonly store: ConfigStore,
    private readonly gateway: ChatGateway,
    private readonly opts: CoordinatorOptions,
    private readonly logger: TranslationLogger = NOOP_LOGGER,
    extras: CoordinatorExtras = {},
  ) {
    this.extras = extras;
    this.context = extras.context ?? new ConversationContext({ maxTurns: 10, maxChars: 2000 });
  }
```

4. Replace `translateMessage` entirely:

```ts
  private async translateMessage(sessionId: string, msg: InboundMessage, state: GroupState): Promise<void> {
    const text = msg.body.trim();
    if (text.length < this.opts.minLength || text.length > this.opts.maxLength || URL_OR_EMOJI_ONLY.test(text)) {
      return;
    }

    const senderKey = this.resolveSenderKey(state, msg);
    const sender = this.ensureParticipant(state, senderKey);
    // Record the pushName, but never overwrite a different existing value (a misrouted message
    // could otherwise poison the identity anchor).
    if (msg.pushName && (sender.pushName === undefined || sender.pushName === msg.pushName)) {
      sender.pushName = msg.pushName;
    }
    const authorName = msg.pushName ?? senderKey.split('@')[0];

    if (!sender.enabled) {
      // Ignored participants are still part of the conversation the LLM needs to follow (spec D10).
      this.remember(sessionId, msg.chatId, authorName, sender.lang ?? 'und', text);
      return;
    }

    const knownLangs = this.knownLanguages(state);
    const request: TranslateRequest = {
      text,
      senderName: authorName,
      candidateLangs: knownLangs,
      hintLang: sender.lang,
      glossary: this.glossary(state, msg.pushName),
      history: this.context.get(sessionId, msg.chatId),
      allowExternal: this.effectivePrivacy(state).mode === 'cloud',
    };

    let result: TranslateResult;
    try {
      result = await this.translator.translateAll(request);
    } catch (err) {
      // Every provider failed — silent skip, as before, but the turn still counts as context.
      this.logger.warn('translation failed on all providers', {
        action: 'translation_all_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      this.remember(sessionId, msg.chatId, authorName, sender.lang ?? 'und', text);
      await this.store.save(state);
      return;
    }

    this.applyLearning(sender, result.detected);

    // Pick the effective source language. Detection misfires on short/colloquial text — it often
    // returns a near-neighbour language (e.g. es misread as gl/ca) — so trust the detected code only
    // when it names a language the group actually uses; otherwise fall back to the sender's known
    // language. Combined with excluding the sender's own language from the targets below, this stops
    // a message ever being "translated" into its own language (the duplicate/echo bug).
    const source = knownLangs.includes(result.detected) ? result.detected : (sender.lang ?? result.detected);

    let targets = this.targetLanguages(state, source, sender.lang);
    if (targets.length === 0) {
      // Backstop: a real message detected in a known language must never be silently dropped due
      // to a sender/source mismatch (e.g. a misrouted @lid author keyed to the wrong participant).
      // Translate into every known language except the source — guarantees delivery.
      const backstop = knownLangs.filter(l => l !== source);
      if (backstop.length === 0) {
        this.logger.debug('no targets; group speaks only the source language', {
          action: 'translation_no_targets',
          source,
        });
        this.remember(sessionId, msg.chatId, authorName, source, text);
        await this.store.save(state);
        return;
      }
      this.logger.warn('target backstop engaged (possible misroute or cross-language write)', {
        action: 'translation_backstop',
        author: msg.author,
        pushName: msg.pushName,
        source,
        senderLang: sender.lang,
        targets: backstop,
      });
      targets = backstop;
    }

    const translations = result.translations.filter(t => targets.includes(t.lang));
    for (const t of targets) {
      if (!translations.some(x => x.lang === t)) {
        this.logger.warn('target missing from provider result', {
          action: 'translation_translate_failed',
          provider: result.provider,
          source,
          target: t,
        });
      }
    }

    this.remember(sessionId, msg.chatId, authorName, source, text);

    this.logger.debug('translate decision', {
      action: 'translation_decision',
      author: msg.author,
      resolvedKey: senderKey,
      pushName: msg.pushName,
      detected: result.detected,
      source,
      senderLang: sender.lang,
      knownLangs,
      targets,
      sent: translations.length,
      provider: result.provider,
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
  }

  private remember(sessionId: string, chatId: string, author: string, lang: string, text: string): void {
    this.context.append(sessionId, chatId, { author, lang, text, at: new Date().toISOString() });
  }

  private glossary(state: GroupState, current?: string): string[] {
    const names = Object.values(state.participants).map(p => p.pushName);
    names.push(current);
    return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))];
  }

  effectivePrivacy(state: GroupState): EffectivePrivacy {
    if (state.privacy) return { mode: state.privacy, source: 'group' };
    return { mode: this.opts.defaultPrivacy ?? 'cloud', source: 'instance' };
  }

  private providerHealth(): ProviderHealth[] {
    if (this.extras.providerHealth) return this.extras.providerHealth();
    return [{ name: this.translator.name, external: this.translator.external, healthy: this.translator.isHealthy() }];
  }
```

5. In `handleCommand`, change the `status` branch and the `off` case:

```ts
    if (cmd.name === 'status') {
      await this.gateway.sendText(
        sessionId,
        msg.chatId,
        formatStatus(state, this.providerHealth(), this.effectivePrivacy(state), this.extras.models?.currentModel()),
      );
      return;
    }
```

```ts
      case 'off':
        state.active = false;
        this.context.clear(sessionId, msg.chatId);
        await this.confirm(sessionId, msg, '✅ Translation deactivated.', state);
        return;
```

6. `privacy` and `model` now exist as `CommandName`s but have no handling yet; add temporary no-op cases at the bottom of the `switch` so TypeScript's exhaustiveness is satisfied. They are replaced in Tasks 10 and 12:

```ts
      case 'privacy':
      case 'model':
        return; // implemented in later tasks
```

- [ ] **Step 5: Run the coordinator spec**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts`
Expected: the 5 new tests pass. Of the 16 pre-existing tests, most pass unchanged. Any that fail will be ones asserting **how many times `mocks.translate` was called** or **which targets it was called with**: the wrapper now translates into every known language except the source and the coordinator filters afterwards, so an extra `translate` call into the sender's own language can appear when `source !== sender.lang`. For those tests only, update the call-count/argument expectation and add a one-line comment explaining why. **Never change an assertion about `sendCombinedReply` or `sendText` content**: what reaches the group must be identical to before. If a group-facing assertion fails, the implementation is wrong; fix it.

- [ ] **Step 6: Run the whole translation suite, lint, format**

Run: `npm test -- src/plugins/extensions/translation && npm run lint && npm run format -- --check`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): coordinator uses contextual translator port and conversation context"
```

**Review focus (Fable):** diff of `translateMessage` against the pre-change version shows only the intended deltas; learning still uses raw `detected`; every edited pre-existing test has a comment and touches only translate-call expectations.

---

### Task 10: Privacy command and disclosure

**Intent:** Let a group opt out of cloud processing, and disclose cloud use once. Spec §10.

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts` (append)

- [ ] **Step 1: Append tests**

```ts
  describe('privacy', () => {
    it('forces allowExternal=false when the group is local', async () => {
      const state = freshState({ active: true, announced: true, privacy: 'local' });
      const { store, gateway, extras, mocks } = makeDeps(state);
      const translateAll = jest.fn().mockResolvedValue({ detected: 'es', source: 'es', translations: [], provider: 'libretranslate' });
      const fake: ContextualTranslator = { name: 'chain', external: false, translateAll, languages: mocks.languages, isHealthy: () => true };
      const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);
      await c.handleMessage('s', msg({ body: 'hola' }));
      expect(translateAll.mock.calls[0][0].allowExternal).toBe(false);
    });

    it('uses the instance default when the group has no override', async () => {
      const state = freshState({ active: true, announced: true });
      const { store, gateway, extras, mocks } = makeDeps(state);
      const translateAll = jest.fn().mockResolvedValue({ detected: 'es', source: 'es', translations: [], provider: 'libretranslate' });
      const fake: ContextualTranslator = { name: 'chain', external: false, translateAll, languages: mocks.languages, isHealthy: () => true };
      const c = new TranslationCoordinator(fake, store, gateway, { ...OPTS, defaultPrivacy: 'local' }, undefined, extras);
      await c.handleMessage('s', msg({ body: 'hola' }));
      expect(translateAll.mock.calls[0][0].allowExternal).toBe(false);
    });

    it('/tr privacy is open to anyone and shows the effective mode', async () => {
      const state = freshState({ announced: true });
      const { store, gateway, translator, mocks } = makeDeps(state);
      const c = new TranslationCoordinator(translator, store, gateway, OPTS);
      await c.handleMessage('s', msg({ body: '/tr privacy' }));
      expect(mocks.getGroupAdmins).not.toHaveBeenCalled();
      expect(mocks.sendText).toHaveBeenCalledWith('s', 'g@g.us', expect.stringContaining('cloud (instance default)'));
    });

    it('/tr privacy local is admin-gated and persists the override', async () => {
      const state = freshState({ announced: true });
      const { store, gateway, translator, saved, mocks } = makeDeps(state);
      const c = new TranslationCoordinator(translator, store, gateway, OPTS);
      await c.handleMessage('s', msg({ body: '/tr privacy local' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringMatching(/⛔/));
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr privacy local' }));
      expect(saved[saved.length - 1].privacy).toBe('local');
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringContaining('local'));
    });

    it('discloses cloud use exactly once: on /tr on, not again on a later /tr on', async () => {
      const state = freshState({ announced: true });
      const { store, gateway, translator, saved, mocks } = makeDeps(state);
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      const c = new TranslationCoordinator(translator, store, gateway, OPTS);
      await c.handleMessage('s', msg({ body: '/tr on' }));
      const disclosures = () => mocks.sendText.mock.calls.filter(call => /external AI/i.test(call[2] as string));
      expect(disclosures()).toHaveLength(1);
      expect(saved[saved.length - 1].privacyDisclosed).toBe(true);
      await c.handleMessage('s', msg({ body: '/tr on' }));
      expect(disclosures()).toHaveLength(1);
    });

    it('does not disclose on /tr on in a local group, but does when switched to cloud', async () => {
      const state = freshState({ announced: true, privacy: 'local' });
      const { store, gateway, translator, mocks } = makeDeps(state);
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      const c = new TranslationCoordinator(translator, store, gateway, OPTS);
      const disclosures = () => mocks.sendText.mock.calls.filter(call => /external AI/i.test(call[2] as string));
      await c.handleMessage('s', msg({ body: '/tr on' }));
      expect(disclosures()).toHaveLength(0);
      await c.handleMessage('s', msg({ body: '/tr privacy cloud' }));
      expect(disclosures()).toHaveLength(1);
    });
  });
```

- [ ] **Step 2: Run and watch the new tests fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t privacy`
Expected: failures in the `/tr privacy` and disclosure tests.

- [ ] **Step 3: Implement**

In `translation.coordinator.ts`:

1. Import `buildDisclosureText` and `formatPrivacy` from `./reply.formatter`.

2. In `handleCommand`, right after the `status` branch and before the admin gate, add the open form:

```ts
    if (cmd.name === 'privacy' && !cmd.privacy) {
      await this.gateway.sendText(sessionId, msg.chatId, formatPrivacy(this.effectivePrivacy(state), this.opts.prefix));
      return;
    }
```

3. Replace the `on` case and the temporary `privacy` case:

```ts
      case 'on':
        state.active = true;
        await this.confirm(sessionId, msg, '✅ Translation activated.', state);
        await this.discloseIfNeeded(sessionId, state);
        return;
```

```ts
      case 'privacy': {
        state.privacy = cmd.privacy; // non-undefined here: the show form returned earlier
        await this.confirm(sessionId, msg, `✅ Privacy set to ${cmd.privacy} for this group.`, state);
        await this.discloseIfNeeded(sessionId, state);
        return;
      }
```

4. Add the helper:

```ts
  /** Post the cloud disclosure once per group, only when cloud translation is in effect (spec §10). */
  private async discloseIfNeeded(sessionId: string, state: GroupState): Promise<void> {
    if (state.privacyDisclosed || this.effectivePrivacy(state).mode !== 'cloud') return;
    state.privacyDisclosed = true;
    await this.store.save(state);
    await this.gateway.sendText(sessionId, state.chatId, buildDisclosureText(this.opts.prefix));
  }
```

- [ ] **Step 4: Run and watch it pass; full suite; lint**

Run: `npm test -- src/plugins/extensions/translation && npm run lint && npm run format -- --check`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): per-group privacy mode with one-time cloud disclosure"
```

**Review focus (Fable):** disclosure fires in exactly the two places in spec §10; show form bypasses the admin gate; set form does not.

---

### Task 11: Degraded and recovered notices

**Intent:** Tell each active group once when the AI translator drops or returns, lazily on that group's next message, never on every reply. Spec §11.

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts` (append)

- [ ] **Step 1: Append tests**

```ts
  describe('health notices', () => {
    function healthDeps(state: GroupState) {
      const deps = makeDeps(state);
      const health = { llm: true, lt: true };
      const providerHealth = () => [
        { name: 'llm', external: true, healthy: health.llm },
        { name: 'libretranslate', external: false, healthy: health.lt },
      ];
      const translateAll = jest.fn().mockResolvedValue({ detected: 'es', source: 'es', translations: [{ lang: 'en', text: 'hi' }], provider: 'llm' });
      const fake: ContextualTranslator = { name: 'chain', external: false, translateAll, languages: deps.mocks.languages, isHealthy: () => true };
      const c = new TranslationCoordinator(fake, deps.store, deps.gateway, OPTS, undefined, { ...deps.extras, providerHealth });
      const notices = () => deps.mocks.sendText.mock.calls.map(call => call[2] as string).filter(t => /AI translation/.test(t));
      return { c, health, notices, mocks: deps.mocks };
    }
    const active = () =>
      freshState({
        active: true,
        announced: true,
        participants: {
          '111@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
          '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
        },
      });

    it('posts one degraded notice per transition, after the reply, and one recovery notice', async () => {
      const { c, health, notices, mocks } = healthDeps(active());
      await c.handleMessage('s', msg({ body: 'hola' })); // baseline, no notice
      expect(notices()).toEqual([]);
      health.llm = false;
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(notices()).toEqual(['⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.']);
      const replyOrder = mocks.sendCombinedReply.mock.invocationCallOrder[1];
      const noticeOrder = mocks.sendText.mock.invocationCallOrder[mocks.sendText.mock.calls.length - 1];
      expect(replyOrder).toBeLessThan(noticeOrder);
      await c.handleMessage('s', msg({ body: 'hola tres' }));
      expect(notices()).toHaveLength(1);
      health.llm = true;
      await c.handleMessage('s', msg({ body: 'hola cuatro' }));
      expect(notices()).toEqual([
        '⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.',
        '✅ AI translation is back.',
      ]);
    });

    it('never mentions the external provider in a local-only group', async () => {
      const { c, health, notices } = healthDeps({ ...active(), privacy: 'local' });
      await c.handleMessage('s', msg({ body: 'hola' }));
      health.llm = false;
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(notices()).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run and watch the new tests fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "health notices"`
Expected: FAIL (no notices are sent yet).

- [ ] **Step 3: Implement**

In `translation.coordinator.ts`:

1. Import `formatHealthNotice` from `./reply.formatter`.

2. Add a field:

```ts
  /** Per group: the provider health we last told that group about (spec §11). Not persisted. */
  private readonly notifiedHealth = new Map<string, Map<string, boolean>>();
```

3. In `translateMessage`, after the `sendCombinedReply` block and before the final `await this.store.save(state);`, add:

```ts
    await this.maybeNotifyHealth(sessionId, state);
```

4. Add the helper:

```ts
  private async maybeNotifyHealth(sessionId: string, state: GroupState): Promise<void> {
    const key = `${sessionId}:${state.chatId}`;
    const current = this.providerHealth();
    const known = this.notifiedHealth.get(key);
    if (!known) {
      // First sighting of this group since boot: record a baseline, say nothing.
      this.notifiedHealth.set(key, new Map(current.map(p => [p.name, p.healthy])));
      return;
    }
    const privacy = this.effectivePrivacy(state);
    for (const p of current) {
      if (known.get(p.name) === p.healthy) continue;
      known.set(p.name, p.healthy);
      if (p.external && privacy.mode === 'local') continue;
      await this.gateway.sendText(sessionId, state.chatId, formatHealthNotice(p));
    }
  }
```

- [ ] **Step 4: Run; full suite; lint**

Run: `npm test -- src/plugins/extensions/translation && npm run lint && npm run format -- --check`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): one-time degraded/recovered provider notices per group"
```

**Review focus (Fable):** baseline-without-notice on first sighting; notice after the reply; local groups never hear about the external provider.

---

### Task 12: Model commands with operator allow-list

**Intent:** Let Doug switch models from chat, safely. Spec §11a.

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts` (append)

- [ ] **Step 1: Append tests**

```ts
  describe('model commands', () => {
    function modelDeps(operatorWids: string[]) {
      const deps = makeDeps(freshState({ announced: true }));
      let model = 'grok-a';
      const catalog = [
        { id: 'grok-a', inputPerMTok: 1.25, outputPerMTok: 2.5 },
        { id: 'grok-b', inputPerMTok: 2, outputPerMTok: 6 },
      ];
      const listModels = jest.fn().mockResolvedValue(catalog);
      const models = { listModels, currentModel: () => model, setModel: (id: string) => void (model = id) };
      const save = jest.fn().mockResolvedValue(undefined);
      const modelStore = { load: jest.fn().mockResolvedValue(null), save };
      const c = new TranslationCoordinator(deps.translator, deps.store, deps.gateway, { ...OPTS, operatorWids }, undefined, {
        ...deps.extras,
        models,
        modelStore,
      });
      return { c, mocks: deps.mocks, listModels, save, current: () => model };
    }

    it('denies non-operators, even group admins', async () => {
      const { c, mocks } = modelDeps(['999@c.us']);
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model list' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', '⛔ Only the instance operator can use that command.');
    });

    it('shows the active model for an operator (device-suffixed author tolerated)', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model', author: '111:7@c.us' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringContaining('grok-a'));
    });

    it('lists models with prices and the active marker', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model list' }));
      const out = mocks.sendText.mock.calls[mocks.sendText.mock.calls.length - 1][2] as string;
      expect(out).toContain('▶ grok-a — in $1.25 / out $2.50 per 1M tok');
      expect(out).toContain('• grok-b — in $2.00 / out $6.00 per 1M tok');
    });

    it('switches to a known model and persists it', async () => {
      const { c, mocks, save, current } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model switch grok-b' }));
      expect(current()).toBe('grok-b');
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ model: 'grok-b', updatedBy: '111@c.us' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', '✅ Model switched to grok-b.');
    });

    it('rejects an unknown model with suggestions and does not switch', async () => {
      const { c, mocks, save, current } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model switch grok' }));
      expect(current()).toBe('grok-a');
      expect(save).not.toHaveBeenCalled();
      const out = mocks.sendText.mock.calls[mocks.sendText.mock.calls.length - 1][2] as string;
      expect(out).toMatch(/Unknown model "grok"/);
      expect(out).toContain('grok-a');
      expect(out).toContain('grok-b');
    });

    it('switches unverified when the catalog is unavailable', async () => {
      const { c, mocks, listModels, current } = modelDeps(['111@c.us']);
      listModels.mockRejectedValue(new Error('HTTP 500'));
      await c.handleMessage('s', msg({ body: '/tr model switch anything' }));
      expect(current()).toBe('anything');
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringMatching(/unverified/));
    });

    it('replies usage when switch has no id', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model switch' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringContaining('Usage: /tr model switch <id>'));
    });

    it('reports not configured when there is no switchable provider', async () => {
      const deps = makeDeps(freshState({ announced: true }));
      const c = new TranslationCoordinator(deps.translator, deps.store, deps.gateway, { ...OPTS, operatorWids: ['111@c.us'] });
      await c.handleMessage('s', msg({ body: '/tr model' }));
      expect(deps.mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', 'AI translator is not configured on this instance.');
    });
  });
```

- [ ] **Step 2: Run and watch the new tests fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "model commands"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `translation.coordinator.ts`:

1. Import `formatModelList` from `./reply.formatter`.

2. In `handleCommand`, right after the open `privacy` form and **before** the admin gate, add:

```ts
    if (cmd.name === 'model') {
      const isOperator = (this.opts.operatorWids ?? []).some(w => widEquals(w, msg.author));
      if (!isOperator) {
        await this.gateway.sendText(sessionId, msg.chatId, '⛔ Only the instance operator can use that command.');
        return;
      }
      await this.handleModelCommand(sessionId, msg, cmd);
      return;
    }
```

3. Delete the temporary `case 'model': return;` from the switch.

4. Add the handler:

```ts
  private async handleModelCommand(sessionId: string, msg: InboundMessage, cmd: ParsedCommand): Promise<void> {
    const models = this.extras.models;
    if (!models) {
      await this.gateway.sendText(sessionId, msg.chatId, 'AI translator is not configured on this instance.');
      return;
    }
    const action = cmd.modelAction ?? 'show';

    if (action === 'show') {
      await this.gateway.sendText(sessionId, msg.chatId, `🤖 Active model: ${models.currentModel()}`);
      return;
    }

    if (action === 'list') {
      try {
        const catalog = await models.listModels();
        await this.gateway.sendText(sessionId, msg.chatId, formatModelList(catalog, models.currentModel()));
      } catch (err) {
        this.logger.warn('model catalog unavailable', { action: 'translation_model_catalog_failed', error: String(err) });
        await this.replyError(sessionId, msg, '⚠️ Model catalog unavailable right now.');
      }
      return;
    }

    // switch
    const id = cmd.modelId;
    if (!id) return this.replyError(sessionId, msg, `Usage: ${this.opts.prefix} model switch <id>`);

    let catalog: string[] | null = null;
    try {
      catalog = (await models.listModels()).map(m => m.id);
    } catch (err) {
      this.logger.warn('model catalog unavailable; switching unverified', {
        action: 'translation_model_catalog_failed',
        error: String(err),
      });
    }
    if (catalog && !catalog.includes(id)) {
      const near = catalog.filter(m => m.includes(id) || id.includes(m)).slice(0, 5);
      const hint = near.length > 0 ? `Did you mean: ${near.join(', ')}` : `Use ${this.opts.prefix} model list.`;
      return this.replyError(sessionId, msg, `⚠️ Unknown model "${id}". ${hint}`);
    }

    models.setModel(id);
    await this.extras.modelStore?.save({ model: id, updatedAt: new Date().toISOString(), updatedBy: msg.author });
    this.logger.info('model switched', { action: 'translation_model_switched', model: id, by: msg.author, verified: catalog !== null });
    await this.gateway.sendText(
      sessionId,
      msg.chatId,
      catalog ? `✅ Model switched to ${id}.` : `✅ Model switched to ${id} (catalog unavailable, switched unverified).`,
    );
  }
```

- [ ] **Step 4: Run; full suite; lint**

Run: `npm test -- src/plugins/extensions/translation && npm run lint && npm run format -- --check`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): /tr model list|switch gated by operator allow-list, persisted"
```

**Review focus (Fable):** the operator gate sits **before** the admin gate; `widEquals` is used; the switch persists via the store; unknown ids never switch.

---

### Task 13: Plugin wiring and config schema

**Intent:** Compose everything in `index.ts` from plugin config, keep the VM safe by default (`llmEnabled=false`), and expose the new keys to the dashboard. Spec §4 composition, §12.

**Files:**
- Modify: `src/plugins/extensions/translation/index.ts`
- Modify: `src/plugins/extensions/extensions.module.ts`

There is no unit test for `index.ts` today (it is glue over the plugin context); the acceptance test is the compiler, the full suite, and Task 14's live smoke.

- [ ] **Step 1: Rewrite `buildCoordinator` and the lifecycle hooks in `index.ts`**

Replace the imports:

```ts
import { PluginContext, IPlugin } from '../../../core/plugins';
import { HookContext, HookResult } from '../../../core/hooks';
import { IncomingMessage } from '../../../engine/interfaces/whatsapp-engine.interface';
import { TranslationCoordinator, CoordinatorOptions } from './core/translation.coordinator';
import { ContextualTranslator, InboundMessage, PrivacyMode, TranslationLogger } from './core/ports';
import { LibreTranslateClient } from './libretranslate.client';
import { LibreTranslateContextual } from './core/libretranslate.contextual';
import { FallbackChain } from './core/fallback-chain';
import { ConversationContext } from './core/conversation-context';
import { OpenAiCompatibleClient, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from './llm-openai-compatible.client';
import { PluginChatGateway } from './plugin-chat.gateway';
import { PluginConfigStore } from './plugin-config.store';
import { PluginModelStore } from './plugin-model.store';
```

Add two readers next to the existing ones:

```ts
function readStringList(cfg: Record<string, unknown>, key: string): string[] {
  const v = cfg[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
  return [];
}
function readPrivacy(cfg: Record<string, unknown>, key: string, fallback: PrivacyMode): PrivacyMode {
  const v = cfg[key];
  return v === 'cloud' || v === 'local' ? v : fallback;
}
```

Replace the class body's `onEnable`, `onConfigChange`, and `buildCoordinator`:

```ts
export class TranslationPlugin implements IPlugin {
  private coordinator: TranslationCoordinator | null = null;
  /** Kept across config rebuilds so a dashboard edit does not wipe every group's context. */
  private context: ConversationContext | null = null;

  async onEnable(context: PluginContext): Promise<void> {
    this.coordinator = await this.buildCoordinator(context);
    context.registerHook('message:received', ctx => this.onMessage(context, ctx as HookContext<IncomingMessage>));
    context.logger.log('Translation plugin enabled', { action: 'translation_enabled' });
  }

  async onConfigChange(context: PluginContext): Promise<void> {
    // Rebuild the coordinator so a config edit (e.g. a new LibreTranslate URL/key saved from the
    // dashboard) takes effect immediately, without a disable/enable cycle.
    this.coordinator = await this.buildCoordinator(context);
    context.logger.log('Translation plugin config updated', { action: 'translation_config_changed' });
  }

  private async buildCoordinator(context: PluginContext): Promise<TranslationCoordinator> {
    const cfg = context.config;
    const logger: TranslationLogger = {
      debug: (m, meta) => context.logger.debug(m, meta),
      info: (m, meta) => context.logger.log(m, meta),
      warn: (m, meta) => context.logger.warn(m, meta),
    };

    const libre = new LibreTranslateClient({
      url: readString(cfg, 'libretranslateUrl', 'http://localhost:7001'),
      apiKey: readOptionalString(cfg, 'libretranslateApiKey'),
      timeoutMs: readNumber(cfg, 'timeoutMs', 5000),
    });

    const modelStore = new PluginModelStore(context.storage);
    const providers: ContextualTranslator[] = [];
    let llm: OpenAiCompatibleClient | undefined;
    const llmApiKey = readOptionalString(cfg, 'llmApiKey');
    if (readBool(cfg, 'llmEnabled', false) && llmApiKey) {
      const persisted = await modelStore.load();
      llm = new OpenAiCompatibleClient({
        baseUrl: readString(cfg, 'llmBaseUrl', DEFAULT_LLM_BASE_URL),
        apiKey: llmApiKey,
        model: persisted?.model ?? readString(cfg, 'llmModel', DEFAULT_LLM_MODEL),
        timeoutMs: readNumber(cfg, 'llmTimeoutMs', 8000),
      });
      providers.push(llm);
      context.logger.log('LLM translator enabled', { action: 'translation_llm_enabled', model: llm.currentModel() });
    }
    providers.push(new LibreTranslateContextual(libre, logger));
    const chain = new FallbackChain(providers, logger);

    if (!this.context) {
      this.context = new ConversationContext({ maxTurns: readNumber(cfg, 'contextTurns', 10), maxChars: 2000 });
    }

    const store = new PluginConfigStore(context.storage);
    const gateway = new PluginChatGateway(context.messages, context.engine);
    const opts: CoordinatorOptions = {
      prefix: readString(cfg, 'commandPrefix', '/tr'),
      minLength: readNumber(cfg, 'minLength', 2),
      maxLength: readNumber(cfg, 'maxLength', 2000),
      denyReply: readBool(cfg, 'denyReply', false),
      defaultPrivacy: readPrivacy(cfg, 'defaultPrivacy', 'cloud'),
      operatorWids: readStringList(cfg, 'operatorWids'),
    };
    return new TranslationCoordinator(chain, store, gateway, opts, logger, {
      context: this.context,
      models: llm,
      modelStore,
      providerHealth: () => chain.providerHealth(),
    });
  }
```

Keep `onDisable` and `onMessage` as they are, but also set `this.context = null` in `onDisable`.

- [ ] **Step 2: Add config schema entries in `extensions.module.ts`**

Inside `configSchema.properties`, after `denyReply`, add:

```ts
          llmEnabled: {
            type: 'boolean',
            title: 'Enable AI translator',
            description: 'Use an OpenAI-compatible LLM (Grok by default) as the primary translator, with LibreTranslate as fallback.',
            default: false,
          },
          llmBaseUrl: {
            type: 'string',
            title: 'AI base URL',
            description: 'OpenAI-compatible API base, e.g. https://api.x.ai/v1 or an Ollama/LM Studio endpoint.',
            default: 'https://api.x.ai/v1',
          },
          llmApiKey: { type: 'string', title: 'AI API key', secret: true },
          llmModel: {
            type: 'string',
            title: 'AI model (initial)',
            description: 'Initial model id. An operator can change it at runtime with /tr model switch.',
            default: 'grok-4.20-0309-non-reasoning',
          },
          llmTimeoutMs: { type: 'number', title: 'AI timeout (ms)', default: 8000 },
          contextTurns: { type: 'number', title: 'Context turns sent to the AI', default: 10 },
          defaultPrivacy: {
            type: 'string',
            title: 'Default privacy mode',
            description: "'cloud' allows the AI translator by default; 'local' uses only LibreTranslate until a group opts in with /tr privacy cloud.",
            default: 'cloud',
          },
          operatorWids: {
            type: 'array',
            title: 'Operator WhatsApp IDs',
            description: 'IDs allowed to run /tr model commands (e.g. 1234567890@c.us). Comma-separated string also accepted.',
          },
```

Also update the manifest `description` to mention the AI provider:

```ts
      description:
        "Auto-translates group messages between participants' languages via an AI translator (Grok by default) with LibreTranslate fallback. Configure in-group with /tr commands. Disabled by default.",
```

- [ ] **Step 3: Compile, full test run, lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run lint && npm run format -- --check`
Expected: all green, including the global coverage thresholds.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/extensions/translation/index.ts src/plugins/extensions/extensions.module.ts
git commit -m "feat(translation): wire LLM provider chain, context, model store and new config keys"
```

**Review focus (Fable):** `llmEnabled=false` default really keeps behaviour identical to before (single LibreTranslate provider); the persisted model overrides `llmModel`; context survives `onConfigChange`.

---

### Task 14: Live smoke test against Grok

**Intent:** Prove the adapter works against the real provider with real context and a profane sample before anything is deployed. This is the only step that touches the network. Spec §14 "Manual".

**Files:**
- Create: `scripts/translation-llm-smoke.ts`

- [ ] **Step 1: Write the script**

```ts
// scripts/translation-llm-smoke.ts
// Manual live check of the LLM translator adapter. Never run in CI.
// Usage: XAI_API_KEY=$(cat ../Credentials/openwa-testkey | tr -d '[:space:]') npx ts-node --transpile-only scripts/translation-llm-smoke.ts
import { OpenAiCompatibleClient, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '../src/plugins/extensions/translation/llm-openai-compatible.client';

async function main(): Promise<void> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('Set XAI_API_KEY (read it from the credentials file; do not paste it into the shell history).');
    process.exit(1);
  }
  const client = new OpenAiCompatibleClient({
    baseUrl: process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    apiKey,
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    timeoutMs: 20000,
  });

  console.log('== models ==');
  for (const m of await client.listModels()) console.log(m);

  console.log('\n== translate with context (profanity + glossary name) ==');
  const now = new Date().toISOString();
  const res = await client.translateAll({
    text: 'Joder, qué puto calor hace hoy. Doug, ¿ya estás fuera?',
    senderName: 'Carlos',
    candidateLangs: ['en', 'es', 'ru'],
    hintLang: 'es',
    glossary: ['Doug', 'Carlos'],
    history: [
      { author: 'Doug', lang: 'en', text: 'Are you guys on the terrace already?', at: now },
      { author: 'Carlos', lang: 'es', text: 'Casi, bajando ahora', at: now },
    ],
    allowExternal: true,
  });
  console.log(JSON.stringify(res, null, 2));

  const en = res.translations.find(t => t.lang === 'en')?.text ?? '';
  const checks = {
    sourceIsEs: res.source === 'es',
    keepsName: en.includes('Doug'),
    keepsProfanity: /fuck|damn|hell|shit/i.test(en),
    hasRu: res.translations.some(t => t.lang === 'ru'),
  };
  console.log('\nchecks:', checks);
  if (!Object.values(checks).every(Boolean)) process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
cd /Users/dougd/OpenWA/OpenWA
XAI_API_KEY=$(cat ../Credentials/openwa-testkey | tr -d '[:space:]') npx ts-node --transpile-only scripts/translation-llm-smoke.ts
```

Expected: the model list prints 7 xAI models with prices like `inputPerMTok: 1.25`; the translation JSON shows `source: 'es'`, an English line containing "Doug" and uncensored profanity, and a Russian line; `checks:` all `true`; exit 0.

If `ts-node` complains about module resolution under `nodenext`, rerun with `npx ts-node --transpile-only -O '{"module":"commonjs","moduleResolution":"node"}' scripts/translation-llm-smoke.ts`. If `createLogger` fails outside Nest, report it; do not stub the logger in production code.

Paste the (redacted, key-free) output into the review handoff.

- [ ] **Step 3: Optional second sample**

Doug may want an explicit sexual-content line tested too. Do not invent one; if Doug supplies one, run it by setting `SMOKE_TEXT` and adding `text: process.env.SMOKE_TEXT ?? '...'` to the script. Report whether the provider refused.

- [ ] **Step 4: Make sure the script is excluded from Jest and lint noise**

Jest `rootDir` is `src`, so `scripts/` is not collected. Run `npm run lint` (it lints `src` and `test` only) and `npm run format -- --check`; fix formatting if flagged.

- [ ] **Step 5: Commit**

```bash
git add scripts/translation-llm-smoke.ts
git commit -m "chore(translation): live smoke script for the LLM translator"
```

**Review focus (Fable):** smoke output shows context-aware, uncensored, name-preserving translation; pricing conversion matches the docs page (USD 1.25 / 2.50).

---

### Task 15: Docs, full verification, final review

**Intent:** Leave the repo and the ops notes in a state where the next person (or Fable) can deploy without re-deriving anything.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-translation-llm-provider-design.md` (§15a operational runbook — the *tracked* home for these notes, and the spec drift corrections)
- Modify: `CLAUDE.md` (section "Deployment & operations" → "Managing the VM stack") — **git-ignored, local convenience only**

> **Correction (found during execution):** `CLAUDE.md` is git-ignored at `.gitignore:75` and has never been
> committed in this repo's history — it is grouped with `.claude/`, `.agent/` and `.remember/`, so being
> untracked is deliberate machine-local policy. It therefore **cannot** be the home for deployment
> knowledge, and it cannot be committed (see Step 3). The canonical copy of the operational notes below
> lives in spec §15a. Updating the local `CLAUDE.md` as well is still worth doing for whoever works on
> that machine.

- [ ] **Step 1: Write the ops notes into spec §15a, and mirror them into the local CLAUDE.md**

Under "Managing the VM stack", after the LibreTranslate bullet:

```markdown
- AI translator (Grok via OpenAI-compatible API): primary provider since 2026-09, LibreTranslate is the fallback. Key lives at `/opt/openwa/secrets/xai.key` (root-only). `enable-plugin.sh` sets `llmEnabled`, `llmBaseUrl`, `llmModel`, `llmApiKey` (read from that file), `contextTurns`, `defaultPrivacy`, and `operatorWids` on every boot; the operator's runtime model choice (`/tr model switch`) is persisted separately in plugin storage and survives that re-PUT. Per-group opt-out: `/tr privacy local`. Design: `docs/superpowers/specs/2026-09-16-translation-llm-provider-design.md`.
```

- [ ] **Step 2: Full verification**

Run: `npm run build && npm test && npm run lint && npx prettier --check "src/**/*.ts" "test/**/*.ts" && npm run test:cov 2>&1 | tail -20`
Expected: build ok, all suites green, coverage thresholds met.

> **Correction:** not `npm run format -- --check`. This repo defines `format` as `prettier --write`, so the
> appended flag does not turn it into a check — it rewrites the very files it was supposed to verify.

- [ ] **Step 3: Commit**

```bash
# NOT `git add CLAUDE.md` — that file is git-ignored and the add silently does nothing.
git add docs/superpowers/specs/2026-09-16-translation-llm-provider-design.md
git commit -m "docs: VM ops notes for the AI translator provider"
```

- [ ] **Step 4: Fable whole-branch review**

Fable reviews `git diff _local-test-combined...feat/translation-llm-provider` against the full spec, the smoke output from Task 14, and the deployment checklist in Task 16. Findings go back to Opus as a task list; re-review after fixes.

---

### Task 16: VM deployment (requires Doug's explicit go-ahead)

**Intent:** Ship to `45.33.120.227` without breaking the live WhatsApp session. Spec §15. **Do not start this task until Doug says go**; it changes production.

- [ ] **Step 1: Stage the secret on the VM**

```bash
ssh root@45.33.120.227 'mkdir -p /opt/openwa/secrets && chmod 700 /opt/openwa/secrets'
scp /Users/dougd/OpenWA/Credentials/openwa-testkey root@45.33.120.227:/opt/openwa/secrets/xai.key
ssh root@45.33.120.227 'chmod 600 /opt/openwa/secrets/xai.key'
```

- [ ] **Step 2: Extend `/opt/openwa/enable-plugin.sh`**

Replace the config PUT with (Doug supplies `OPERATOR_WID`, his `<phone>@c.us`; add the `@lid` form later once seen in logs):

```bash
XAI_KEY=$(tr -d '[:space:]' < /opt/openwa/secrets/xai.key)
OPERATOR_WID='REPLACE_ME@c.us'
curl -fsS -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"config\":{\"libretranslateUrl\":\"http://libretranslate:5000\",\"llmEnabled\":true,\"llmBaseUrl\":\"https://api.x.ai/v1\",\"llmModel\":\"grok-4.20-0309-non-reasoning\",\"llmApiKey\":\"$XAI_KEY\",\"llmTimeoutMs\":8000,\"contextTurns\":10,\"defaultPrivacy\":\"cloud\",\"operatorWids\":[\"$OPERATOR_WID\"]}}" \
  http://localhost:2785/api/plugins/translation/config >/dev/null || true
```

- [ ] **Step 3: Deploy the branch**

```bash
ssh root@45.33.120.227 'cd /opt/openwa && git fetch origin && git checkout feat/translation-llm-provider && git pull && docker compose --profile with-dashboard build openwa-api && docker compose --profile with-dashboard up -d && systemctl restart owa-plugin-config'
```

(Push the branch to the `dallascyclist/OpenWA` fork first if the VM pulls from there.)

- [ ] **Step 4: Verify in the test group**

- `/tr status` shows `AI translator (grok-4.20-0309-non-reasoning): ok` and `Privacy: cloud (instance default)`.
- Send a message; `docker compose --profile with-dashboard logs openwa-api | grep translation_decision` shows `provider: 'llm'`.
- `/tr model list` from Doug's number lists 7 models with prices.
- `/tr privacy local`, send a message, confirm `provider: 'libretranslate'`; `/tr privacy cloud` to restore.
- Check the session did not disconnect (`/api/sessions`).

- [ ] **Step 5: Record**

Append a short "Deployed 2026-xx-xx" note to the spec's Status line and commit.

---

## Self-review (done by the plan author, 2026-09-16)

- **Spec coverage:** §5 types → T1; §9 → T2; §4/§6 LibreTranslate wrapper → T3; §8 → T4; §11a persistence → T5; §7 → T6/T7; §10/§11/§11a text and parsing → T8; §6 flow → T9; §10 → T10; §11 → T11; §11a commands → T12; §4 composition + §12 + §13 → T13; §14 manual → T14; §15 → T16; §16 protocol → header. §17 is out of scope by design.
- **Placeholders:** none; every step has code or an exact command. `REPLACE_ME@c.us` in T16 is a deliberate operator input, called out as such.
- **Type consistency:** `TranslateResult.detected/source/translations/provider`, `ProviderHealth.{name,external,healthy}`, `CoordinatorExtras.{context,models,modelStore,providerHealth}`, `formatStatus(state, health, privacy, activeModel?)`, `parseModelJson`, `PluginModelStore` key `llm:model` are used identically across tasks.
