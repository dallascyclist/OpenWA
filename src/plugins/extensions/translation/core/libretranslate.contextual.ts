// src/plugins/extensions/translation/core/libretranslate.contextual.ts
// Adapts the legacy detect/translate `Translator` port to `ContextualTranslator` (spec §4, §6).
// Reproduces the coordinator's former behaviour: detect, sanity-check the source against the
// group's languages (falling back to the sender's known language), fan out per target.
import {
  ContextualTranslator,
  Translation,
  TranslateRequest,
  TranslateResult,
  TranslationLogger,
  Translator,
} from './ports';

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

export class LibreTranslateContextual implements ContextualTranslator {
  readonly name = 'libretranslate';
  readonly external = false;

  constructor(
    private readonly inner: Translator,
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}

  isHealthy(): boolean {
    return this.inner.isHealthy();
  }

  languages(): Promise<string[]> {
    return this.inner.languages();
  }

  async translateAll(req: TranslateRequest): Promise<TranslateResult> {
    const detected = (await this.inner.detect(req.text)).lang;
    const source = req.candidateLangs.includes(detected) ? detected : (req.hintLang ?? detected);
    const targets = req.candidateLangs.filter(l => l !== source);
    const settled = await Promise.allSettled(targets.map(t => this.inner.translate(req.text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        translations.push({ lang: targets[i], text: r.value });
      } else {
        this.logger.warn('translate call failed', {
          action: 'translation_translate_failed',
          source,
          target: targets[i],
          error: String(r.reason),
        });
      }
    });
    return { detected, source, translations, provider: this.name };
  }
}
