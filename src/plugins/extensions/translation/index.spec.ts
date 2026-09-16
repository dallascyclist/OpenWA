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

function makeContext(config: Record<string, unknown>, storage: PluginStorage = makeStorage()): PluginContext {
  return {
    pluginId: 'translation',
    manifest: { id: 'translation' },
    config,
    hookManager: {},
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
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

  it('accepts operatorWids as a comma-separated string', async () => {
    const plugin = new TranslationPlugin();
    await plugin.onEnable(makeContext({ operatorWids: ' 111@c.us , 222@c.us ' }));
    const coordinator = (plugin as unknown as { coordinator: unknown }).coordinator;
    const opts = (coordinator as { opts: { operatorWids: string[] } }).opts;
    expect(opts.operatorWids).toEqual(['111@c.us', '222@c.us']);
  });
});
