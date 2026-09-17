# Group Translation — Resilient Sender Attribution & No-Silent-Drop

_Design spec. Date: 2026-06-17. Scope: `src/plugins/extensions/translation/` only. Targets PR #300 (not yet merged)._

## Problem

After a server restart / WhatsApp reconnect, the group auto-translation plugin silently stopped translating one participant's messages, while commands kept working. Root-cause investigation established:

- Translations worked correctly until a restart, then stopped for the affected sender. The bot still answered `/tr` commands.
- LibreTranslate was healthy; detection of the affected messages returned `es` cleanly; persisted `GroupState` was correct (`active`, Liz=`es`, Doug=`en`).
- The `messages` table showed **no outgoing rows** for the untranslated inbound messages. Since `MessageService.reply` persists a pending row *before* sending, this proves the reply was never attempted — `TranslationCoordinator.translateMessage` returned early at the `targets.length === 0` branch.
- That branch is only reachable, for a correctly-attributed message, when `source !== senderLang`. The only consistent explanation: the affected sender's incoming `msg.author` was mis-resolved by whatsapp-web.js after the reconnect — attributed to the *other* (valid) participant's `@lid`. The coordinator then saw an `en` speaker writing Spanish and excluded **both** `es` (source) and `en` (sender) from targets → empty → silent skip.

### Why it was hard to see

1. `targetLanguages` excludes both the detected `source` **and** the sender's language. In a two-language group, any `source !== senderLang` yields an empty target set.
2. The empty-target branch returns **silently** — no log.
3. `translateMessage` uses `Promise.allSettled` for the per-target `translate()` calls; rejected translations are silently filtered out. A translator failure and a misrouted author produce an identical "nothing happened" signature.

### Confirmed engine constraints

- `IncomingMessage` exposes `author`, `isLidSender`, `senderPhone`, `mentionedIds`, and `pushName` (via `contact.pushName`).
- `senderPhone` (#263, `RESOLVE_LID_TO_PHONE`) is **opt-in** (currently off) and **best-effort** (`null` when unmapped). Participants are keyed by `@lid` (from `@mention`/`me`). So `senderPhone` cannot reliably fix participant matching.
- The misroute is **intermittent / non-deterministic** across reconnects — it could not be reproduced on demand across multiple restart and session stop/start cycles.
- In normal operation, `pushName` is a **stable and highly distinct** identity signal per participant (observed: `ℒ𝒾𝓏𝑒𝓉𝒽 🩵🎀` vs `Doug`), making it a viable attribution anchor with low collision risk.

## Goals

1. A misrouted `@lid` author must never cause a translation to be silently dropped.
2. When attribution goes wrong (or a translate call fails), it must be observable in logs.
3. No regression to correct same-language behavior; no engine changes.

## Non-goals

- Engine/`@lid` resolution changes; enabling `RESOLVE_LID_TO_PHONE`.
- Media/caption translation.
- Multi-admin LID resolution.

## Design — defense in depth

The fix has two layers of different *kinds*, because the "pushName survives a misroute" assumption is unconfirmable by reproduction. Layer 1 is a precise best-effort fix; Layer 2 is a hard guarantee that holds regardless.

### 1. Record each participant's pushName

Add `pushName?: string` to `ParticipantState` (`core/ports.ts`). When a message is attributed to a participant, store/update its last-seen `pushName`. This adds a second identity signal alongside the `@lid` key. (`pushName` is on `InboundMessage` already.)

### 2. Sender reconciliation (primary fix)

A new `resolveSenderKey(state, msg)` step in the coordinator, run before language logic:

- Default to `msg.author`.
- If `msg.pushName` is present, find participants whose recorded `pushName` equals it.
  - If **exactly one** such participant exists and its key **differs** from `msg.author` (a genuine identity conflict — the `@lid` doesn't own this pushName) → attribute the message to that participant instead.
  - If **two or more** participants share the pushName (ambiguous) → no reconciliation; fall back to `msg.author` (logged at DEBUG).
- After resolution, record/refresh `pushName` on the resolved participant.

This recovers the true sender when wwebjs misroutes the `@lid` but keeps `pushName` correct.

**Known best-effort limitation:** if the *first* message after a misroute is itself misrouted before the correct `pushName→@lid` mapping was learned, reconciliation can briefly record a wrong pushName (self-correcting on the next correct message). Layer 2 covers delivery in that window.

### 3. Language backstop (no-lost-messages guarantee)

In `translateMessage`, after the existing strict target computation: if targets came out **empty** but
- detection succeeded, and
- the text passed the length / URL-or-emoji guards (a real translatable message), and
- at least one enabled participant speaks a language `!= source`,

then recompute targets as **all known languages except the source** and proceed. This guarantees delivery even if both `@lid` and `pushName` are corrupted, or if reconciliation misfires. If the backstop *also* yields nothing (everyone genuinely speaks the source language), that is a legitimate no-op (logged at DEBUG).

**Accepted tradeoff:** when a participant *deliberately* writes in another participant's language (legit cross-language), the backstop will post a (redundant) translation into the writer's own language rather than dropping it. This is acceptable per product decision ("much better than lost messages"); the owner/delegate `/tr` commands remain the manual lever.

### 4. Observability (via a logger port)

Add a minimal `TranslationLogger` interface to `core/ports.ts`, injected into `TranslationCoordinator` and implemented in `index.ts` over `context.logger` (keeps `core/` framework-agnostic). Emit:

- **WARN** — each `translate()` failure currently swallowed by `Promise.allSettled` (target lang + error). Closes the "translator outage looks identical to misroute" gap.
- **WARN** — backstop engaged (`author`, `pushName`, `source`, target langs) — a probable-misroute fingerprint.
- **INFO** — reconciliation applied (`author → resolvedKey`, `pushName`).
- **DEBUG** — full per-message decision (`author`, `pushName`, `detected`, `source`, `senderLang`, `knownLangs`, `targets`, resolution/backstop applied). Replaces the temporary `console.error` instrumentation, which is removed. This DEBUG line captures the next *natural* misroute for free.

## Affected files

- `core/ports.ts` — add `pushName?` to `ParticipantState`; add `TranslationLogger` interface.
- `core/translation.coordinator.ts` — `resolveSenderKey`, pushName recording, backstop, swallowed-failure + decision logging; coordinator constructor takes a `TranslationLogger`.
- `index.ts` — implement `TranslationLogger` over `context.logger`; pass it into the coordinator; remove temporary debug instrumentation.
- `core/translation.coordinator.spec.ts` — extend (TDD).

## Testing (TDD)

Unit tests in `core/translation.coordinator.spec.ts` (with fake `Translator`/`ConfigStore`/`ChatGateway`/`TranslationLogger`):

1. **Misroute + correct pushName** → message attributed to the true participant; translates to the correct target.
2. **Ambiguous pushName** (two participants share it) → no reconciliation; falls back to `@lid`.
3. **Cold-start misroute** (no recorded pushName yet) → reconciliation can't fire, but the **backstop** delivers (no silent drop).
4. **Backstop fires** on `source !== senderLang` with empty strict targets → produces a translation and logs WARN.
5. **Legit cross-language** (en speaker writes es) → backstop produces a (redundant, accepted) translation rather than dropping.
6. **Swallowed translate failure** → logged at WARN; other targets still delivered.
7. **Regression**: normal same-language case (Liz `es` → `en`) unchanged; pushName recorded.
8. **Genuine no-op**: everyone speaks the source language → no translation, DEBUG only, no WARN.

## Rollout

Implement on the PR #300 branch (`feat/whatsapp-translation-plugin`), TDD, then build + `npm test` + lint. The spec/plan docs live under `docs/superpowers/` (kept out of the PR, per existing convention).
