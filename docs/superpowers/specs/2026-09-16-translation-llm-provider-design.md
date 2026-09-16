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
                                 SummaryProvider (reserved), GroupState privacy fields, ProviderHealth
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
  source: string;             // language the translations were made FROM = the one candidateLangs
                              // entry `translations` omits. That omission is the only guarantee
                              // common to both providers; how each derives it differs.
                              // LibreTranslateContextual: the sanity rule
                              // (`candidateLangs.includes(detected) ? detected : hintLang ?? detected`).
                              // LLM client: the model's own answer, canonicalized, no hint
                              // fallback — so there `source === detected`.
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
4. `applyLearning(sender, result.detected)` — unchanged debounce logic.
5. `source = knownLangs.includes(result.detected) ? result.detected : (sender.lang ?? result.detected)` —
   unchanged sanity rule. **`knownLangs` here is recomputed after step 4**, and is a different array from
   the one that built `candidateLangs` in step 2. Step 4 can move the sender onto a new language, which
   both adds that language to the group's set and — when the sender was the last speaker of their old
   one — removes the old one. The sanity rule and the step-6 backstop must see the group as it is now;
   reusing the step-2 array makes the message that *confirms* a language switch get translated into the
   language the group has just abandoned, because the backstop still sees the stale entry and fires
   instead of staying silent. Step 2's array must equally not be recomputed: it describes the group as it
   was when the provider was asked, including the `pendingLang` augmentation that is deliberately scoped
   to `candidateLangs` alone.

   Steps 4-5 read `result.detected`, not `result.source`. The two fields differ by design (section 5):
   `detected` is the raw detection, and `source` is the language that provider chose to translate *from*
   after applying the same sanity rule to its own inputs. The coordinator must start from the raw value,
   because participant learning is about what the sender actually wrote — feeding it the provider's
   already-sanity-checked `source` would make learning self-confirming, since `source` collapses to the
   sender's existing `hintLang` exactly when detection disagreed with it.
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
- Content parses as JSON (tolerate leading/trailing prose or code fences by retrying on the span from the
  first `{` to the last `}`; some providers ignore `response_format`).
- `source` is a language code, not prose: a 2-3 letter base code, optionally followed by BCP-47
  script/region subtags and matched case-insensitively (`/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i`). Subtags are
  accepted because LibreTranslate emits codes like `zh-Hans`, which therefore reach the model in
  `candidateLangs` and come back as `source`; rejecting them would silently exclude Chinese-authored
  messages from the LLM path. The check still rejects prose such as `"Spanish"`.
- **A validated `source` is then canonicalized back to the group's own spelling** before anything downstream
  sees it: if some `candidateLangs` entry matches case-insensitively, that entry's spelling is returned; a
  code with no case-insensitive match is a language the group does not speak yet and is passed through
  untouched. This is a correctness requirement, not tidiness. Accepting subtags case-insensitively (previous
  bullet) means the model can legitimately answer `zh-hans` where the group holds `zh-Hans`. Left as-is that
  drifted spelling flows into `detected`, participant learning persists it as a *second* language for that
  sender, and from then on the group's known-language set contains both spellings — so every later message is
  translated twice, once per spelling, in every reply.
- `translations` is an object containing **every** required target (`candidateLangs` minus `source`) with a
  non-empty string. A missing target is treated as a refusal, since that is how refusals surface in practice.
  **Each target is looked up exact-match first, then case-insensitively** over the returned object's keys, for
  the same reason: a model that echoes the key `zh-hans` for a `zh-Hans` target has answered correctly, and
  without the fallback it would be miscounted as a refusal and fail the whole chain down to LibreTranslate.
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
- **The catalog is filtered to text-capable models.** `/models` returns image and video models alongside
  chat ones, and `setModel` deliberately does not validate (previous bullet) — the coordinator's only check
  is catalog membership, so an image model that reaches the list is a model an operator can switch to,
  persist, and thereby break every subsequent translation until someone switches back. Because xAI's
  `/models` publishes no modality metadata at all, the client first probes its `/language-models` sibling,
  which declares `output_modalities` and lists only chat models, and falls back to `/models` when that
  endpoint is absent. The probe is attempted at most once per client instance and only a definitive 404/405
  latches "unsupported"; it bypasses the circuit breaker, since a provider that simply lacks the endpoint is
  answering normally, not failing.
- The filter keeps a model **unless the provider positively declares it cannot emit text** — a model that
  declares no modalities is kept. Ollama and LM Studio annotate nothing, so dropping un-annotated models
  would empty the catalog for every self-hosted user, which is a worse failure than the one being guarded
  against. Filtering on the presence of pricing fields would be wrong for exactly the same reason: those
  providers publish no prices either. Nor is the filter id-pattern-based — `grok-imagine-*` is excluded
  because xAI declares `output_modalities: ["image"]` for it, not because of its name.

## 8. Fallback chain (core/fallback-chain.ts)

`new FallbackChain(providers: ContextualTranslator[], logger?: TranslationLogger)`

The second argument is the logger for the per-provider failure line below, not a health callback. An earlier
draft of this section passed an `onHealth?: ProviderHealthListener` push callback; that type was never built
and has been dropped from section 5. The polling model described at the end of this section is the
authoritative one.

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

`maxTurns` is **clamped to at least 1** (non-finite values also fall back to 1). This is a liveness
requirement, not cosmetics: the turn cap is enforced by `while (buf.length > maxTurns) buf.shift()`, and for
any non-positive `maxTurns` that condition never becomes false once the buffer is empty, so the loop spins
forever. `contextTurns` is an operator-editable dashboard field, so a `0` or a stray `-1` is reachable without
touching code, and the loop runs on the synchronous message-handling path — it would block the event loop for
the whole process, taking down every session on the instance, not just translation in one group.

- `get(sessionId, chatId): ContextTurn[]` — oldest first.
- `append(sessionId, chatId, turn)` — drop oldest until both caps hold.
- `clear(sessionId, chatId)` — called on `/tr off`, and on every `/tr privacy` switch (section 10).
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
- `/tr privacy cloud|local` (admin/delegate-gated like `on`/`off`): sets `state.privacy`, **clears that
  group's conversation buffer**, confirms, and if the new mode is cloud and `!privacyDisclosed`, posts the
  disclosure and sets `privacyDisclosed = true`.
- `/tr on`: after the existing confirmation, if effective mode is cloud and `!privacyDisclosed`, post the
  disclosure and set the flag.
- **The buffer is cleared on any privacy switch.** Going local -> cloud is the point: the retained turns were
  spoken while the group had explicitly opted out of external processing, and without the clear they would
  ship to the external provider as `history` on the very next message. The disclosure does not retroactively
  cover them — it says message text *will be* sent, not that already-spoken text is about to be. The clear is
  unconditional rather than only on the flip to cloud, because dropping history on cloud -> local costs
  nothing and leaves no branch here for a later change to get wrong.
- The same boundary exists one level up, at the instance default: flipping config `defaultPrivacy` from
  `local` to `cloud` makes every group without an override cloud-eligible, so that transition drops the
  retained context wholesale (`core/privacy-transition.ts`, applied when the coordinator is rebuilt). The
  first build of the plugin's lifetime has no prior mode and therefore no retained context to leak, so it
  resets nothing.
- **The disclosure requires two conditions, not one: `mode === 'cloud'` AND the chain actually contains an
  external provider.** Cloud privacy mode alone is not sufficient. The disclosure is a compliance statement
  that message text may be sent to an external AI service, and that is only true once the operator has wired
  one up (`llmEnabled` plus a usable API key). On the default-but-unconfigured deployment — `defaultPrivacy`
  is `'cloud'`, `llmEnabled` is false — the chain holds LibreTranslate alone, nothing leaves the instance,
  and posting the notice would tell every group their messages go to an external service when none exists. A
  false compliance statement is worse than no statement, so the check is on the chain's composition
  (`providerHealth().some(p => p.external)`), not on config or on privacy mode alone.
- Ordering: the disclosure is sent **first**, then `privacyDisclosed` is persisted. A send failure therefore
  leaves the flag unset and the notice is retried, erring toward disclosing twice rather than translating
  externally having never disclosed once.
- Disclosure text (formatter; wording may be refined): "ℹ️ Translations in this group are produced by an
  external AI service: messages sent here go to that provider, along with recent messages kept for context
  — including ones the bot does not translate — and participants' display names. An admin can switch to
  local-only translation with `/tr privacy local`." The notice must not understate the payload: the
  provider receives the sender's display name, a glossary of every participant's display name, and up to
  `contextTurns` prior turns, which include messages from ignored participants (D10) and messages buffered
  while a provider was down. A compliance notice that named only "message text" would be an
  understatement, which is the wrong direction to err in.
- Help text gains the `privacy` line.

`allowExternal` is evaluated per message, so flipping the mode takes effect immediately with no restart.

### 10a. Limitation: `local` means "no LLM", not "nothing leaves the box"

`LibreTranslateContextual` hard-codes `external = false`, so LibreTranslate is never skipped by a
`local` group and never triggers the disclosure. That is accurate for the intended deployment
(`libretranslateUrl` pointing at an in-stack or on-host LibreTranslate) but it is a property of the
provider class, not of the configured URL. An operator who points `libretranslateUrl` at a hosted
LibreTranslate — the config schema's own example offers `https://libretranslate.com` — sends message
text off-box from every group, including groups that explicitly chose `local`, with no disclosure.

**Deriving `external` from the URL is deliberately rejected, not merely unimplemented.** The production
VM uses `http://libretranslate:5000`: a Docker service name that is neither a loopback nor a private-IP
literal, so any naive host check classifies the in-stack LibreTranslate as external. Every `local`
group would then skip its only provider and lose translation entirely — a far worse failure than the
documented gap. Anything better would need an explicit operator-declared trust flag, which is not in
this cut. Until then the limitation is documented here, mirrored in the `libretranslateUrl` field
description in `src/plugins/extensions/extensions.module.ts` so an operator meets it at the point of
decision, and listed in §18.

## 11. Degraded and recovered notices

- Coordinator polls `chain.providerHealth()` for current state — there is no push listener (section 8) — and
  keeps one in-memory map, `notifiedHealth: Map<chatKey, Map<providerName, boolean>>` (what each group
  was last told). Nothing is persisted and no storage enumeration happens.
- On each group's next translated message, compare the polled health against that group's `notifiedHealth`;
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
- `/tr model switch <id>` — validate `<id>` against `listModels()` (case-sensitive exact match; note that
  catalog is filtered to text-capable models, section 7, which is what keeps an image or video model from
  being switchable at all); on hit call
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
   `llmApiKey` (read from the file), `llmTimeoutMs`, `contextTurns`, `defaultPrivacy`, `operatorWids`
   (Doug's WhatsApp ID, both `<phone>@c.us` and the `@lid` form once observed in logs). This script is the
   source of truth for plugin config after every container restart (extension plugin state is not
   persisted).
3. Rebuild/redeploy the `openwa-api` image from the branch, `docker compose --profile with-dashboard up -d`,
   then `systemctl restart owa-plugin-config`.
4. Verify: `/tr status` in the test group shows the AI translator `ok`; send a message; confirm the reply
   came from the LLM path in logs (`translation_decision` gains a `provider` field).
5. Outbound egress: the container reaches `api.x.ai:443` directly; the plugin uses global `fetch`, not the
   SSRF-guarded `ctx.net.fetch`, so no allow-list change. Confirm the Linode Cloud Firewall permits outbound
   443 (it does today for LibreTranslate model downloads).

### 15a. Operational runbook (tracked — this is the canonical copy)

**Why this lives here.** `CLAUDE.md` is git-ignored (`.gitignore:75`, grouped with `.claude/`, `.agent/`
and `.remember/`) and has never been committed in this repo's history. Keeping it machine-local is
deliberate policy, not an oversight — which means **`CLAUDE.md` cannot carry deployment knowledge**, because
nothing written there reaches anyone else or survives the loss of one laptop. Mirroring the operational
notes into this section is optional-to-nice on the laptop and mandatory for the next operator. Updating the
local `CLAUDE.md` too is a convenience for whoever works on that machine, not a substitute for this section.

- **Translation chain.** The AI translator is the primary provider; LibreTranslate is the fallback. The xAI
  key lives at `/opt/openwa/secrets/xai.key`, root-only (`chmod 600`). If the key is absent or
  `llmEnabled` is false, the chain silently degrades to LibreTranslate-only — there is no error, so diagnose
  it with `/tr status` in a group, which names each provider and its health.
- **Config is re-applied on every boot.** Extension plugins do not persist their enabled-state or config, so
  `/opt/openwa/enable-plugin.sh` (driven by the `owa-plugin-config` systemd oneshot, which waits for
  `/api/health/ready`) re-PUTs `llmEnabled`, `llmBaseUrl`, `llmModel`, `llmApiKey` (read from the key file),
  `llmTimeoutMs`, `contextTurns`, `defaultPrivacy` and `operatorWids` after every container restart. Run
  `systemctl restart owa-plugin-config` after any `docker compose restart`.
- **A runtime `/tr model switch` survives that re-PUT.** The operator's choice is persisted separately, in
  plugin KV storage under `llm:model` (not in plugin config), and `index.ts` applies it over the `llmModel`
  config key when building the adapter. That is exactly what makes it survive the boot-time re-PUT. The
  consequence for operators: to change the model permanently you must edit `llmModel` **and** clear the
  stored selection — editing config alone will appear to do nothing.
- **The switchable catalog is filtered to text-capable models** (section 7). `/tr model list` and the
  validation behind `switch` both see only models the provider has not declared non-textual; models
  declaring no modalities at all are kept, so self-hosted Ollama / LM Studio catalogs are not emptied. A
  model missing from the list is usually an image or video model, not a failed lookup.
- **Per-group opt-out.** `/tr privacy local` pins a group to LibreTranslate only, so no text from it leaves
  the VM; `/tr privacy cloud` returns it to the LLM path and posts the one-time external-AI disclosure.
  Either switch clears that group's buffered context (section 10). The instance-wide default is the
  `defaultPrivacy` config key, and flipping that from `local` to `cloud` drops retained context wholesale.
- **`/tr model` is operator-gated** by `operatorWids`; group admins and delegates are not sufficient, because
  the model is instance-wide state. Add both the `<phone>@c.us` and `@lid` forms — the host may deliver the
  same person's messages under either.

## 16. Execution model

- **Implementer: Opus** (Claude Opus 5), orchestrated task-by-task from the implementation plan, starting
  with a cold context. The plan must therefore restate intent per task, name the exact files, and include
  the acceptance test for each task so Opus never has to infer the "why" from this spec alone.
- **Reviewer: Fable** (Claude Fable 5.1) reviews after **every task** (spec conformance + code quality) and
  once more at the end (whole-branch review, smoke test evidence, deployment checklist).
- TDD per task: failing spec first, then implementation, then `npm test -- <spec>`; `npm run lint` and
  `npx prettier --check "src/**/*.ts" "test/**/*.ts"` before each review handoff. (Not
  `npm run format -- --check`: this repo defines `format` as `prettier --write`, so the appended flag does
  not turn it into a check — it rewrites the files it was meant to verify.)

## 17. Future (out of scope, recorded so the shape is not lost)

- Rolling summary via `SummaryProvider`: when the buffer overflows, summarize the dropped turns into
  `summary`, carry it forward, include it in the request. Adds one LLM call per overflow, not per message.
- Anthropic adapter behind the same `ContextualTranslator` port.
- Per-group model or provider override (commercial tiering); today's `/tr model switch` is instance-wide.
- Idle-chat eviction for `ConversationContext`.
- Persisting the disclosure/privacy policy version so a changed policy re-discloses.

## 18. Known follow-ups

Recorded at the end of implementation. None of these block the branch; all are things the next person should
not have to rediscover.

### Plugin config secrets are readable over the API (pre-existing, now higher-stakes)

`GET /plugins` returns each plugin's `plugin.config` verbatim, so `llmApiKey` crosses to any caller permitted
to list plugins, and reaches the dashboard in plaintext. The existing `secret: true` field-schema flag only
changes the dashboard's *input* type; it does not mask the read path. This predates this branch — the branch
just gave the translation plugin its first genuinely sensitive config value.

The fix is more subtle than masking the response, because of a coupling: **the dashboard currently relies on
the key being returned, so that it can re-post it when the operator saves an unrelated config field.** Mask
the read path alone and the next config edit writes back a masked or empty `llmApiKey`, and the LLM silently
drops out of the chain — the group keeps getting LibreTranslate output with no error anywhere. Whoever masks
the read path must simultaneously teach the dashboard to *omit* an untouched secret from its PUT, and the
backend to preserve the stored value when a secret key is absent from the payload.

### Model output quality

The hard requirement — no softening, no censoring, no refusal — held on every observed live run. What is not
stable run-to-run is the *strength* of profanity at `temperature: 0.2`: identical input produced "so fucking
hot" on one run and "so damn hot" on another. Recorded because faithful register is a product requirement
here, so a drift toward euphemism is a real regression signal, not a cosmetic one. No action proposed.

### Open question (unresolved — the project owner decides, not the implementer)

The live model **transliterates glossary names into non-Latin target scripts** despite the system prompt's
explicit never-transliterate rule: `Doug` comes back as `Даг` or `Дуг` in Russian. English and Chinese targets
preserve the Latin spelling correctly. Two live runs against two different prompt wordings failed identically,
so this is not a one-off sampling artifact and stronger prompt wording has already been tried once.

The live smoke script exits 2 on the `keepsNameInEveryTarget` check by design, so the failure stays visible
until this is decided. Three options are under consideration:

1. Accept the behaviour and revert the strengthened prompt bullet, treating transliteration into a
   non-Latin script as correct localization rather than a violation.
2. Keep tuning the prompt (e.g. per-target instruction, or restating the glossary inside the user payload).
3. Post-process deterministically: restore the Latin spelling of every glossary name in the output.

### Operational knowledge has no machine-local home

Recorded so it is not rediscovered: `CLAUDE.md` is git-ignored and has never been committed here, so any
future operational note written only there is one laptop away from being lost. §15a is the tracked home;
add to it first, and treat the local `CLAUDE.md` as a mirror. Both this spec and the implementation plan
originally named `CLAUDE.md` as *the* destination for these notes, and the plan's commit step even ran
`git add CLAUDE.md`, which silently does nothing. Both have been corrected.

### Deferred minors (worth a triage pass before merge)

- `notifiedHealth` is never evicted. Bounded by groups seen since boot and cleared on restart, so it is a
  slow leak at worst, but it is unbounded in principle.
- The conversation buffer appends in *completion* order, not arrival order, when messages are handled
  concurrently. Context can therefore be slightly out of order under load.
- ~~`translation/manifest.json` is stale but dead~~ — resolved: deleted. The loader scans `./plugins`, not
  `src/`, so nothing read it.
- **`local` privacy does not guarantee the text stays on the box** (§10a). `LibreTranslateContextual` is
  hard-coded `external = false`, so a `libretranslateUrl` pointing at a hosted LibreTranslate sends message
  text off-box from `local` groups with no disclosure. Deriving `external` from the URL is rejected — the
  production VM's `http://libretranslate:5000` is a Docker service name, so a host check would misclassify
  it as external and silently disable translation for every `local` group. The real fix is an explicit
  operator-declared trust flag on the provider config; until then the limitation is documented in §10a and
  in the `libretranslateUrl` field description.
- `buildCoordinator` is long enough to want decomposing if it grows again.
- `index.spec.ts` reaches private fields through casts.
- The circuit-open path logs via `console.warn`, which makes test output non-pristine. The right fix is a
  repo-level Jest setup file, not per-spec console spies — so it is deliberately not fixed locally here.
