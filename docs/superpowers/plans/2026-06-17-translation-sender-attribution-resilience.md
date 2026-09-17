# Translation Sender-Attribution Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make group auto-translation resilient to whatsapp-web.js misrouting a message's `@lid` author after a reconnect, so a misrouted sender's messages are never silently dropped, and make attribution/skip decisions observable.

**Architecture:** Two defense-in-depth layers inside the translation plugin core. (1) *pushName reconciliation* — record each participant's last-seen pushName and, when an `@lid` author conflicts with a uniquely-matching pushName, attribute to the real sender. (2) *Language backstop* — if strict target selection comes out empty on a real message, translate into all known languages except the source, guaranteeing delivery even if reconciliation can't help. Plus a logging port so swallowed `translate()` failures and skip decisions are visible.

**Tech Stack:** TypeScript (strict), NestJS 11 host, Jest. The translation `core/` is framework-agnostic.

## Global Constraints

- `src/plugins/extensions/translation/core/` MUST stay framework-agnostic: **no** imports from NestJS, TypeORM, the engine, or the host. Only relative imports within `core/` and the ports it defines.
- No path aliases anywhere — relative imports only (`./core/ports`, etc.).
- Strict TypeScript: `strictNullChecks`, `noImplicitAny` on. No `any`; use `unknown` + narrowing.
- Core logging goes through the injected `TranslationLogger` port — never `console.*`, never the host `Logger`, in `core/`.
- The plugin boundary (`index.ts`) adapts the host `PluginLogger` (methods: `log`, `debug`, `warn`, `error(msg, error?, meta?)`) to `TranslationLogger` (`debug`/`info`/`warn`). Map `info → log`.
- Tests are colocated `*.spec.ts`; run with `npm test`. Lint with `npm run lint`; format check `npm run format -- --check`. All must pass.
- Commit identity is `dallascyclist` (repo-local git config already set). Conventional-commit messages.
- Development happens on `_local-test-combined` (where the docs, combined test env, and running server live). Implementation commits are cherry-picked onto `feat/whatsapp-translation-plugin` (PR #300) at the end — the plugin files are identical on both branches, so cherry-pick applies cleanly. The `docs/superpowers/` files stay out of PR #300 (existing convention).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/plugins/extensions/translation/core/ports.ts` | Framework-agnostic contracts | Add `pushName?` to `ParticipantState`; add `TranslationLogger` interface |
| `src/plugins/extensions/translation/core/translation.coordinator.ts` | Decision engine | `resolveSenderKey`, safe pushName recording, language backstop, swallowed-failure + decision logging; logger constructor param |
| `src/plugins/extensions/translation/index.ts` | Plugin boundary / DI | Adapt host logger → `TranslationLogger`, inject into coordinator; (temp debug already removed in Task 0) |
| `src/plugins/extensions/translation/core/translation.coordinator.spec.ts` | Unit tests | Add logger to `makeDeps`; add reconciliation/backstop/observability/regression tests |

---

### Task 0: Branch prep & discard temporary instrumentation

**Files:**
- Modify (revert): `src/plugins/extensions/translation/core/translation.coordinator.ts`, `src/plugins/extensions/translation/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a clean working tree on `_local-test-combined` with the committed PR #300 plugin code (no `TR-DEBUG` / `console.error` instrumentation).

- [ ] **Step 1: Confirm the only uncommitted changes are the temp debug edits**

Run: `git status --short`
Expected: exactly two modified files — `.../core/translation.coordinator.ts` and `.../index.ts`. (If anything else is modified, stop and report.)

- [ ] **Step 2: Discard the temporary debug instrumentation**

```bash
git restore src/plugins/extensions/translation/core/translation.coordinator.ts \
            src/plugins/extensions/translation/index.ts
```

- [ ] **Step 3: Verify the temp instrumentation is gone**

Run: `git status --short && grep -rn "TR-DEBUG" src/plugins/extensions/translation || echo "clean"`
Expected: clean working tree; `clean` printed (no `TR-DEBUG` matches).

- [ ] **Step 4: Confirm baseline build + tests pass**

Run: `npm run build && npm test -- src/plugins/extensions/translation`
Expected: build succeeds; existing translation specs pass.

No commit (revert only).

---

### Task 1: Add `pushName` to state + `TranslationLogger` port + safe recording

**Files:**
- Modify: `src/plugins/extensions/translation/core/ports.ts`
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Modify: `src/plugins/extensions/translation/index.ts`
- Test: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`

**Interfaces:**
- Produces:
  - `ParticipantState.pushName?: string`
  - `interface TranslationLogger { debug(message: string, meta?: Record<string, unknown>): void; info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void }`
  - `TranslationCoordinator` constructor gains a 5th param `logger: TranslationLogger = NOOP_LOGGER`.
  - Coordinator records `msg.pushName` onto the sender participant **only when** the participant has no recorded pushName yet or it already equals `msg.pushName` (never overwrites a differing value).

- [ ] **Step 1: Add the logger fields to the test harness and write the failing pushName-recording test**

In `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`, update the import line and `makeDeps`, then add the test.

Change the import at the top:

```typescript
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator, TranslationLogger } from './ports';
```

In `makeDeps`, add three spies and the logger (insert after the `isHealthy` line, and extend the returned object):

```typescript
  const isHealthy = jest.fn().mockReturnValue(true);
  const debug = jest.fn();
  const info = jest.fn();
  const warn = jest.fn();

  const store: ConfigStore = { load, save };
  const gateway: ChatGateway = { sendText, sendCombinedReply, getGroupAdmins };
  const translator: Translator = { detect, translate, languages, isHealthy };
  const logger: TranslationLogger = { debug, info, warn };

  return {
    store,
    gateway,
    translator,
    logger,
    saved,
    mocks: { load, save, sendText, sendCombinedReply, getGroupAdmins, detect, translate, languages, isHealthy, debug, info, warn },
  };
```

Add a new test inside the `describe`:

```typescript
  it('records the sender pushName on a translated message', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, logger, saved, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello', pushName: 'Doug' }));
    expect(saved.at(-1)?.participants['111@c.us'].pushName).toBe('Doug');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "records the sender pushName"`
Expected: FAIL (`pushName` is `undefined` — the field isn't recorded yet).

- [ ] **Step 3: Add the `pushName` field and `TranslationLogger` port to `ports.ts`**

In `src/plugins/extensions/translation/core/ports.ts`, add `pushName?` to `ParticipantState`:

```typescript
export interface ParticipantState {
  lang: string | null; // null = not learned yet
  source: 'learned' | 'pinned';
  enabled: boolean;
  samples: number;
  /** Candidate language awaiting a 2nd consecutive detection before a learned switch. */
  pendingLang?: string;
  updatedAt: string;
  /** Last-seen WhatsApp pushName; a secondary identity anchor used to reconcile a misrouted
   * @lid author back to the real sender. */
  pushName?: string;
}
```

At the end of the file, add the logger port:

```typescript
/**
 * Structured logging port for the translation core. Implemented at the plugin boundary over the
 * host's PluginLogger; declared here so `core/` stays framework-agnostic.
 */
export interface TranslationLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}
```

- [ ] **Step 4: Wire the logger into the coordinator and record pushName safely**

In `src/plugins/extensions/translation/core/translation.coordinator.ts`:

Add `TranslationLogger` to the `./ports` import list. After the `URL_OR_EMOJI_ONLY` constant, add a no-op default:

```typescript
const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };
```

Change the constructor to accept the logger:

```typescript
  constructor(
    private readonly translator: Translator,
    private readonly store: ConfigStore,
    private readonly gateway: ChatGateway,
    private readonly opts: CoordinatorOptions,
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}
```

In `translateMessage`, replace the sender line:

```typescript
    const sender = this.ensureParticipant(state, msg.author);
    if (!sender.enabled) return;
```

with:

```typescript
    const sender = this.ensureParticipant(state, msg.author);
    // Record the pushName, but never overwrite a different existing value (a misrouted message
    // could otherwise poison the identity anchor).
    if (msg.pushName && (sender.pushName === undefined || sender.pushName === msg.pushName)) {
      sender.pushName = msg.pushName;
    }
    if (!sender.enabled) return;
```

- [ ] **Step 5: Adapt the host logger in `index.ts` and inject it**

In `src/plugins/extensions/translation/index.ts`, add `TranslationLogger` to the `./core/ports` import:

```typescript
import { InboundMessage, TranslationLogger } from './core/ports';
```

In `buildCoordinator`, build the adapter and pass it as the 5th arg (replace the final `return`):

```typescript
    const logger: TranslationLogger = {
      debug: (m, meta) => context.logger.debug(m, meta),
      info: (m, meta) => context.logger.log(m, meta),
      warn: (m, meta) => context.logger.warn(m, meta),
    };
    return new TranslationCoordinator(translator, store, gateway, opts, logger);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "records the sender pushName"`
Expected: PASS.

- [ ] **Step 7: Run the full translation suite + build to confirm no regression**

Run: `npm test -- src/plugins/extensions/translation && npm run build`
Expected: all translation specs PASS; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/plugins/extensions/translation/core/ports.ts \
        src/plugins/extensions/translation/core/translation.coordinator.ts \
        src/plugins/extensions/translation/index.ts \
        src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): record participant pushName + add TranslationLogger port"
```

---

### Task 2: pushName-based sender reconciliation

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Test: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`

**Interfaces:**
- Consumes: `ParticipantState.pushName`, `TranslationLogger` (Task 1).
- Produces: `private resolveSenderKey(state: GroupState, msg: InboundMessage): string` — returns the participant key to attribute the message to (the `@lid` author, or a reconciled key). Used by `translateMessage`.

- [ ] **Step 1: Write the failing reconciliation tests**

Add to the spec:

```typescript
  it('reconciles a misrouted @lid author via a uniquely-matching pushName', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'liz@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Lizeth' },
        'doug@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Doug' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('I feel sick');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    // Liz's Spanish message is misrouted to Doug's @lid, but the pushName is still Liz's.
    await c.handleMessage('s', msg({ author: 'doug@lid', pushName: 'Lizeth', body: 'Me siento mal' }));
    expect(mocks.translate).toHaveBeenCalledWith('Me siento mal', 'es', 'en');
    expect(mocks.sendCombinedReply).toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      'sender reconciled by pushName',
      expect.objectContaining({ resolvedKey: 'liz@lid' }),
    );
  });

  it('does not reconcile when the author already owns the pushName', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'a@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('hi');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'a@lid', pushName: 'Sam', body: 'Hola amigo' }));
    expect(mocks.info).not.toHaveBeenCalledWith('sender reconciled by pushName', expect.anything());
    // a@lid (es) wrote es -> target en (attributed to the author, not reconciled to b).
    expect(mocks.translate).toHaveBeenCalledWith('Hola amigo', 'es', 'en');
  });

  it('does not reconcile when the pushName is ambiguous across participants', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'x@lid': { lang: 'fr', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Xavier' },
        'a@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockResolvedValue('x');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    // Author x@lid (Xavier); message pushName 'Sam' matches TWO other participants -> ambiguous.
    await c.handleMessage('s', msg({ author: 'x@lid', pushName: 'Sam', body: 'Bonjour tout le monde' }));
    expect(mocks.info).not.toHaveBeenCalledWith('sender reconciled by pushName', expect.anything());
    expect(mocks.debug).toHaveBeenCalledWith(
      'ambiguous pushName; not reconciling',
      expect.objectContaining({ author: 'x@lid' }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "reconcile"`
Expected: the "reconciles a misrouted" test FAILS (translate called with wrong source/`es`→ no `en`, and `info` not called). The other two may pass incidentally; that's fine.

- [ ] **Step 3: Implement `resolveSenderKey` and use it**

In `translation.coordinator.ts`, change the sender line in `translateMessage`:

```typescript
    const sender = this.ensureParticipant(state, msg.author);
```

to use the resolved key:

```typescript
    const senderKey = this.resolveSenderKey(state, msg);
    const sender = this.ensureParticipant(state, senderKey);
```

(Leave the pushName-recording block from Task 1 immediately below it; it now records onto the resolved `sender`.)

Add the method (place it just above `ensureParticipant`):

```typescript
  /**
   * Resolve which participant a message belongs to. whatsapp-web.js can misroute a group message's
   * `@lid` author after a reconnect; when the message's pushName uniquely identifies a DIFFERENT
   * known participant (and the author doesn't already own that pushName), trust the pushName.
   * Ambiguous (shared pushName) or no-match cases fall back to the raw author.
   */
  private resolveSenderKey(state: GroupState, msg: InboundMessage): string {
    const { author, pushName } = msg;
    if (!pushName) return author;
    // No conflict if the author already owns this pushName.
    if (state.participants[author]?.pushName === pushName) return author;
    const matches = Object.keys(state.participants).filter(
      key => key !== author && state.participants[key].pushName === pushName,
    );
    if (matches.length === 1) {
      this.logger.info('sender reconciled by pushName', {
        action: 'translation_sender_reconciled',
        author,
        resolvedKey: matches[0],
        pushName,
      });
      return matches[0];
    }
    if (matches.length > 1) {
      this.logger.debug('ambiguous pushName; not reconciling', {
        action: 'translation_pushname_ambiguous',
        author,
        pushName,
        matches,
      });
    }
    return author;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "reconcile"`
Expected: all three reconciliation tests PASS.

- [ ] **Step 5: Run the full translation suite**

Run: `npm test -- src/plugins/extensions/translation`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts \
        src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): reconcile misrouted @lid author via pushName"
```

---

### Task 3: Language backstop (no-silent-drop guarantee)

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Test: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`

**Interfaces:**
- Consumes: `knownLanguages`, `targetLanguages`, `TranslationLogger`.
- Produces: changed `translateMessage` behavior — when strict `targets` is empty on a real message, fall back to all known languages except `source` (logging a WARN); only a group that speaks solely the source language is a genuine no-op (DEBUG).

- [ ] **Step 1: Write the failing backstop tests**

```typescript
  it('engages the backstop instead of dropping when source != senderLang', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'liz@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Lizeth' },
        'doug@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Doug' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    // Worst case: misrouted to Doug AND pushName also corrupted -> reconciliation can't help.
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('I feel sick');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'doug@lid', pushName: 'Doug', body: 'Me siento mal' }));
    expect(mocks.warn).toHaveBeenCalledWith(
      'target backstop engaged (possible misroute or cross-language write)',
      expect.objectContaining({ source: 'es' }),
    );
    expect(mocks.translate).toHaveBeenCalledWith('Me siento mal', 'es', 'en');
    expect(mocks.sendCombinedReply).toHaveBeenCalled();
  });

  it('does not warn or translate when the group speaks only the source language', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'a@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'A' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'B' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'a@lid', pushName: 'A', body: 'Hello there' }));
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.sendCombinedReply).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "backstop|only the source language"`
Expected: "engages the backstop" FAILS (no translate, no warn — currently the empty-targets branch returns silently).

- [ ] **Step 3: Implement the backstop**

In `translateMessage`, replace the strict empty-targets branch:

```typescript
    const targets = this.targetLanguages(state, source, sender.lang);
    if (targets.length === 0) {
      await this.store.save(state);
      return;
    }
```

with (note `const` → `let`):

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "backstop|only the source language"`
Expected: both PASS.

- [ ] **Step 5: Run the full translation suite**

Run: `npm test -- src/plugins/extensions/translation`
Expected: all PASS (including the existing "skipping the source" and "detection misfires" tests, which still produce non-empty strict targets and never hit the backstop).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts \
        src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): language backstop so misrouted messages are never dropped"
```

---

### Task 4: Observability — surface swallowed translate failures + decision log

**Files:**
- Modify: `src/plugins/extensions/translation/core/translation.coordinator.ts`
- Test: `src/plugins/extensions/translation/core/translation.coordinator.spec.ts`

**Interfaces:**
- Consumes: `TranslationLogger`, `senderKey` (Task 2), `knownLangs`, `detected`, `source`, `targets`, `translations`.
- Produces: a WARN per failed `translate()` call (`action: 'translation_translate_failed'`) and one DEBUG decision log per processed message (`action: 'translation_decision'`).

- [ ] **Step 1: Write the failing observability tests**

```typescript
  it('warns on a failed translate call and still delivers the successful targets', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        's1@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S1' },
        's2@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S2' },
        's3@lid': { lang: 'fr', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S3' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockImplementation((_t: string, _s: string, target: string) =>
      target === 'fr' ? Promise.reject(new Error('boom')) : Promise.resolve('Hola'),
    );
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 's1@lid', pushName: 'S1', body: 'Hello everyone' }));
    expect(mocks.warn).toHaveBeenCalledWith('translate call failed', expect.objectContaining({ target: 'fr' }));
    expect(mocks.sendCombinedReply).toHaveBeenCalledWith('s', 'g@g.us', 'M1', expect.stringContaining('Hola'));
  });

  it('emits a decision debug log for each translated message', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x', pushName: 'D' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x', pushName: 'L' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: '111@c.us', pushName: 'D', body: 'Hello' }));
    expect(mocks.debug).toHaveBeenCalledWith(
      'translate decision',
      expect.objectContaining({ detected: 'en', source: 'en', sent: 1 }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "failed translate|decision debug"`
Expected: both FAIL (no `warn` for the failed call; no `debug` 'translate decision').

- [ ] **Step 3: Add the failure WARN and the decision DEBUG log**

In `translateMessage`, replace the settle/collect block:

```typescript
    const settled = await Promise.allSettled(targets.map(t => this.translator.translate(text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') translations.push({ lang: targets[i], text: r.value });
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
```

with:

```typescript
    const settled = await Promise.allSettled(targets.map(t => this.translator.translate(text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        translations.push({ lang: targets[i], text: r.value });
      } else {
        this.logger.warn('translate call failed', {
          action: 'translation_translate_failed',
          source,
          target: targets[i],
          error: String((r as PromiseRejectedResult).reason),
        });
      }
    });

    this.logger.debug('translate decision', {
      action: 'translation_decision',
      author: msg.author,
      resolvedKey: senderKey,
      pushName: msg.pushName,
      detected,
      source,
      senderLang: sender.lang,
      knownLangs,
      targets,
      sent: translations.length,
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/plugins/extensions/translation/core/translation.coordinator.spec.ts -t "failed translate|decision debug"`
Expected: both PASS.

- [ ] **Step 5: Run the full translation suite, build, lint, and format check**

Run: `npm test -- src/plugins/extensions/translation && npm run build && npm run lint && npm run format -- --check`
Expected: all PASS; lint clean; format check passes. (If prettier flags formatting, run `npm run format` and re-stage.)

- [ ] **Step 6: Commit**

```bash
git add src/plugins/extensions/translation/core/translation.coordinator.ts \
        src/plugins/extensions/translation/core/translation.coordinator.spec.ts
git commit -m "feat(translation): log swallowed translate failures + per-message decision"
```

---

### Task 5: Integration verify, restart live server, ship to PR #300

**Files:** none (build/run/git only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a running server on the new build; the four implementation commits cherry-picked onto `feat/whatsapp-translation-plugin` and pushed (PR #300 updated).

- [ ] **Step 1: Full backend test suite + build**

Run: `npm test && npm run build`
Expected: full suite PASS; build succeeds. (If unrelated pre-existing failures appear, note them and continue — do not fix out-of-scope code.)

- [ ] **Step 2: Restart the live server on the new build**

The dev server runs `node dist/main.js` (logs → `/tmp/owa-api.log`). Stop the current instance and relaunch:

```bash
lsof -nP -iTCP:2785 -sTCP:LISTEN -t | xargs -I{} kill {} 2>/dev/null
NODE_ENV=development AUTO_START_SESSIONS=true SIMULATE_TYPING_MAX_MS=1500 PORT=2785 node dist/main.js > /tmp/owa-api.log 2>&1 &
```

Wait for readiness:
Run: `curl -s -o /dev/null -w "%{http_code}\n" --retry 30 --retry-delay 1 --retry-connrefused --max-time 90 http://localhost:2785/api/docs`
Expected: `200`. Confirm `Session ready` appears: `grep "Session ready" /tmp/owa-api.log | tail -1`.

- [ ] **Step 3: Re-enable the plugin if needed and do a live sanity check**

Run: `curl -s -X POST -H "X-API-Key: $(cat data/.api-key)" http://localhost:2785/api/plugins/translation/enable`
Expected: `{"success":true,...}`. Then ask the operator to send one normal foreign-language message in the test group; confirm a translation is posted and a structured `translation_decision` DEBUG line appears: `grep "translate decision\|translation_decision" /tmp/owa-api.log | tail -1`.

- [ ] **Step 4: Switch gh to the right account and cherry-pick onto the PR #300 branch**

```bash
gh auth switch --user dallascyclist
git log --oneline -4   # note the 4 implementation commit SHAs (Tasks 1-4), oldest-first
git checkout feat/whatsapp-translation-plugin
git pull --ff-only      # sync with the PR head if a remote is tracked
git cherry-pick <task1-sha> <task2-sha> <task3-sha> <task4-sha>
```
Expected: cherry-picks apply cleanly (plugin files are identical across branches). If a conflict appears, stop and report — do not force.

- [ ] **Step 5: Build on the PR branch, push, return**

```bash
npm run build
git push
git checkout _local-test-combined
```
Expected: build succeeds; push updates `feat/whatsapp-translation-plugin` (PR #300). Confirm: `gh pr view 300 --json headRefOid,url`.

- [ ] **Step 6: Final report**

Summarize: tests passing, server restarted on the new build, live sanity check result, PR #300 updated (link). Note that the new DEBUG `translation_decision` / WARN `translation_backstop` logs will capture the next *natural* misroute for confirmation.

---

## Self-Review

**Spec coverage:**
- pushName field + recording → Task 1 ✓
- TranslationLogger port + boundary adapter → Task 1 ✓
- Sender reconciliation (conflict-only, ambiguity guard) → Task 2 ✓
- Language backstop (incl. genuine no-op) → Task 3 ✓
- WARN on swallowed translate failures → Task 4 ✓
- DEBUG decision log + temp-instrumentation removal → Task 0 (removal) + Task 4 (decision log) ✓
- Tests: misroute, author-owns-pushName, ambiguous, backstop, no-op, swallowed failure, decision log, pushName recording, plus existing regression specs → Tasks 1-4 ✓
- Plugin-only scope, no engine changes; land on PR #300 → Task 5 ✓
- Spec test #1 "misroute + correct pushName" = Task 2 test 1; #5 "legit cross-language" is covered behaviorally by Task 3's backstop test (same code path: empty strict targets → backstop) ✓

**Placeholder scan:** none — every code/command step has concrete content.

**Type consistency:** `TranslationLogger { debug, info, warn }` defined in Task 1, consumed verbatim in Tasks 1-4 and the `index.ts` adapter (`info → log`). `resolveSenderKey(state, msg): string` defined and used (`senderKey`) consistently in Tasks 2 & 4. `ParticipantState.pushName?` defined Task 1, used Tasks 1-4. Log message strings are identical between the implementation and the test assertions (`'sender reconciled by pushName'`, `'ambiguous pushName; not reconciling'`, `'target backstop engaged (possible misroute or cross-language write)'`, `'translate call failed'`, `'translate decision'`, `'no targets; group speaks only the source language'`).
