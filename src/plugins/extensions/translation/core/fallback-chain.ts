// src/plugins/extensions/translation/core/fallback-chain.ts
// Ordered provider chain (spec §8): first provider that answers wins. External providers are skipped
// when the request forbids them. Health is never used to skip: an open circuit throws instantly
// inside the provider and the provider's own cooldown is what lets it recover.
import { AllProvidersFailedError, ProviderRefusedError } from './errors';
import { ContextualTranslator, ProviderHealth, TranslateRequest, TranslateResult, TranslationLogger } from './ports';

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

export class FallbackChain implements ContextualTranslator {
  readonly name = 'chain';
  readonly external = false;

  constructor(
    private readonly providers: ContextualTranslator[],
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}

  async translateAll(req: TranslateRequest): Promise<TranslateResult> {
    const reasons: string[] = [];
    for (const p of this.providers) {
      if (p.external && !req.allowExternal) continue;
      try {
        return await p.translateAll(req);
      } catch (err) {
        const refused = err instanceof ProviderRefusedError;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn('translation provider failed; trying next', {
          action: 'translation_provider_failed',
          provider: p.name,
          refused,
          reason,
        });
        reasons.push(`${p.name}: ${reason}`);
      }
    }
    throw new AllProvidersFailedError(reasons);
  }

  isHealthy(): boolean {
    return this.providers.some(p => p.isHealthy());
  }

  async languages(): Promise<string[]> {
    const pick = this.providers.find(p => !p.external && p.isHealthy()) ?? this.providers.find(p => p.isHealthy());
    if (!pick) throw new Error('no healthy translation provider');
    return pick.languages();
  }

  providerHealth(): ProviderHealth[] {
    return this.providers.map(p => ({ name: p.name, external: p.external, healthy: p.isHealthy() }));
  }
}
