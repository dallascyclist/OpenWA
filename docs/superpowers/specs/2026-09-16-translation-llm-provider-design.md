# Translation plugin: LLM provider with context, LibreTranslate fallback, per-group privacy

**Date:** 2026-09-16
**Branch:** `_local-test-combined` (Doug's v0.2.10-based line; see `docs/superpowers/handoffs/2026-09-15-upstream-status-and-translation-replatform.md`)
**Status:** approved; implementation plan at `docs/superpowers/plans/2026-09-16-translation-llm-provider.md`

## 1. Why this exists

The group auto-translation plugin (`src/plugins/extensions/translation/`) currently translates every
message through LibreTranslate (Argos models). Quality is poor in practice: sentence-level, context-free,
frequent language-detection misfires on short or colloquial messages, and names get translated.

Decision: add a commercial LLM as the **primary** translator, keep LibreTranslate as the **fallback**, and
give the LLM conversation context so it can translate with awareness of the last few turns. Grok (xAI) is
the first target because Doug's experience is that it translates better and it does not refuse adult or
explicit content, which matters for the likely first commercial market (adult industry). Self-hosting a
translation LLM (Ollama / LM Studio) was considered and rejected for now: hosting cost (~USD 600-700/month)
far exceeds API token cost at current scale.

Upstream's marketplace plugin `group-translate` (rmyndharis/OpenWA-plugins, v1.3.7) was checked on
2026-09-16: it is LibreTranslate-only, no LLM provider, no context. It is our plugin re-homed. Nothing to
borrow.

## 2. Goals and non-goals

Goals:
- Markedly better translations via an LLM, with prior-turn context and a participant-name glossary.
- Never lose a message because the LLM is slow, down, or refuses: fall through to LibreTranslate.
- Per-group ability to opt out of external (cloud) processing, with an instance-level default, and a
  one-time in-group disclosure when cloud translation is in effect. This is groundwork for commercial
  privacy disclosure.
- Operators learn about degradation once, in-group, not on every reply.
- Everything in `core/` stays framework-free and unit-tested with fakes, matching the existing layout.

Non-goals (explicitly deferred):
- Rolling conversation **summary**. The port and request shape reserve a slot for it; nothing populates it.
- Persisting context across restarts.
- Anthropic/Claude adapter (different request shape). OpenAI-compatible only in this cut.
- Dashboard UI changes beyond what the generic plugin config editor already renders.
- Porting this to the upstream marketplace plugin format.

## 3. Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | One generic **OpenAI-compatible chat client**, defaulting to xAI Grok | Works unchanged for Grok, OpenAI, Ollama, LM Studio, LiteLLM. Swapping providers is config, not code. |
| D2 | **Single LLM call per message**: detect + translate into all candidate languages, JSON out | Fewer calls, lower latency, cross-target consistency, and LLM detection beats LibreTranslate on short/mixed text. |
| D3 | Context = **in-memory ring buffer** of last N untranslated turns per chat, plus name glossary | Grok's API is stateless; we assemble memory ourselves. Cheap and sufficient for chat-length messages. |
| D4 | Summary **designed, not built** | Doubles LLM calls; marginal gain now. Slot reserved so adding it later touches only the context component and prompt. |
| D5 | **Fallback chain**: LLM then LibreTranslate; refusals count as failures | Guarantees delivery. Adult content that a stricter provider refuses still gets a (worse) translation rather than nothing. |
| D6 | **No per-reply provider tag**; one-time degraded/recovered notice per group + `/tr status` | Doug's call: tagging every reply is noise. |
| D7 | **Privacy**: instance default (`defaultPrivacy`) + per-group override via `/tr privacy` | Doug's VM runs cloud-by-default; a commercial tenant can ship local-by-default. Costs almost nothing extra. |
| D8 | Initial model `grok-4.20-0309-non-reasoning` | Cheapest general-purpose Grok text tier as of 2026-09-16 (USD 1.25 in / 2.50 out per 1M tokens, same as grok-4.3); non-reasoning avoids reasoning latency on a task that does not need it. Only the *initial* value; see D11. |
| D11 | Model is **runtime-selectable in chat** (`/tr model list` / `/tr model switch`), not a dashboard config key; gated by an **operator allow-list** of WhatsApp IDs | Doug wants to experiment across models without a config round-trip. Instance-wide (one active model for all groups) because this is an experimentation control, not a per-tenant feature. Persisted in plugin storage so a container restart does not revert it. |
| D9 | `llmEnabled` defaults **false** | The VM must keep working through a deploy until the API key is provisioned. |
| D10 | Ignored participants' messages still enter the context buffer | They are still part of the conversation the LLM needs to understand; "ignore" means "don't translate their messages", not "pretend they aren't there". |

## 4. Architecture

All new code lives under `src/plugins/extensions/translation/`. Existing files that change are marked.

```
translation/
  core/                          framework-free; no Nest/TypeORM/engine imports
    ports.ts                     (changed) + ContextualTranslator, TranslateRequest/Result, ContextTurn,
                                 SummaryProvider (reserved), GroupState privacy fields, ProviderHealthListener
    translation.coordinator.ts   (changed) uses ContextualTranslator; privacy cmd; disclosure; degraded notices
    command.parser.ts            (changed) + `privacy [cloud|local]`, `model [list|switch <id>]`
    reply.formatter.ts           (changed) status shows providers, privacy, model; disclosure; notice; model list
    fallback-chain.ts            (new)  ordered providers, external-skip, circuit-aware, health transitions
    conversation-context.ts      (new)  per-chat ring buffer with turn + char caps
    libretranslate.contextual.ts (new)  wraps the existing Translator (detect + fan-out) behind the new port
  llm-openai-compatible.client.ts (new) Grok/OpenAI-compatible adapter: prompt, request, validation, breaker,
                                 ModelSwitchable (list via /models or xAI /language-models, set at runtime)
  plugin-model.store.ts          (new)  ModelStore over ctx.storage (beside plugin-config.store.ts; not core)
  core/errors.ts                 (new)  ProviderRefusedError, AllProvidersFailedError
  libretranslate.client.ts       (unchanged)
  index.ts                       (changed) wires chain = [llm?, libretranslate]; reads new config keys
  plugin-chat.gateway.ts         (unchanged)
  plugin-config.store.ts         (unchanged)
```

Composition (in `index.ts`, rebuilt on `onEnable` and `onConfigChange`):

```
coordinator
  └─ FallbackChain (ContextualTranslator)
       ├─ [0] OpenAiCompatibleClient   external=true   (only if llmEnabled && llmApiKey)
       └─ [1] LibreTranslateContextual external=false  (wraps LibreTranslateClient)
  └─ ConversationContext (per session+chat ring buffers)
```

## 5. Data contracts (core/ports.ts)

```ts
export interface ContextTurn {
  author: string;      // display name (pushName) or short wid fallback
  lang: string;        // detected/known ISO 639-1 at the time
  text: string;        // ORIGINAL text, never a translation
  at: string;          // ISO timestamp
}

export interface TranslateRequest {
  text: string;
  senderName: string;
  candidateLangs: string[];   // group's known languages (may be empty on a group's first message)
  hintLang: string | null;    // sender's learned/pinned language, if any
  glossary: string[];         // participant display names; never translate
  history: ContextTurn[];     // last N turns, oldest first, excludes this message
  summary?: string;           // RESERVED for D4; always undefined in this cut
  allowExternal: boolean;     // false => chain must skip external providers
}

export interface TranslateResult {
  detected: string;           // raw detection (feeds participant learning, exactly as today)
  source: string;             // language the translations were made FROM, after the sanity rule
                              // (`candidateLangs.includes(detected) ? detected : hintLang ?? detected`)
  translations: Translation[];// one per candidateLangs entry != source (may be fewer if a target failed)
  provider: string;           // 'llm' | 'libretranslate'
}

export interface ContextualTranslator {
  readonly name: string;
  readonly external: boolean;
  translateAll(req: TranslateRequest): Promise<TranslateResult>;
  languages(): Promise<string[]>;   // for /tr setlang validation; chain delegates to first healthy
  isHealthy(): boolean;
}

/** Reserved (D4). Not implemented or wired in this cut. */
export interface SummaryProvider {
  summarize(turns: ContextTurn[], previousSummary?: string): Promise<string>;
}

export interface ModelInfo {
  id: string;
  inputPerMTok?: number;   // USD per 1M input tokens, when the provider exposes pricing
  outputPerMTok?: number;  // USD per 1M output tokens
}

/** Implemented by providers whose model can be changed at runtime (the LLM adapter). */
export interface ModelSwitchable {
  listModels(): Promise<ModelInfo[]>;
  currentModel(): string;
  setModel(id: string): void;
}

export interface ProviderHealth { name: string; external: boolean; healthy: boolean }
export interface ModelSelection { model: string; updatedAt: string; updatedBy: string }
export interface ModelStore { load(): Promise<ModelSelection | null>; save(sel: ModelSelection): Promise<void> }
export type ProviderHealthListener = (change: ProviderHealth) => void;

// GroupState additions (persisted via ConfigStore):
//   privacy?: 'cloud' | 'local'      undefined => use instance default
//   privacyDisclosed?: boolean        one-time disclosure already posted
```

The existing `Translator` port stays for `LibreTranslateClient`; `LibreTranslateContextual` adapts it.

## 6. Message flow (translateMessage)

1. Existing pre-checks unchanged (length, URL/emoji-only, sender resolution, `enabled`).
2. Build `TranslateRequest`: `candidateLangs = knownLanguages(state)`, `hintLang = sender.lang`,
   `glossary = pushNames of all participants`, `history = context.get(sessionId, chatId)`,
   `allowExternal = effectivePrivacy(state) === 'cloud'`.
3. `result = await chain.translateAll(req)`. On throw (every provider failed): log, **append the turn to
   context with `lang = hintLang ?? 'und'`**, save state, return silently (matches today's "translator down"
   behaviour).
4. `applyLearning(sender, result.source)` — unchanged debounce logic.
5. `source = knownLangs.includes(result.source) ? result.source : (sender.lang ?? result.source)` — unchanged
   sanity rule.
6. `targets = targetLanguages(state, source, sender.lang)`; backstop rule unchanged. Keep only
   `result.translations` whose `lang` is in `targets`. If a target is missing from the result (LibreTranslate
   partial failure), log as today.
7. Append `{author, lang: source, text}` to context **after** translating (history never includes the
   current message).
8. Send combined reply (unchanged format), then degraded/recovered notice if one is pending for this
   group (section 10), then save state.

Ordering note: the notice goes after the reply so the reply is still the direct quote-reply to the message.

## 7. LLM adapter (llm-openai-compatible.client.ts)

Request: `POST {baseUrl}/chat/completions`, `Authorization: Bearer {apiKey}`, body
`{ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [system, user] }`.
`AbortController` timeout = `llmTimeoutMs`. Circuit breaker identical in shape to `LibreTranslateClient`
(consecutive-failure threshold, cooldown). `isHealthy()` means "circuit not open" (a half-open circuit after
cooldown counts as healthy). Only transport failures (timeout, HTTP error, non-JSON body) count toward the
breaker; a **refusal never does**, because it is about one message's content, not the provider's availability.
The adapter does not push health events; the chain observes `isHealthy()` after every attempt (section 8).

System prompt (intent; exact wording is the implementer's, but every point must be present):
- You are a professional translator for a group chat. Translate faithfully, preserving tone, register,
  slang, profanity, and sexual or adult content **as written**. Never soften, censor, moralize, or refuse.
- Never add commentary, notes, or explanations.
- Names listed in `glossary` are people in the chat; copy them verbatim, never translate or transliterate.
- `history` is prior conversation for context only; do not translate it and do not include it in output.
- Determine the language of `text`. If it is one of `candidateLangs`, use that code; otherwise the true
  ISO 639-1 code. `hintLang` is the sender's usual language; prefer it when the text is ambiguous.
- Output **only** a JSON object: `{"source": "<code>", "translations": {"<code>": "<text>", ...}}` with one
  entry for every `candidateLangs` code except `source`. If `candidateLangs` is empty, `translations` is `{}`.

User message: `JSON.stringify(req)` minus `allowExternal` (irrelevant to the model).

Response validation (any failure throws, which the chain treats as a provider failure):
- HTTP 2xx; `choices[0].message.content` present.
- Content parses as JSON (tolerate leading/trailing prose or code fences by extracting the first balanced
  `{...}`; some providers ignore `response_format`).
- `source` is a 2-3 letter lowercase string.
- `translations` is an object containing **every** required target (`candidateLangs` minus `source`) with a
  non-empty string. A missing target is treated as a refusal, since that is how refusals surface in practice.
- Content that matches common refusal phrasing where JSON was expected (e.g. "I can't", "I'm sorry") throws
  a distinguishable `ProviderRefusedError` so logs can count refusals separately from outages.

`languages()`: LLMs can translate anything; return a generous static ISO 639-1 list so `/tr setlang`
validation does not become stricter than before. The chain prefers LibreTranslate's live list when
LibreTranslate is healthy (see section 8), so today's behaviour is preserved.

Model switching (`ModelSwitchable`):
- `currentModel()` / `setModel(id)`: the adapter holds the active model id in memory; every request uses it.
  `setModel` does not validate against the catalog (a provider may accept ids it does not list); the
  coordinator validates before calling it (section 11a).
- `listModels()`: `GET {baseUrl}/models` (OpenAI shape, `data[].id`) for every provider. xAI's `/models`
  response additionally carries `prompt_text_token_price` and `completion_text_token_price`; when those
  numeric fields are present, divide by **10000** to get USD per 1M tokens (verified live 2026-09-16:
  `12500` => USD 1.25). Providers without those fields yield `ModelInfo` with no price fields. Cached for
  10 minutes to keep `/tr model list` cheap.

## 8. Fallback chain (core/fallback-chain.ts)

`new FallbackChain(providers: ContextualTranslator[], onHealth?: ProviderHealthListener)`

`translateAll(req)`:
- Iterate providers in order. Skip if `provider.external && !req.allowExternal`. Do **not** skip on
  `!isHealthy()`: an open circuit throws instantly inside the provider, and the provider's own cooldown is
  what lets it recover (skipping would leave `LibreTranslateClient` permanently marked unhealthy, since its
  health only resets on a successful call).
- Try; on any throw, log `{action:'translation_provider_failed', provider, reason, refused: bool}` and continue.
- If none succeeded, throw `AllProvidersFailedError` carrying the per-provider reasons.
- Result's `provider` field is the provider's `name`.

`isHealthy()`: true if any provider is healthy. `languages()`: first healthy non-external provider's list,
else first healthy provider's list.

Health: `providerHealth(): ProviderHealth[]` returns each provider's `{name, external, healthy}` by polling
`isHealthy()`. The coordinator calls it after each translation to detect transitions (section 11); no
push listener is needed.

## 9. Conversation context (core/conversation-context.ts)

`new ConversationContext({ maxTurns, maxChars })`, default `maxTurns = contextTurns` config (10),
`maxChars = 2000` (fixed; not user-facing in this cut). The char cap evicts oldest-first but always keeps at
least the newest turn, so a single long message does not empty the buffer.

- `get(sessionId, chatId): ContextTurn[]` — oldest first.
- `append(sessionId, chatId, turn)` — drop oldest until both caps hold.
- `clear(sessionId, chatId)` — called on `/tr off`.
- Keyed `${sessionId}:${chatId}`; plain `Map`. No persistence. No eviction of idle chats in this cut
  (bounded by maxTurns x groups; revisit if memory ever matters).

What enters the buffer: every group message that reached `translateMessage` and passed the length/URL
pre-checks, including messages from ignored participants (D10) and messages where every provider failed.
What never enters: commands, the bot's own sends, messages below `minLength`, URL/emoji-only messages.

## 10. Privacy

- Config `defaultPrivacy: 'cloud' | 'local'` (default `'cloud'`).
- `effectivePrivacy(state) = state.privacy ?? defaultPrivacy`.
- `/tr privacy` (anyone): replies with the effective mode, whether it is a group override or the instance
  default, and the disclosure text.
- `/tr privacy cloud|local` (admin/delegate-gated like `on`/`off`): sets `state.privacy`, confirms, and if the
  new mode is cloud and `!privacyDisclosed`, posts the disclosure and sets `privacyDisclosed = true`.
- `/tr on`: after the existing confirmation, if effective mode is cloud and `!privacyDisclosed`, post the
  disclosure and set the flag.
- Disclosure text (formatter; wording may be refined): "ℹ️ Translations in this group are produced by an
  external AI service; message text is sent to that provider for translation. An admin can switch to
  local-only translation with `/tr privacy local`."
- Help text gains the `privacy` line.

`allowExternal` is evaluated per message, so flipping the mode takes effect immediately with no restart.

## 11. Degraded and recovered notices

- Coordinator keeps two in-memory maps: `currentHealth: Map<providerName, boolean>` (updated by the
  chain's health listener) and `notifiedHealth: Map<chatKey, Map<providerName, boolean>>` (what each group
  was last told). Nothing is persisted and no storage enumeration happens.
- On each group's next translated message, compare `currentHealth` against that group's `notifiedHealth`;
  for every provider whose state differs, post one notice line and record it. Result: at most one line per
  provider per transition per group, delivered lazily on that group's next activity.
- Notice text: degraded "⚠️ AI translation is temporarily unavailable; using basic translation until it
  recovers." recovered "✅ AI translation is back." LibreTranslate transitions get the analogous text
  ("basic translator"). No notice for external providers in a local-only group.
- `/tr status` adds one line per provider: `AI translator (grok-4.20-0309-non-reasoning): ok | degraded | disabled | off (privacy)`
  and `Basic translator (libretranslate): ok | unreachable`, plus `Privacy: cloud (instance default)` or
  `local (group override)`.

## 11a. Runtime model selection (`/tr model`)

Commands (all gated by the operator allow-list, section 12 `operatorWids`; admins/delegates are **not**
sufficient, this is an instance-level control):
- `/tr model` — show the active model id and the provider base URL host.
- `/tr model list` — call `listModels()` and post one line per model: `id`, then `in $X / out $Y per 1M tok`
  when pricing is available, with the active model marked. Truncate to the first 30 entries with a
  "(+N more)" trailer so a large OpenAI catalog cannot flood the group.
- `/tr model switch <id>` — validate `<id>` against `listModels()` (case-sensitive exact match); on hit call
  `setModel(id)`, persist via `ModelStore`, and confirm. On miss reply with the nearest few ids (simple
  prefix/substring match) and do nothing. If the catalog call fails, allow the switch anyway with a
  "catalog unavailable, switched unverified" confirmation, since the next translation will reveal a bad id
  through the normal fallback path.

Non-operators running any `/tr model` form always get a denial reply ("⛔ Only the instance operator can use
that command."), matching the coordinator's existing rule that a command never fails silently. (The
`denyReply` option exists in config but the current coordinator does not consult it; this cut does not change
that.)

Persistence (`plugin-model.store.ts`, implementing the `ModelStore` port): a single storage key
(`llm:model`) holding `ModelSelection` through the same `ctx.storage` the group state uses. On plugin
enable/config-change, `index.ts` loads it and, if present, overrides the initial `llmModel` before
constructing the adapter. This is what makes the switch survive the VM's post-restart config re-PUT.

Operator identity: `msg.author` is compared to each `operatorWids` entry with the coordinator's existing
`widEquals` (tolerant of `:device` suffixes and `@domain`). Because the host may deliver Doug's messages
under an `@lid` id rather than `<phone>@c.us`, the list accepts multiple entries; Doug adds both forms once
known. `/tr status` shows the active model so an operator can confirm a switch took effect.

## 12. Configuration keys (plugin config, alongside existing keys)

| Key | Type | Default | Notes |
|---|---|---|---|
| `llmEnabled` | boolean | `false` | Chain includes the LLM only when true **and** `llmApiKey` set |
| `llmBaseUrl` | string | `https://api.x.ai/v1` | Any OpenAI-compatible base; no trailing slash |
| `llmApiKey` | string (secret) | — | Same handling as `libretranslateApiKey` |
| `llmModel` | string | `grok-4.20-0309-non-reasoning` | **Initial** model only (D8). A persisted `/tr model switch` choice overrides it (D11). |
| `operatorWids` | string[] | `[]` | WhatsApp IDs allowed to run `/tr model *`. Doug's ID on the VM. Empty list means nobody can switch models. The reader also accepts a comma-separated string, since the dashboard form may not render arrays. |
| `llmTimeoutMs` | number | `8000` | Hook bus has no per-handler timeout (verified 2026-09-16) |
| `contextTurns` | number | `10` | Ring buffer size |
| `defaultPrivacy` | `'cloud'|'local'` | `'cloud'` | Instance default (D7) |

Existing: `libretranslateUrl`, `libretranslateApiKey`, `timeoutMs`, `commandPrefix`, `minLength`,
`maxLength`, `denyReply` — unchanged.

The plugin's `configSchema` in `src/plugins/extensions/extensions.module.ts` (where `libretranslateApiKey`
is declared with `secret: true`) must declare every new key above, with `llmApiKey` as `secret: true`, so the
dashboard config editor renders and redacts them correctly.

## 13. Persistence

`GroupState` gains two optional fields (`privacy`, `privacyDisclosed`). Stored as JSON through the existing
`PluginConfigStore`; absent fields on old records read as `undefined`. No migration.

## 14. Testing

Unit (Jest, colocated `*.spec.ts`, fakes only, no network):
- `llm-openai-compatible.client.spec.ts`: happy path builds the exact request shape; JSON in code fences
  is extracted; missing target throws; refusal prose throws `ProviderRefusedError`; timeout aborts; breaker
  opens after threshold and calls the health listener; closes after cooldown on success.
- `fallback-chain.spec.ts`: skips external when `allowExternal=false`; skips unhealthy; falls through on
  throw; `AllProvidersFailedError` when all fail; health transitions deduped.
- `conversation-context.spec.ts`: ordering, turn cap, char cap, clear, key isolation.
- `plugin-model.store.spec.ts`: round-trip, absent key yields null.
- LLM client spec additions: `listModels` parses the OpenAI `/models` shape with and without xAI price
  fields (÷10000); catalog cached; `setModel` changes the model on the next request body.
- `libretranslate.contextual.spec.ts`: detect + fan-out mapping; partial failure yields partial result.
- `translation.coordinator.spec.ts` (extend): request assembly (candidates, glossary, history excludes
  current message); privacy local forces `allowExternal=false`; disclosure posted exactly once on `on`
  and on switch to cloud; `/tr privacy` output; degraded notice once per transition, none in local groups;
  `/tr model list|switch` allowed for an `operatorWids` entry (including `:device`-suffixed author) and
  denied for a group admin who is not an operator; switch persists via the store and unknown id is rejected;
  context cleared on `off`; ignored participant's message enters context but is not translated.
- `command.parser.spec.ts`, `reply.formatter.spec.ts` (extend).
- All existing specs remain green; coverage thresholds unchanged.

Manual: `scripts/translation-llm-smoke.ts` (or a documented `curl`) that sends one request with history and
an explicit-content sample to the configured provider and prints the parsed result. Run before deploy.

## 15. Deployment (VM `/opt/openwa`)

1. Put the xAI key in `/opt/openwa/secrets/xai.key` (root-only, `chmod 600`).
2. Extend `/opt/openwa/enable-plugin.sh` config PUT to include `llmEnabled`, `llmBaseUrl`, `llmModel`,
   `llmApiKey` (read from the file), `contextTurns`, `defaultPrivacy`, `operatorWids` (Doug's WhatsApp ID,
   both `<phone>@c.us` and the `@lid` form once observed in logs). This script is the source of truth for
   plugin config after every container restart (extension plugin state is not persisted).
3. Rebuild/redeploy the `openwa-api` image from the branch, `docker compose --profile with-dashboard up -d`,
   then `systemctl restart owa-plugin-config`.
4. Verify: `/tr status` in the test group shows the AI translator `ok`; send a message; confirm the reply
   came from the LLM path in logs (`translation_decision` gains a `provider` field).
5. Outbound egress: the container reaches `api.x.ai:443` directly; the plugin uses global `fetch`, not the
   SSRF-guarded `ctx.net.fetch`, so no allow-list change. Confirm the Linode Cloud Firewall permits outbound
   443 (it does today for LibreTranslate model downloads).

Update `CLAUDE.md` "Managing the VM stack" with the new secret file and config keys.

## 16. Execution model

- **Implementer: Opus** (Claude Opus 5), orchestrated task-by-task from the implementation plan, starting
  with a cold context. The plan must therefore restate intent per task, name the exact files, and include
  the acceptance test for each task so Opus never has to infer the "why" from this spec alone.
- **Reviewer: Fable** (Claude Fable 5.1) reviews after **every task** (spec conformance + code quality) and
  once more at the end (whole-branch review, smoke test evidence, deployment checklist).
- TDD per task: failing spec first, then implementation, then `npm test -- <spec>`; `npm run lint` and
  `npm run format -- --check` before each review handoff.

## 17. Future (out of scope, recorded so the shape is not lost)

- Rolling summary via `SummaryProvider`: when the buffer overflows, summarize the dropped turns into
  `summary`, carry it forward, include it in the request. Adds one LLM call per overflow, not per message.
- Anthropic adapter behind the same `ContextualTranslator` port.
- Per-group model or provider override (commercial tiering); today's `/tr model switch` is instance-wide.
- Idle-chat eviction for `ConversationContext`.
- Persisting the disclosure/privacy policy version so a changed policy re-discloses.
