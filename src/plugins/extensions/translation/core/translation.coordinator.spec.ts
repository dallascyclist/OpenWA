// src/modules/translation/core/translation.coordinator.spec.ts
import { TranslationCoordinator, CoordinatorOptions } from './translation.coordinator';
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator, TranslationLogger } from './ports';

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

  return {
    store,
    gateway,
    translator,
    logger,
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
});
