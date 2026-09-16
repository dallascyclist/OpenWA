// src/modules/translation/core/translation.coordinator.spec.ts
import { TranslationCoordinator, CoordinatorOptions, CoordinatorExtras } from './translation.coordinator';
import {
  ChatGateway,
  ConfigStore,
  GroupState,
  InboundMessage,
  Translator,
  TranslationLogger,
  ContextualTranslator,
  TranslateRequest,
} from './ports';
import { LibreTranslateContextual } from './libretranslate.contextual';
import { ConversationContext } from './conversation-context';

const OPTS: CoordinatorOptions = { prefix: '/tr', minLength: 2, maxLength: 2000, denyReply: false };

function freshState(over: Partial<GroupState> = {}): GroupState {
  return {
    sessionId: 's',
    chatId: 'g@g.us',
    active: false,
    participants: {},
    delegatedControllers: [],
    announced: false,
    ...over,
  };
}

function makeDeps(state: GroupState) {
  const saved: GroupState[] = [];
  const load = jest.fn().mockResolvedValue(state);
  const save = jest.fn().mockImplementation((s: GroupState) => {
    saved.push(JSON.parse(JSON.stringify(s)) as GroupState);
    return Promise.resolve();
  });
  const sendText = jest.fn().mockResolvedValue(undefined);
  const sendCombinedReply = jest.fn().mockResolvedValue(undefined);
  const getGroupAdmins = jest.fn().mockResolvedValue([]);
  const detect = jest.fn();
  const translate = jest.fn();
  const languages = jest.fn().mockResolvedValue(['en', 'es', 'fr']);
  const isHealthy = jest.fn().mockReturnValue(true);
  const debug = jest.fn();
  const info = jest.fn();
  const warn = jest.fn();

  const store: ConfigStore = { load, save };
  const gateway: ChatGateway = { sendText, sendCombinedReply, getGroupAdmins };
  const translator: Translator = { detect, translate, languages, isHealthy };
  const logger: TranslationLogger = { debug, info, warn };
  // The coordinator now speaks `ContextualTranslator`; the legacy detect/translate fake reaches it
  // through the same wrapper production uses, so `mocks.detect`/`mocks.translate` still drive it.
  const contextual: ContextualTranslator = new LibreTranslateContextual(translator, logger);
  const context = new ConversationContext({ maxTurns: 10, maxChars: 2000 });
  const extras: CoordinatorExtras = { context };

  return {
    store,
    gateway,
    translator: contextual,
    logger,
    context,
    extras,
    saved,
    mocks: {
      load,
      save,
      sendText,
      sendCombinedReply,
      getGroupAdmins,
      detect,
      translate,
      languages,
      isHealthy,
      debug,
      info,
      warn,
    },
  };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'M1',
    chatId: 'g@g.us',
    body: 'hello',
    author: '111@c.us',
    isGroup: true,
    fromMe: false,
    mentionedIds: [],
    ...over,
  };
}

describe('TranslationCoordinator', () => {
  it('ignores non-group and fromMe messages', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    expect(await c.handleMessage('s', msg({ isGroup: false }))).toEqual({ swallow: false });
    expect(await c.handleMessage('s', msg({ fromMe: true }))).toEqual({ swallow: false });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('announces once on first contact then stays dormant', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg());
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalled();
  });

  it('activates only for an admin', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    expect(res).toEqual({ swallow: true });
    expect(saved.at(-1)?.active).toBe(true);
  });

  it('rejects activation from a non-admin (silent by default)', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    expect(res).toEqual({ swallow: true });
    expect(saved.at(-1)?.active ?? false).toBe(false);
  });

  it('translates an active-group message into other participants languages (skipping the source)', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello' }));
    expect(res).toEqual({ swallow: false });
    expect(mocks.translate).toHaveBeenCalledWith('Hello', 'en', 'es');
    expect(mocks.sendCombinedReply).toHaveBeenCalledWith('s', 'g@g.us', 'M1', expect.stringContaining('Hola'));
  });

  it('falls back to the sender language and never translates into the source when detection misfires', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 3, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    // Detection misfires on colloquial Spanish, returning 'gl' — a language the group does not use.
    mocks.detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    mocks.translate.mockResolvedValue('Let me know');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '222@c.us', body: 'Haber dime que debo darte' }));
    // Effective source falls back to the sender's known 'es'; 'en' is the only target.
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate).toHaveBeenCalledWith('Haber dime que debo darte', 'es', 'en');
    // Must never translate a message into the sender's own language.
    expect(mocks.translate).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'es');
  });

  it('learns a sender language only after a 2-message debounce', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockResolvedValue('x');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    // First foreign detection: lang stays 'en'
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Bonjour' }));
    expect(saved.at(-1)?.participants['111@c.us'].lang).toBe('en');
    // Second consecutive foreign detection: switches to 'fr'
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Salut' }));
    expect(saved.at(-1)?.participants['111@c.us'].lang).toBe('fr');
  });

  it('skips trivial messages below minLength', async () => {
    const state = freshState({ announced: true, active: true });
    const { store, gateway, translator, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ body: '.' }));
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.sendCombinedReply).not.toHaveBeenCalled();
  });

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

  it('keeps every target on the message that confirms a learned-language switch', async () => {
    // Regression: on the flip message the sender's pending language is not yet in `knownLanguages`,
    // so without augmenting the provider request the wrapper translates FROM the stale hint and
    // never produces the other English speaker's copy, which `targetLanguages` still demands.
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '333@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, extras, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockImplementation((_text: string, src: string, tgt: string) => Promise.resolve(`${src}->${tgt}`));
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);

    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Bonjour' })); // arms pendingLang='fr'
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Salut' })); // confirms the switch

    const calls = mocks.sendCombinedReply.mock.calls as unknown[][];
    // First message: nothing learned yet, so the pre-flip behaviour is unchanged.
    expect(calls[0][3]).toBe('🇪🇸 ES: en->es');
    // Flip message: both remaining languages served, and translated FROM the confirmed language.
    const flip = calls[1][3] as string;
    expect(flip).toContain('fr->es');
    expect(flip).toContain('fr->en');
  });

  it('never delivers an unconfirmed pending language to the group', async () => {
    // The pending language is offered to the provider only. The backstop must keep using the
    // unaugmented known languages, or a guess nobody in the group speaks gets broadcast.
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, extras, mocks } = makeDeps(state);
    mocks.translate.mockImplementation((_text: string, src: string, tgt: string) => Promise.resolve(`${src}->${tgt}`));
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);

    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Bonjour' })); // arms pendingLang='fr'
    mocks.detect.mockResolvedValue({ lang: 'de', confidence: 0.99 });
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Guten Tag' }));

    // The group speaks only 'en'; 'fr' was never confirmed, so nothing is broadcast.
    expect(mocks.sendCombinedReply).not.toHaveBeenCalled();
  });

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
    const translateAll = jest.fn().mockResolvedValue({
      detected: 'es',
      source: 'es',
      translations: [{ lang: 'en', text: 'hi' }],
      provider: 'llm',
    });
    const fake: ContextualTranslator = {
      name: 'llm',
      external: true,
      translateAll,
      languages: mocks.languages,
      isHealthy: () => true,
    };
    context.append('s', 'g@g.us', { author: 'Doug', lang: 'en', text: 'earlier', at: 'x' });
    const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);

    await c.handleMessage('s', msg({ body: 'hola Doug', author: '111@c.us', pushName: 'Ana' }));

    expect(translateAll).toHaveBeenCalledTimes(1);
    const req = (translateAll.mock.calls as unknown[][])[0][0] as TranslateRequest;
    expect(req).toMatchObject({
      text: 'hola Doug',
      senderName: 'Ana',
      hintLang: 'es',
      allowExternal: true,
    });
    expect([...req.candidateLangs].sort()).toEqual(['en', 'es']);
    expect([...req.glossary].sort()).toEqual(['Ana', 'Doug']);
    expect(req.history.map(t => t.text)).toEqual(['earlier']);
    expect(mocks.sendCombinedReply).toHaveBeenCalledWith('s', 'g@g.us', 'M1', expect.stringContaining('hi'));
    // The current message joins the buffer only AFTER the round-trip, so it is never its own context.
    expect(context.get('s', 'g@g.us').map(t => t.text)).toEqual(['earlier', 'hola Doug']);
    expect(context.get('s', 'g@g.us')[1]).toMatchObject({ author: 'Ana', lang: 'es' });
  });

  it('records an ignored participant message in context without translating it', async () => {
    const state = freshState({
      active: true,
      announced: true,
      participants: {
        '111@c.us': { lang: 'es', source: 'learned', enabled: false, samples: 2, updatedAt: '' },
      },
    });
    const { store, gateway, translator, context, extras, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: 'hola', author: '111@c.us' }));
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(context.get('s', 'g@g.us')).toEqual([expect.objectContaining({ text: 'hola', lang: 'es' })]);
  });

  it('still records the turn (lang und) when the provider fails, and stays silent', async () => {
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
    // Sender speaks es; en is the only computed target (the ru participant is ignored, so ru is
    // neither a known language nor a target). The provider answers with en+ru anyway.
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
      detected: 'es',
      source: 'es',
      translations: [
        { lang: 'en', text: 'hi' },
        { lang: 'ru', text: 'privet' },
      ],
      provider: 'llm',
    });
    const fake: ContextualTranslator = {
      name: 'llm',
      external: true,
      translateAll,
      languages: mocks.languages,
      isHealthy: () => true,
    };
    const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: 'hola', author: '111@c.us' }));
    const sent = (mocks.sendCombinedReply.mock.calls as unknown[][])[0][3] as string;
    expect(sent).toContain('hi');
    expect(sent).not.toContain('privet');
  });

  it('reports provider health, privacy and participants on /tr status', async () => {
    const state = freshState({
      active: true,
      announced: true,
      participants: {
        '111@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, extras, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: '/tr status' }));
    const sent = (mocks.sendText.mock.calls as unknown[][])[0][2] as string;
    expect(sent).toContain('Translation: ACTIVE');
    // No `providerHealth` override: exercises the CoordinatorExtras fallback, which reports the
    // wired translator (the LibreTranslate wrapper) and therefore no LLM.
    expect(sent).toContain('AI translator: disabled');
    expect(sent).toContain('Basic translator (libretranslate): ok');
    expect(sent).toContain('Privacy: cloud (instance default)');
    expect(sent).toContain('• 111@c.us: es (pinned)');
  });

  it('reports the active model on /tr status when a model-switchable provider is configured', async () => {
    const state = freshState({ active: true, announced: true, privacy: 'cloud' });
    const { store, gateway, translator, context, mocks } = makeDeps(state);
    const extras: CoordinatorExtras = {
      context,
      models: { listModels: jest.fn().mockResolvedValue([]), currentModel: () => 'grok-4-fast', setModel: jest.fn() },
      providerHealth: () => [
        { name: 'llm', external: true, healthy: true },
        { name: 'libretranslate', external: false, healthy: false },
      ],
    };
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, undefined, extras);
    await c.handleMessage('s', msg({ body: '/tr status' }));
    const sent = (mocks.sendText.mock.calls as unknown[][])[0][2] as string;
    expect(sent).toContain('AI translator (grok-4-fast): ok');
    expect(sent).toContain('Basic translator (libretranslate): unreachable');
    expect(sent).toContain('Privacy: cloud (group override)');
  });

  describe('privacy', () => {
    it('forces allowExternal=false when the group is local', async () => {
      const state = freshState({ active: true, announced: true, privacy: 'local' });
      const { store, gateway, extras, mocks } = makeDeps(state);
      const translateAll = jest
        .fn()
        .mockResolvedValue({ detected: 'es', source: 'es', translations: [], provider: 'libretranslate' });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(fake, store, gateway, OPTS, undefined, extras);
      await c.handleMessage('s', msg({ body: 'hola' }));
      const req = (translateAll.mock.calls as unknown[][])[0][0] as TranslateRequest;
      expect(req.allowExternal).toBe(false);
    });

    it('uses the instance default when the group has no override', async () => {
      const state = freshState({ active: true, announced: true });
      const { store, gateway, extras, mocks } = makeDeps(state);
      const translateAll = jest
        .fn()
        .mockResolvedValue({ detected: 'es', source: 'es', translations: [], provider: 'libretranslate' });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(
        fake,
        store,
        gateway,
        { ...OPTS, defaultPrivacy: 'local' },
        undefined,
        extras,
      );
      await c.handleMessage('s', msg({ body: 'hola' }));
      const req = (translateAll.mock.calls as unknown[][])[0][0] as TranslateRequest;
      expect(req.allowExternal).toBe(false);
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
      const disclosures = () =>
        (mocks.sendText.mock.calls as unknown[][]).filter(call => /external AI/i.test(call[2] as string));
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
      const disclosures = () =>
        (mocks.sendText.mock.calls as unknown[][]).filter(call => /external AI/i.test(call[2] as string));
      await c.handleMessage('s', msg({ body: '/tr on' }));
      expect(disclosures()).toHaveLength(0);
      await c.handleMessage('s', msg({ body: '/tr privacy cloud' }));
      expect(disclosures()).toHaveLength(1);
    });
  });

  describe('health notices', () => {
    function healthDeps(state: GroupState) {
      const deps = makeDeps(state);
      const health = { llm: true, lt: true };
      const providerHealth = () => [
        { name: 'llm', external: true, healthy: health.llm },
        { name: 'libretranslate', external: false, healthy: health.lt },
      ];
      const translateAll = jest.fn().mockResolvedValue({
        detected: 'es',
        source: 'es',
        translations: [{ lang: 'en', text: 'hi' }],
        provider: 'llm',
      });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: deps.mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(fake, deps.store, deps.gateway, OPTS, undefined, {
        ...deps.extras,
        providerHealth,
      });
      const notices = () =>
        (deps.mocks.sendText.mock.calls as unknown[][])
          .map(call => call[2] as string)
          .filter(t => /AI translation/.test(t));
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
      expect(notices()).toEqual([
        '⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.',
      ]);
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
      const c = new TranslationCoordinator(
        deps.translator,
        deps.store,
        deps.gateway,
        { ...OPTS, operatorWids },
        undefined,
        {
          ...deps.extras,
          models,
          modelStore,
        },
      );
      return { c, mocks: deps.mocks, listModels, save, current: () => model };
    }

    it('denies non-operators, even group admins', async () => {
      const { c, mocks } = modelDeps(['999@c.us']);
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model list' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith(
        's',
        'g@g.us',
        '⛔ Only the instance operator can use that command.',
      );
    });

    it('shows the active model for an operator (device-suffixed author tolerated)', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model', author: '111:7@c.us' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', expect.stringContaining('grok-a'));
    });

    it('lists models with prices and the active marker', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model list' }));
      const out = (mocks.sendText.mock.calls as unknown[][])[mocks.sendText.mock.calls.length - 1][2] as string;
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
      const out = (mocks.sendText.mock.calls as unknown[][])[mocks.sendText.mock.calls.length - 1][2] as string;
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

    it('reports a catalog failure on list', async () => {
      const { c, mocks, listModels } = modelDeps(['111@c.us']);
      listModels.mockRejectedValue(new Error('HTTP 500'));
      await c.handleMessage('s', msg({ body: '/tr model list' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith('s', 'g@g.us', '⚠️ Model catalog unavailable right now.');
    });

    it('replies usage when switch has no id', async () => {
      const { c, mocks } = modelDeps(['111@c.us']);
      await c.handleMessage('s', msg({ body: '/tr model switch' }));
      expect(mocks.sendText).toHaveBeenLastCalledWith(
        's',
        'g@g.us',
        expect.stringContaining('Usage: /tr model switch <id>'),
      );
    });

    it('reports not configured when there is no switchable provider', async () => {
      const deps = makeDeps(freshState({ announced: true }));
      const c = new TranslationCoordinator(deps.translator, deps.store, deps.gateway, {
        ...OPTS,
        operatorWids: ['111@c.us'],
      });
      await c.handleMessage('s', msg({ body: '/tr model' }));
      expect(deps.mocks.sendText).toHaveBeenLastCalledWith(
        's',
        'g@g.us',
        'AI translator is not configured on this instance.',
      );
    });
  });

  describe('disclosure on the translate path', () => {
    const cloudActive = () =>
      freshState({
        active: true,
        announced: true,
        participants: {
          '111@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
          '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
        },
      });

    function translateDeps(state: GroupState) {
      const deps = makeDeps(state);
      const translateAll = jest.fn().mockResolvedValue({
        detected: 'es',
        source: 'es',
        translations: [{ lang: 'en', text: 'hi' }],
        provider: 'llm',
      });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: deps.mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(fake, deps.store, deps.gateway, OPTS, undefined, deps.extras);
      const disclosures = () =>
        (deps.mocks.sendText.mock.calls as unknown[][]).filter(call => /external AI/i.test(call[2] as string));
      return { c, translateAll, disclosures, mocks: deps.mocks, saved: deps.saved };
    }

    it('discloses to an already-active group on its next translated message, exactly once', async () => {
      const state = cloudActive();
      const { c, disclosures, saved } = translateDeps(state);
      await c.handleMessage('s', msg({ body: 'hola' }));
      expect(disclosures()).toHaveLength(1);
      expect(saved[saved.length - 1].privacyDisclosed).toBe(true);
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(disclosures()).toHaveLength(1);
    });

    it('discloses before the text is handed to the provider', async () => {
      const { c, translateAll, mocks } = translateDeps(cloudActive());
      await c.handleMessage('s', msg({ body: 'hola' }));
      const discloseOrder = mocks.sendText.mock.invocationCallOrder[0];
      expect(translateAll.mock.invocationCallOrder[0]).toBeGreaterThan(discloseOrder);
    });

    it('never discloses on the translate path in a local-only group', async () => {
      const { c, disclosures } = translateDeps({ ...cloudActive(), privacy: 'local' });
      await c.handleMessage('s', msg({ body: 'hola' }));
      expect(disclosures()).toHaveLength(0);
    });

    it('still discloses when the translation itself fails', async () => {
      const { c, translateAll, disclosures } = translateDeps(cloudActive());
      translateAll.mockRejectedValue(new Error('all providers down'));
      await c.handleMessage('s', msg({ body: 'hola' }));
      expect(disclosures()).toHaveLength(1);
    });

    it('retries the disclosure when the send fails, leaving the group undisclosed', async () => {
      const state = cloudActive();
      const { c, disclosures, mocks, saved } = translateDeps(state);
      mocks.sendText.mockImplementation((_s: string, _c: string, text: string) =>
        /external AI/i.test(text) ? Promise.reject(new Error('offline')) : Promise.resolve(undefined),
      );
      await expect(c.handleMessage('s', msg({ body: 'hola' }))).rejects.toThrow('offline');
      expect(state.privacyDisclosed).toBeUndefined();
      expect(saved.some(s => s.privacyDisclosed === true)).toBe(false);

      mocks.sendText.mockResolvedValue(undefined);
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(disclosures()).toHaveLength(2); // the failed attempt plus the retry
      expect(state.privacyDisclosed).toBe(true);
      expect(saved[saved.length - 1].privacyDisclosed).toBe(true);
    });
  });

  describe('health notices on the outage path', () => {
    function outageDeps(state: GroupState) {
      const deps = makeDeps(state);
      const health = { llm: true, lt: true };
      const providerHealth = () => [
        { name: 'llm', external: true, healthy: health.llm },
        { name: 'libretranslate', external: false, healthy: health.lt },
      ];
      const translateAll = jest.fn().mockResolvedValue({
        detected: 'es',
        source: 'es',
        translations: [{ lang: 'en', text: 'hi' }],
        provider: 'llm',
      });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: deps.mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(fake, deps.store, deps.gateway, OPTS, undefined, {
        ...deps.extras,
        providerHealth,
      });
      const notices = () =>
        (deps.mocks.sendText.mock.calls as unknown[][])
          .map(call => call[2] as string)
          .filter(t => /AI translation/.test(t));
      return { c, health, notices, translateAll };
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

    it('announces the outage when every provider fails, not just on the happy path', async () => {
      const { c, health, notices, translateAll } = outageDeps(active());
      await c.handleMessage('s', msg({ body: 'hola' })); // baseline, no notice
      expect(notices()).toEqual([]);
      health.llm = false;
      translateAll.mockRejectedValue(new Error('all providers down'));
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(notices()).toEqual([
        '⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.',
      ]);
    });

    it('stays silent about the outage in a local-only group', async () => {
      const { c, health, notices, translateAll } = outageDeps({ ...active(), privacy: 'local' });
      await c.handleMessage('s', msg({ body: 'hola' }));
      health.llm = false;
      translateAll.mockRejectedValue(new Error('all providers down'));
      await c.handleMessage('s', msg({ body: 'hola otra' }));
      expect(notices()).toEqual([]);
    });
  });

  describe('privacy switch and the conversation buffer', () => {
    function bufferDeps(state: GroupState) {
      const deps = makeDeps(state);
      const translateAll = jest.fn().mockResolvedValue({
        detected: 'es',
        source: 'es',
        translations: [{ lang: 'en', text: 'hi' }],
        provider: 'libretranslate',
      });
      const fake: ContextualTranslator = {
        name: 'chain',
        external: false,
        translateAll,
        languages: deps.mocks.languages,
        isHealthy: () => true,
      };
      const c = new TranslationCoordinator(fake, deps.store, deps.gateway, OPTS, undefined, deps.extras);
      const requestAt = (i: number) => (translateAll.mock.calls as unknown[][])[i][0] as TranslateRequest;
      return { c, requestAt, mocks: deps.mocks };
    }
    const localActive = () =>
      freshState({
        active: true,
        announced: true,
        privacy: 'local',
        participants: {
          '111@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
          '222@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: '' },
        },
      });

    it('does not ship the local-era history to the provider after switching to cloud', async () => {
      const { c, requestAt, mocks } = bufferDeps(localActive());
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      await c.handleMessage('s', msg({ body: 'hola' }));
      await c.handleMessage('s', msg({ body: 'que tal' }));
      // Guard against a vacuous assertion: the buffer really did fill up while the group was local.
      expect(requestAt(1).history.length).toBeGreaterThan(0);
      expect(requestAt(1).allowExternal).toBe(false);

      await c.handleMessage('s', msg({ body: '/tr privacy cloud' }));

      await c.handleMessage('s', msg({ body: 'hello again' }));
      expect(requestAt(2).allowExternal).toBe(true);
      expect(requestAt(2).history).toEqual([]);
    });

    it('also clears the buffer on a cloud to local switch', async () => {
      const { c, requestAt, mocks } = bufferDeps({ ...localActive(), privacy: 'cloud' });
      mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
      await c.handleMessage('s', msg({ body: 'hola' }));
      await c.handleMessage('s', msg({ body: 'que tal' }));
      expect(requestAt(1).history.length).toBeGreaterThan(0);

      await c.handleMessage('s', msg({ body: '/tr privacy local' }));

      await c.handleMessage('s', msg({ body: 'hello again' }));
      expect(requestAt(2).history).toEqual([]);
    });
  });
});
