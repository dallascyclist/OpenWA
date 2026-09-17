import { TranslationPlugin } from './index';
import { ConversationContext } from './core/conversation-context';
import { ProviderHealth } from './core/ports';
import { PluginContext, PluginStorage } from '../../../core/plugins';

/**
 * A lightweight fake PluginContext. Only the surface `buildCoordinator` actually touches is real
 * (config, logger, storage); the messaging/engine capabilities are never called during wiring, so
 * empty stand-ins are enough.
 */
function makeStorage(seed: Record<string, unknown> = {}): PluginStorage {
  const kv = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T = unknown>(key: string) => Promise.resolve((kv.get(key) ?? null) as T | null),
    set: <T = unknown>(key: string, value: T) => {
      kv.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      kv.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...kv.keys()]),
  };
}

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeContext(
  config: Record<string, unknown>,
  storage: PluginStorage = makeStorage(),
  logger: ReturnType<typeof makeLogger> = makeLogger(),
): PluginContext {
  return {
    pluginId: 'translation',
    manifest: { id: 'translation' },
    config,
    hookManager: {},
    logger,
    storage,
    registerHook: () => {},
    messages: {},
    engine: {},
  } as unknown as PluginContext;
}

/** The private wiring state we need to observe; reading it keeps the test free of network calls. */
function retainedContext(plugin: TranslationPlugin): ConversationContext {
  return (plugin as unknown as { context: ConversationContext }).context;
}
function providerHealth(plugin: TranslationPlugin): ProviderHealth[] {
  const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
  const extras = (coordinator as { extras: { providerHealth?: () => ProviderHealth[] } }).extras;
  return extras.providerHealth!();
}
function activeModel(plugin: TranslationPlugin): string | undefined {
  const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
  const extras = (coordinator as { extras: { models?: { currentModel(): string } } }).extras;
  return extras.models?.currentModel();
}

function turn(text: string) {
  return { author: 'alice', lang: 'en', text, at: '2026-09-16T00:00:00.000Z' };
}

describe('TranslationPlugin wiring', () => {
  describe('llmEnabled=false (shipped default)', () => {
    it('builds a chain with LibreTranslate as the only provider, and no external one', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({}));

      const health = providerHealth(plugin);
      expect(health.map(p => p.name)).toEqual(['libretranslate']);
      expect(health.some(p => p.external)).toBe(false);
      expect(activeModel(plugin)).toBeUndefined();
    });

    it('keeps the LLM out even when an API key is configured', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmApiKey: 'sk-test' }));
      expect(providerHealth(plugin).map(p => p.name)).toEqual(['libretranslate']);
    });

    it('keeps the LLM out when enabled but no API key is configured', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true }));
      expect(providerHealth(plugin).map(p => p.name)).toEqual(['libretranslate']);
    });
  });

  describe('llmEnabled=true with a key', () => {
    it('puts the LLM first, ahead of LibreTranslate', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true, llmApiKey: 'sk-test' }));
      expect(providerHealth(plugin).map(p => p.name)).toEqual(['llm', 'libretranslate']);
    });

    it('uses the configured model when nothing is persisted', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true, llmApiKey: 'sk-test', llmModel: 'grok-configured' }));
      expect(activeModel(plugin)).toBe('grok-configured');
    });

    it('lets a persisted /tr model switch override the configured model', async () => {
      const storage = makeStorage({
        'llm:model': { model: 'grok-persisted', updatedAt: '2026-09-16T00:00:00.000Z', updatedBy: 'op@c.us' },
      });
      const plugin = new TranslationPlugin();
      await plugin.onEnable(
        makeContext({ llmEnabled: true, llmApiKey: 'sk-test', llmModel: 'grok-configured' }, storage),
      );
      expect(activeModel(plugin)).toBe('grok-persisted');
    });

    it('falls back to the configured model rather than passing a blank persisted one', async () => {
      const storage = makeStorage({
        'llm:model': { model: '', updatedAt: '2026-09-16T00:00:00.000Z', updatedBy: 'op@c.us' },
      });
      const plugin = new TranslationPlugin();
      await plugin.onEnable(
        makeContext({ llmEnabled: true, llmApiKey: 'sk-test', llmModel: 'grok-configured' }, storage),
      );
      expect(activeModel(plugin)).toBe('grok-configured');
    });
  });

  describe('conversation context across rebuilds', () => {
    it('survives an ordinary config edit', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ libretranslateUrl: 'http://a:5000' }));
      retainedContext(plugin).append('s1', 'g1', turn('remembered'));

      await plugin.onConfigChange(makeContext({ libretranslateUrl: 'http://b:5000' }));

      expect(
        retainedContext(plugin)
          .get('s1', 'g1')
          .map(t => t.text),
      ).toEqual(['remembered']);
    });

    it('survives a cloud -> local privacy tightening', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: 'cloud' }));
      retainedContext(plugin).append('s1', 'g1', turn('remembered'));

      await plugin.onConfigChange(makeContext({ defaultPrivacy: 'local' }));

      expect(retainedContext(plugin).get('s1', 'g1')).toHaveLength(1);
    });

    it('is dropped when the instance default flips local -> cloud', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: 'local' }));
      retainedContext(plugin).append('s1', 'g1', turn('spoken while opted out'));

      await plugin.onConfigChange(makeContext({ defaultPrivacy: 'cloud' }));

      expect(retainedContext(plugin).get('s1', 'g1')).toEqual([]);
    });

    it('is rebuilt when contextTurns changes, so the new limit actually takes effect', async () => {
      // `maxTurns` is fixed at construction, so without a rebuild a dashboard edit would be inert
      // until someone toggled the plugin.
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ contextTurns: 10 }));
      retainedContext(plugin).append('s1', 'g1', turn('stale'));

      await plugin.onConfigChange(makeContext({ contextTurns: 1 }));

      expect(retainedContext(plugin).get('s1', 'g1')).toEqual([]);
      retainedContext(plugin).append('s1', 'g1', turn('one'));
      retainedContext(plugin).append('s1', 'g1', turn('two'));
      expect(
        retainedContext(plugin)
          .get('s1', 'g1')
          .map(t => t.text),
      ).toEqual(['two']);
    });

    it('is kept when contextTurns is unchanged', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ contextTurns: 5 }));
      retainedContext(plugin).append('s1', 'g1', turn('remembered'));

      await plugin.onConfigChange(makeContext({ contextTurns: 5, libretranslateUrl: 'http://b:5000' }));

      expect(retainedContext(plugin).get('s1', 'g1')).toHaveLength(1);
    });

    it('hands the coordinator the same context instance the plugin retains', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({}));
      const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
      expect((coordinator as { context: ConversationContext }).context).toBe(retainedContext(plugin));
    });
  });

  // A privacy control that fails open is the wrong direction: an operator who typed `Local` asked
  // for LESS external processing and would silently get more. The enum in the config schema closes
  // the realistic path in; the warning covers whatever still gets through (API clients, the
  // generated `.env`, a hand-edited store).
  describe('defaultPrivacy misconfiguration', () => {
    it('warns, naming the value and the mode it fell back to, on an unrecognised value', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: 'Local' }, makeStorage(), logger));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('defaultPrivacy'),
        expect.objectContaining({ action: 'translation_privacy_unrecognised', value: 'Local', fallback: 'cloud' }),
      );
    });

    it('warns on a value that is only off by whitespace', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: 'local ' }, makeStorage(), logger));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ value: 'local ', fallback: 'cloud' }),
      );
    });

    it('still falls back to cloud, so the fallback direction is unchanged', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: 'Local' }));
      const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
      expect((coordinator as { opts: { defaultPrivacy: string } }).opts.defaultPrivacy).toBe('cloud');
    });

    it.each([['local'], ['cloud']])('stays quiet on the valid value %s', async value => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ defaultPrivacy: value }, makeStorage(), logger));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stays quiet when the key is absent entirely', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({}, makeStorage(), logger));
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // If the dashboard re-posts an untouched password field as '', the LLM drops out of the chain
  // and translation silently degrades to LibreTranslate. Make that greppable.
  describe('llmEnabled without a usable API key', () => {
    it('warns that LibreTranslate alone will be used', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true }, makeStorage(), logger));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/API key/i),
        expect.objectContaining({ action: 'translation_llm_no_key' }),
      );
    });

    it('warns the same way when the key is posted back as an empty string', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true, llmApiKey: '' }, makeStorage(), logger));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ action: 'translation_llm_no_key' }),
      );
    });

    it('stays quiet when the key is present', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: true, llmApiKey: 'sk-test' }, makeStorage(), logger));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stays quiet when the AI translator is simply off', async () => {
      const logger = makeLogger();
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({ llmEnabled: false, llmApiKey: '' }, makeStorage(), logger));
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // The loader fire-and-forgets `onConfigChange` with `void`, so a rejection there becomes an
  // unhandled rejection and can take the process down.
  describe('a failing rebuild', () => {
    function brokenStorage(): PluginStorage {
      return { ...makeStorage(), get: () => Promise.reject(new Error('storage exploded')) };
    }

    it('does not reject out of onConfigChange; it logs instead', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({}));
      const logger = makeLogger();

      await expect(
        plugin.onConfigChange(makeContext({ llmEnabled: true, llmApiKey: 'sk-test' }, brokenStorage(), logger)),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Error),
        expect.objectContaining({ action: 'translation_rebuild_failed' }),
      );
    });

    it('keeps the previous working coordinator rather than going dark', async () => {
      const plugin = new TranslationPlugin();
      await plugin.onEnable(makeContext({}));
      const before = (plugin as unknown as { coordinator: unknown }).coordinator;

      await plugin.onConfigChange(makeContext({ llmEnabled: true, llmApiKey: 'sk-test' }, brokenStorage()));

      expect((plugin as unknown as { coordinator: unknown }).coordinator).toBe(before);
    });

    it('still rethrows from onEnable, so the loader can mark the plugin ERROR', async () => {
      const plugin = new TranslationPlugin();
      const logger = makeLogger();
      await expect(
        plugin.onEnable(makeContext({ llmEnabled: true, llmApiKey: 'sk-test' }, brokenStorage(), logger)),
      ).rejects.toThrow('storage exploded');
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Error),
        expect.objectContaining({ action: 'translation_rebuild_failed' }),
      );
    });
  });

  it('accepts operatorWids as a comma-separated string', async () => {
    const plugin = new TranslationPlugin();
    await plugin.onEnable(makeContext({ operatorWids: ' 111@c.us , 222@c.us ' }));
    const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
    const opts = (coordinator as { opts: { operatorWids: string[] } }).opts;
    expect(opts.operatorWids).toEqual(['111@c.us', '222@c.us']);
  });
});
