// src/plugins/extensions/translation/core/fallback-chain.spec.ts
import { FallbackChain } from './fallback-chain';
import { AllProvidersFailedError, ProviderRefusedError } from './errors';
import { ContextualTranslator, TranslateRequest, TranslateResult } from './ports';

function provider(name: string, external: boolean) {
  const translateAll = jest.fn<Promise<TranslateResult>, [TranslateRequest]>();
  const languages = jest.fn().mockResolvedValue([name]);
  const isHealthy = jest.fn().mockReturnValue(true);
  const p: ContextualTranslator = { name, external, translateAll, languages, isHealthy };
  return { p, translateAll, languages, isHealthy };
}

const ok = (provider: string): TranslateResult => ({
  detected: 'es',
  source: 'es',
  translations: [{ lang: 'en', text: 'hi' }],
  provider,
});
const req = (allowExternal = true): TranslateRequest => ({
  text: 'hola',
  senderName: 'A',
  candidateLangs: ['en', 'es'],
  hintLang: 'es',
  glossary: [],
  history: [],
  allowExternal,
});

describe('FallbackChain', () => {
  it('returns the first provider result', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.translateAll.mockResolvedValue(ok('llm'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req());
    expect(out.provider).toBe('llm');
    expect(lt.translateAll).not.toHaveBeenCalled();
  });

  it('skips external providers when allowExternal is false', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req(false));
    expect(out.provider).toBe('libretranslate');
    expect(llm.translateAll).not.toHaveBeenCalled();
  });

  it('falls through on a throw and logs it, flagging refusals', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    const warn = jest.fn();
    llm.translateAll.mockRejectedValue(new ProviderRefusedError('missing target en'));
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p], { debug: jest.fn(), info: jest.fn(), warn }).translateAll(req());
    expect(out.provider).toBe('libretranslate');
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'translation_provider_failed', provider: 'llm', refused: true }),
    );
  });

  it('does NOT skip an unhealthy provider (its own circuit throws fast)', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.isHealthy.mockReturnValue(false);
    llm.translateAll.mockRejectedValue(new Error('LLM circuit open'));
    lt.translateAll.mockResolvedValue(ok('libretranslate'));
    const out = await new FallbackChain([llm.p, lt.p]).translateAll(req());
    expect(llm.translateAll).toHaveBeenCalledTimes(1);
    expect(out.provider).toBe('libretranslate');
  });

  it('throws AllProvidersFailedError with every reason when all fail', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.translateAll.mockRejectedValue(new Error('HTTP 500'));
    lt.translateAll.mockRejectedValue(new Error('down'));
    const chain = new FallbackChain([llm.p, lt.p]);
    await expect(chain.translateAll(req())).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(chain.translateAll(req())).rejects.toThrow(/llm: .*HTTP 500.*libretranslate: .*down/);
  });

  it('providerHealth() reports each provider by polling isHealthy()', () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    llm.isHealthy.mockReturnValue(false);
    expect(new FallbackChain([llm.p, lt.p]).providerHealth()).toEqual([
      { name: 'llm', external: true, healthy: false },
      { name: 'libretranslate', external: false, healthy: true },
    ]);
  });

  it('isHealthy() is true if any provider is healthy; languages() prefers a healthy local provider', async () => {
    const llm = provider('llm', true);
    const lt = provider('libretranslate', false);
    const chain = new FallbackChain([llm.p, lt.p]);
    expect(chain.isHealthy()).toBe(true);
    expect(await chain.languages()).toEqual(['libretranslate']);
    lt.isHealthy.mockReturnValue(false);
    expect(await chain.languages()).toEqual(['llm']);
    llm.isHealthy.mockReturnValue(false);
    expect(chain.isHealthy()).toBe(false);
    await expect(chain.languages()).rejects.toThrow('no healthy translation provider');
  });
});
