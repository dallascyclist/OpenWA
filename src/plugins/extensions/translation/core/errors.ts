// src/plugins/extensions/translation/core/errors.ts
// Framework-free error types shared by providers and the fallback chain.

/** A provider answered but declined or mangled the job (content refusal, missing target). Never counts toward a circuit breaker. */
export class ProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRefusedError';
  }
}

/** Every provider in the chain failed for this request. */
export class AllProvidersFailedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`all translation providers failed: ${reasons.join('; ')}`);
    this.name = 'AllProvidersFailedError';
  }
}
