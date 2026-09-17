// src/plugins/extensions/translation/plugin-model.store.ts
import { ModelSelection, ModelStore } from './core/ports';
import { PluginStorage } from '../../../core/plugins';

const KEY = 'llm:model';

/**
 * Persists the operator's runtime model choice (`/tr model switch`) in plugin KV storage so it
 * survives restarts and the VM's post-boot config re-PUT (spec §11a).
 */
export class PluginModelStore implements ModelStore {
  constructor(private readonly storage: PluginStorage) {}

  load(): Promise<ModelSelection | null> {
    return this.storage.get<ModelSelection>(KEY);
  }

  save(sel: ModelSelection): Promise<void> {
    return this.storage.set(KEY, sel);
  }
}
