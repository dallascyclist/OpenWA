// src/modules/translation/core/translation.coordinator.ts
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
import {
  buildDisclosureText,
  buildHelpText,
  formatCombinedReply,
  formatHealthNotice,
  formatModelList,
  formatPrivacy,
  formatStatus,
} from './reply.formatter';
import { ConversationContext } from './conversation-context';

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

const URL_OR_EMOJI_ONLY = /^(?:\s|\p{Emoji}|https?:\/\/\S+)+$/u;

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

/**
 * Compare two WhatsApp IDs tolerantly: exact match, or same user part ignoring
 * an `@domain` and any `:device` suffix (e.g. `123@c.us` === `123:7@c.us`).
 * Note: this does NOT bridge the LID (`@lid`) and phone (`@c.us`) namespaces —
 * those have different user numbers (see spec §16).
 */
function widEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const userPart = (w: string): string => w.split('@')[0].split(':')[0];
  return userPart(a) === userPart(b);
}

export class TranslationCoordinator {
  private readonly context: ConversationContext;
  private readonly extras: CoordinatorExtras;
  /**
   * Per group: the provider health we last told that group about (spec §11). Not persisted — one
   * entry per group seen since boot, dropped on restart, which is also what makes the
   * first-sighting baseline in `maybeNotifyHealth` work.
   */
  private readonly notifiedHealth = new Map<string, Map<string, boolean>>();

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

  async handleMessage(sessionId: string, msg: InboundMessage): Promise<{ swallow: boolean }> {
    if (!msg.isGroup || msg.fromMe || !msg.author) return { swallow: false };

    const state = await this.store.load(sessionId, msg.chatId);

    if (!state.announced) {
      await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      state.announced = true;
      await this.store.save(state);
    }

    const command = parseCommand(msg.body, this.opts.prefix);
    if (command) {
      await this.handleCommand(sessionId, msg, state, command);
      return { swallow: true };
    }

    if (!state.active) return { swallow: false };
    await this.translateMessage(sessionId, msg, state);
    return { swallow: false };
  }

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
    // A pending language is one confirmation away from becoming the sender's language, and
    // `applyLearning` may promote it the moment the provider answers. Offer it to the provider so
    // the message that CONFIRMS the switch is translated from the right language and into every
    // other language the group speaks — otherwise `targetLanguages` (which runs post-learning)
    // demands a target the provider was never asked for, and that recipient silently gets nothing.
    // Deliberately scoped to the request: the sanity rule and backstop below recompute the group's
    // known languages after learning and never see this augmentation, so an unconfirmed guess can
    // never become the effective source.
    const candidateLangs =
      sender.pendingLang && !knownLangs.includes(sender.pendingLang)
        ? [...knownLangs, sender.pendingLang]
        : [...knownLangs];

    const request: TranslateRequest = {
      text,
      senderName: authorName,
      candidateLangs,
      hintLang: sender.lang,
      glossary: this.glossary(state, msg.pushName),
      history: this.context.get(sessionId, msg.chatId),
      allowExternal: this.effectivePrivacy(state).mode === 'cloud',
    };

    // Disclose BEFORE the text can reach an external provider. `/tr on` and `/tr privacy cloud`
    // cover groups that opt in from here on; this covers the groups that were already active when
    // cloud translation arrived, which would otherwise be processed externally having never been
    // told. Deliberately placed ahead of `translateAll` rather than beside `maybeNotifyHealth`
    // below: every post-translate site is reachable only past an early return that a failed or
    // target-less translation takes, and `privacyDisclosed` keeps it to once per group regardless.
    if (request.allowExternal) await this.discloseIfNeeded(sessionId, state);

    let result: TranslateResult;
    try {
      result = await this.translator.translateAll(request);
    } catch (err) {
      // A provider failure is still a silent skip, as before, but the turn counts for context.
      this.logger.warn('translation failed on all providers', {
        action: 'translation_all_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      this.remember(sessionId, msg.chatId, authorName, sender.lang ?? 'und', text);
      // A total outage is exactly when the group most needs to know why the bot went quiet, so the
      // notice must not be confined to the happy path. `maybeNotifyHealth` keeps its own local-only
      // suppression, so a local group still hears nothing about the external provider.
      await this.maybeNotifyHealth(sessionId, state);
      await this.store.save(state);
      return;
    }

    this.applyLearning(sender, result.detected);

    // Recompute the group's languages AFTER learning. `applyLearning` may have just moved the
    // sender onto a new language, which both adds that language and — when the sender was the last
    // speaker of their old one — removes the old one from the group's set. The sanity rule and the
    // backstop below must reason about the group as it is now: using the pre-learning array here
    // makes the message that CONFIRMS a language switch get translated into the language the group
    // has just abandoned (the backstop sees a stale entry, so it fires instead of staying silent),
    // and logs a misleading `translation_backstop` warning while doing it. The pre-learning array
    // above stays as it is — it feeds `candidateLangs`, which must describe the group as it was
    // when the provider was asked.
    const knownLangsNow = this.knownLanguages(state);

    // Pick the effective source language. Detection misfires on short/colloquial text — it often
    // returns a near-neighbour language (e.g. es misread as gl/ca) — so trust the detected code only
    // when it names a language the group actually uses; otherwise fall back to the sender's known
    // language. Combined with excluding the sender's own language from the targets below, this stops
    // a message ever being "translated" into its own language (the duplicate/echo bug).
    const source = knownLangsNow.includes(result.detected) ? result.detected : (sender.lang ?? result.detected);

    let targets = this.targetLanguages(state, source, sender.lang);
    if (targets.length === 0) {
      // Backstop: a real message detected in a known language must never be silently dropped due
      // to a sender/source mismatch (e.g. a misrouted @lid author keyed to the wrong participant).
      // Translate into every known language except the source — guarantees delivery.
      const backstop = knownLangsNow.filter(l => l !== source);
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
      knownLangs: knownLangsNow,
      targets,
      sent: translations.length,
      provider: result.provider,
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.maybeNotifyHealth(sessionId, state);
    await this.store.save(state);
  }

  /**
   * Announce a provider health transition once per group, lazily on that group's next translated
   * message (spec §11). The first sighting of a group since boot only records a baseline, so a
   * restart never greets every group with a spurious "recovered" notice.
   *
   * Ordering: record the transition FIRST, then send. This is deliberately the opposite of
   * `discloseIfNeeded`, and the two must not be "made consistent" with each other. This is a
   * non-persisted convenience notice, so the failure to err away from is a repeat storm — every
   * subsequent message re-announcing the same outage. Losing one notice to a failed send is cheap;
   * the next transition still reports. `discloseIfNeeded` is a compliance notice and errs the other
   * way. See its docblock.
   */
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
      // Record the transition even when the notice is suppressed below, so a local-only group
      // never hears a stale "recovered" the moment it switches to cloud.
      known.set(p.name, p.healthy);
      if (p.external && privacy.mode === 'local') continue;
      await this.gateway.sendText(sessionId, state.chatId, formatHealthNotice(p));
    }
  }

  private remember(sessionId: string, chatId: string, author: string, lang: string, text: string): void {
    this.context.append(sessionId, chatId, { author, lang, text, at: new Date().toISOString() });
  }

  /** Participant display names the provider must carry through untranslated. */
  private glossary(state: GroupState, current?: string): string[] {
    const names = Object.values(state.participants).map(p => p.pushName);
    names.push(current);
    return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))];
  }

  private effectivePrivacy(state: GroupState): EffectivePrivacy {
    if (state.privacy) return { mode: state.privacy, source: 'group' };
    return { mode: this.opts.defaultPrivacy ?? 'cloud', source: 'instance' };
  }

  private providerHealth(): ProviderHealth[] {
    if (this.extras.providerHealth) return this.extras.providerHealth();
    return [{ name: this.translator.name, external: this.translator.external, healthy: this.translator.isHealthy() }];
  }

  /** Distinct languages currently spoken by enabled participants. */
  private knownLanguages(state: GroupState): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang) langs.add(p.lang);
    }
    return [...langs];
  }

  /**
   * Distinct languages of enabled participants, excluding the message source language AND the
   * sender's own language — a sender never needs their own message translated back to themselves
   * (this also guards against a detection misfire leaving the source language in the target set).
   */
  private targetLanguages(state: GroupState, source: string, senderLang: string | null): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang && p.lang !== source && p.lang !== senderLang) langs.add(p.lang);
    }
    return [...langs];
  }

  /** 2-message debounce: a learned language only switches after a new language is seen twice in a row. */
  private applyLearning(p: ParticipantState, detected: string): void {
    p.samples++;
    if (p.source === 'pinned') return;
    if (p.lang === detected) {
      p.pendingLang = undefined;
      return;
    }
    if (p.pendingLang === detected) {
      p.lang = detected;
      p.pendingLang = undefined;
    } else {
      p.pendingLang = detected;
      if (p.lang === null) p.lang = detected; // cold start: adopt immediately
    }
    p.updatedAt = new Date().toISOString();
  }

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

  private ensureParticipant(state: GroupState, wid: string): ParticipantState {
    if (!state.participants[wid]) {
      state.participants[wid] = { lang: null, source: 'learned', enabled: true, samples: 0, updatedAt: '' };
    }
    return state.participants[wid];
  }

  private async handleCommand(
    sessionId: string,
    msg: InboundMessage,
    state: GroupState,
    cmd: ParsedCommand,
  ): Promise<void> {
    if (cmd.name === 'help') {
      await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      return;
    }
    if (cmd.name === 'status') {
      await this.gateway.sendText(
        sessionId,
        msg.chatId,
        formatStatus(state, this.providerHealth(), this.effectivePrivacy(state), this.extras.models?.currentModel()),
      );
      return;
    }
    // The *show* form of `privacy` is open to anyone; only the *set* form is admin-gated below.
    if (cmd.name === 'privacy' && !cmd.privacy) {
      await this.gateway.sendText(sessionId, msg.chatId, formatPrivacy(this.effectivePrivacy(state), this.opts.prefix));
      return;
    }
    // `model` is instance-wide, not group-scoped: it answers to the operator allow-list only, so
    // this gate deliberately sits BEFORE the group admin gate — a group admin is not an operator.
    if (cmd.name === 'model') {
      const isOperator = (this.opts.operatorWids ?? []).some(w => widEquals(w, msg.author));
      if (!isOperator) {
        await this.gateway.sendText(sessionId, msg.chatId, '⛔ Only the instance operator can use that command.');
        return;
      }
      await this.handleModelCommand(sessionId, msg, cmd);
      return;
    }

    const targetsSelf = cmd.target?.kind === 'me';
    const isSelfServe = (cmd.name === 'setlang' || cmd.name === 'auto') && targetsSelf;
    if (!isSelfServe) {
      const admins = await this.gateway.getGroupAdmins(sessionId, msg.chatId);
      const isAdmin = admins.some(a => widEquals(a, msg.author));
      const isController = isAdmin || state.delegatedControllers.some(c => widEquals(c, msg.author));
      const adminOnly = cmd.name === 'grant' || cmd.name === 'revoke';
      if ((adminOnly && !isAdmin) || (!adminOnly && !isController)) {
        // Always reply on denial — a command must never fail silently.
        await this.gateway.sendText(
          sessionId,
          msg.chatId,
          adminOnly
            ? '⛔ Only group admins can use that command.'
            : '⛔ Only group admins or delegated users can use that command.',
        );
        return;
      }
    }

    const targetWid = this.resolveTarget(msg, cmd.target);

    switch (cmd.name) {
      case 'on':
        state.active = true;
        await this.confirm(sessionId, msg, '✅ Translation activated.', state);
        await this.discloseIfNeeded(sessionId, state);
        return;
      case 'off':
        state.active = false;
        // Drop the buffered conversation: it must not leak into a later re-activation.
        this.context.clear(sessionId, msg.chatId);
        await this.confirm(sessionId, msg, '✅ Translation deactivated.', state);
        return;
      case 'setlang': {
        if (!targetWid || !cmd.lang)
          return this.replyError(sessionId, msg, 'Usage: ' + this.opts.prefix + ' setlang <code> [me|@user|number]');
        const langs = await this.safeLanguages();
        if (langs && !langs.includes(cmd.lang)) {
          return this.replyError(sessionId, msg, `Unsupported language "${cmd.lang}". Supported: ${langs.join(', ')}`);
        }
        const p = this.ensureParticipant(state, targetWid);
        p.lang = cmd.lang;
        p.source = 'pinned';
        p.pendingLang = undefined;
        p.updatedAt = new Date().toISOString();
        await this.confirm(sessionId, msg, `✅ Set ${targetWid} to ${cmd.lang}.`, state);
        return;
      }
      case 'auto': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.source = 'learned';
        p.pendingLang = undefined;
        await this.confirm(sessionId, msg, `✅ ${targetWid} set to auto-detect.`, state);
        return;
      }
      case 'ignore':
      case 'unignore': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.enabled = cmd.name === 'unignore';
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'ignore' ? 'Ignoring' : 'Including'} ${targetWid}.`,
          state,
        );
        return;
      }
      case 'grant':
      case 'revoke': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const set = new Set(state.delegatedControllers);
        if (cmd.name === 'grant') set.add(targetWid);
        else set.delete(targetWid);
        state.delegatedControllers = [...set];
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'grant' ? 'Granted' : 'Revoked'} control for ${targetWid}.`,
          state,
        );
        return;
      }
      case 'privacy': {
        state.privacy = cmd.privacy; // non-undefined here: the show form returned earlier
        // Drop the buffered conversation: turns spoken under the previous privacy mode must not
        // cross the boundary. Going local->cloud this is the whole point — the last ten turns were
        // spoken while the group had explicitly opted out of external processing, and they would
        // otherwise ship to the provider as `history` on the very next message. The disclosure does
        // not cover them: it says messages *will be* sent, not that already-spoken ones are about
        // to be. Cleared unconditionally rather than only on the flip to cloud: dropping history on
        // cloud->local costs nothing and leaves no branch here to get wrong later.
        this.context.clear(sessionId, msg.chatId);
        await this.confirm(sessionId, msg, `✅ Privacy set to ${cmd.privacy} for this group.`, state);
        await this.discloseIfNeeded(sessionId, state);
        return;
      }
    }
  }

  /**
   * Post the cloud disclosure once per group, only when cloud translation is in effect (spec §10).
   *
   * Two conditions, not one. Cloud privacy mode alone is not enough: the disclosure is a compliance
   * statement that messages may be sent to an external AI service, and the chain only contains an
   * external provider when the operator has enabled one (`llmEnabled` plus an API key). With the
   * shipped default the chain is LibreTranslate alone, and a cloud-mode group — which is every group,
   * since `defaultPrivacy` is `cloud` — would otherwise be told its messages leave the instance when
   * nothing external exists to send them to. A false compliance statement is worse than none, so the
   * notice tracks what the chain can actually do.
   *
   * Ordering: send FIRST, then mark the group disclosed and persist. This is deliberately the
   * opposite of `maybeNotifyHealth`, and the two must not be "made consistent" with each other.
   * This is a compliance notice, so the failure to err away from is under-disclosing: persisting
   * first would let one failed send permanently silence a notice the group never received. Leaving
   * the flag unset means the next message retries, at worst costing a duplicate. `maybeNotifyHealth`
   * is a non-persisted convenience notice and errs the other way. See its docblock.
   */
  private async discloseIfNeeded(sessionId: string, state: GroupState): Promise<void> {
    if (state.privacyDisclosed || this.effectivePrivacy(state).mode !== 'cloud') return;
    if (!this.providerHealth().some(p => p.external)) return;
    await this.gateway.sendText(sessionId, state.chatId, buildDisclosureText(this.opts.prefix));
    state.privacyDisclosed = true;
    await this.store.save(state);
  }

  /** `/tr model [list|switch <id>]` — operator-only; the caller has already checked the allow-list. */
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
        this.logger.warn('model catalog unavailable', {
          action: 'translation_model_catalog_failed',
          error: String(err),
        });
        await this.replyError(sessionId, msg, '⚠️ Model catalog unavailable right now.');
      }
      return;
    }

    // switch
    const id = cmd.modelId;
    if (!id) return this.replyError(sessionId, msg, `Usage: ${this.opts.prefix} model switch <id>`);

    // A null catalog means "could not verify", which is NOT the same as "not in the catalog":
    // an unreachable provider must never turn a valid id into a rejection.
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
    this.logger.info('model switched', {
      action: 'translation_model_switched',
      model: id,
      by: msg.author,
      verified: catalog !== null,
    });
    await this.gateway.sendText(
      sessionId,
      msg.chatId,
      catalog
        ? `✅ Model switched to ${id}.`
        : `✅ Model switched to ${id} (catalog unavailable, switched unverified).`,
    );
  }

  private resolveTarget(msg: InboundMessage, target?: CommandTarget): string | null {
    if (!target || target.kind === 'me') return msg.author;
    if (target.kind === 'mention') return msg.mentionedIds[0] ?? null;
    // NOTE: a `<number>` target assumes phone-number JID keying (`<number>@c.us`). Under
    // WhatsApp's newer LID scheme participants may be keyed by an opaque `@lid` id instead,
    // so this constructed wid can fail to match the stored participant. The `@mention` and
    // `me` forms resolve to the actual wid and are robust to LID; prefer them. See spec §16.
    return `${target.number}@c.us`;
  }

  private async safeLanguages(): Promise<string[] | null> {
    try {
      return await this.translator.languages();
    } catch {
      return null; // can't validate — allow
    }
  }

  private async confirm(sessionId: string, msg: InboundMessage, text: string, state: GroupState): Promise<void> {
    await this.store.save(state);
    await this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private replyError(sessionId: string, msg: InboundMessage, text: string): Promise<void> {
    return this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private targetHelp(): string {
    return "⚠️ Couldn't identify that user. Target them by @mention, by phone number, or use 'me' for yourself.";
  }
}
