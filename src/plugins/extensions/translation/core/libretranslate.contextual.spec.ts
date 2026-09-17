// src/plugins/extensions/translation/core/libretranslate.contextual.spec.ts
import { LibreTranslateContextual } from './libretranslate.contextual';
import { TranslateRequest, Translator } from './ports';

function fakeTranslator() {
  const detect = jest.fn();
  const translate = jest.fn();
  const languages = jest.fn().mockResolvedValue(['en', 'es']);
  const isHealthy = jest.fn().mockReturnValue(true);
  const t: Translator = { detect, translate, languages, isHealthy };
  return { t, detect, translate, languages, isHealthy };
}

const req = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  text: 'hola',
  senderName: 'Ana',
  candidateLangs: ['en', 'es', 'ru'],
  hintLang: 'es',
  glossary: [],
  history: [],
  allowExternal: true,
  ...over,
});

describe('LibreTranslateContextual', () => {
  it('is a local provider named libretranslate', () => {
    const { t } = fakeTranslator();
    const p = new LibreTranslateContextual(t);
    expect(p.name).toBe('libretranslate');
    expect(p.external).toBe(false);
  });

  it('detects, then translates into every candidate except the source', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'es', confidence: 0.9 });
    translate.mockImplementation((_q: string, _s: string, target: string) => Promise.resolve(`[${target}]`));
    const out = await new LibreTranslateContextual(t).translateAll(req());
    expect(out).toEqual({
      detected: 'es',
      source: 'es',
      translations: [
        { lang: 'en', text: '[en]' },
        { lang: 'ru', text: '[ru]' },
      ],
      provider: 'libretranslate',
    });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenCalledWith('hola', 'es', 'en');
  });

  it('applies the sanity rule: unknown detection falls back to hintLang but detected is reported raw', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    translate.mockResolvedValue('x');
    const out = await new LibreTranslateContextual(t).translateAll(
      req({ candidateLangs: ['en', 'es'], hintLang: 'es' }),
    );
    expect(out.detected).toBe('gl');
    expect(out.source).toBe('es');
    expect(translate).toHaveBeenCalledWith('hola', 'es', 'en');
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('uses the raw detection when there is no hint', async () => {
    const { t, detect, translate } = fakeTranslator();
    detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    translate.mockResolvedValue('x');
    const out = await new LibreTranslateContextual(t).translateAll(req({ candidateLangs: ['en'], hintLang: null }));
    expect(out.source).toBe('gl');
    expect(translate).toHaveBeenCalledWith('hola', 'gl', 'en');
  });

  it('keeps successful targets when one translate call fails and warns', async () => {
    const { t, detect, translate } = fakeTranslator();
    const warn = jest.fn();
    detect.mockResolvedValue({ lang: 'es', confidence: 0.9 });
    translate.mockImplementation((_q: string, _s: string, target: string) =>
      target === 'ru' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
    );
    const out = await new LibreTranslateContextual(t, { debug: jest.fn(), info: jest.fn(), warn }).translateAll(req());
    expect(out.translations).toEqual([{ lang: 'en', text: 'ok' }]);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'translation_translate_failed', target: 'ru' }),
    );
  });

  it('propagates a detect failure', async () => {
    const { t, detect } = fakeTranslator();
    detect.mockRejectedValue(new Error('down'));
    await expect(new LibreTranslateContextual(t).translateAll(req())).rejects.toThrow('down');
  });

  it('delegates languages() and isHealthy()', async () => {
    const { t, isHealthy } = fakeTranslator();
    isHealthy.mockReturnValue(false);
    const p = new LibreTranslateContextual(t);
    expect(await p.languages()).toEqual(['en', 'es']);
    expect(p.isHealthy()).toBe(false);
  });
});
