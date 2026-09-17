import { ProviderRefusedError, AllProvidersFailedError } from './errors';

describe('translation errors', () => {
  it('ProviderRefusedError is an Error with a stable name', () => {
    const e = new ProviderRefusedError('missing target en');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProviderRefusedError');
    expect(e.message).toBe('missing target en');
  });

  it('AllProvidersFailedError carries per-provider reasons', () => {
    const e = new AllProvidersFailedError(['llm: HTTP 500', 'libretranslate: circuit open']);
    expect(e.name).toBe('AllProvidersFailedError');
    expect(e.reasons).toEqual(['llm: HTTP 500', 'libretranslate: circuit open']);
    expect(e.message).toContain('llm: HTTP 500');
  });
});
