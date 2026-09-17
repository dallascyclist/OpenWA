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
