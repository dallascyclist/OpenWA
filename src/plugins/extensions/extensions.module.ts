import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { PluginLoaderService, PluginManifest, PluginType } from '../../core/plugins';
import { AutoReplyPlugin } from './auto-reply';
import { TranslationPlugin } from './translation';
import { createLogger } from '../../common/services/logger.service';

/**
 * Registers first-party built-in EXTENSION plugins with the (global) PluginLoaderService.
 * Mirrors EngineFactory's registration pattern so src/core never imports a concrete plugin.
 * Built-in extensions are registered DISABLED; operators enable them via POST /plugins/:id/enable.
 */
@Injectable()
export class ExtensionsRegistrar implements OnModuleInit {
  private readonly logger = createLogger('ExtensionsRegistrar');

  constructor(private readonly pluginLoader: PluginLoaderService) {}

  onModuleInit(): void {
    const autoReplyManifest: PluginManifest = {
      id: 'auto-reply',
      name: 'Auto Reply (reference)',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      description: 'Reference extension plugin: replies to inbound direct messages. Disabled by default.',
      main: 'index.ts',
      permissions: ['messages:send'],
      sessions: ['*'],
    };

    this.pluginLoader.registerBuiltInPlugin(autoReplyManifest, new AutoReplyPlugin());
    this.logger.log('Auto-reply reference plugin registered (disabled)');

    const translationManifest: PluginManifest = {
      id: 'translation',
      name: 'Group Auto-Translation',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      description:
        "Auto-translates group messages between participants' languages via an AI translator (Grok by default) with a LibreTranslate fallback. Configure in-group with /tr commands. Disabled by default.",
      main: 'index.ts',
      permissions: ['messages:send'],
      sessions: ['*'],
      // Exposed via GET /plugins so the dashboard renders an editable config form (URL + API key, etc.).
      configSchema: {
        type: 'object',
        properties: {
          libretranslateUrl: {
            type: 'string',
            title: 'LibreTranslate URL',
            description:
              'Base URL of the LibreTranslate instance (e.g. http://libretranslate:7001 or https://libretranslate.com).',
            default: 'http://localhost:7001',
            required: true,
          },
          libretranslateApiKey: {
            type: 'string',
            title: 'LibreTranslate API key',
            description:
              'Optional API key, if your LibreTranslate instance requires one (e.g. hosted libretranslate.com).',
            secret: true,
          },
          timeoutMs: { type: 'number', title: 'Translate timeout (ms)', default: 5000 },
          commandPrefix: { type: 'string', title: 'Command prefix', default: '/tr' },
          minLength: { type: 'number', title: 'Min message length to translate', default: 2 },
          maxLength: { type: 'number', title: 'Max message length to translate', default: 2000 },
          denyReply: {
            type: 'boolean',
            title: 'Reply on denied commands',
            description: "Reply with an 'admins only' message when a non-admin runs a restricted command.",
            default: false,
          },
          llmEnabled: {
            type: 'boolean',
            title: 'Enable AI translator',
            description:
              'Use an OpenAI-compatible LLM (Grok by default) as the primary translator, with LibreTranslate as the fallback.',
            default: false,
          },
          llmBaseUrl: {
            type: 'string',
            title: 'AI base URL',
            description: 'OpenAI-compatible API base, e.g. https://api.x.ai/v1 or an Ollama/LM Studio endpoint.',
            default: 'https://api.x.ai/v1',
          },
          llmApiKey: { type: 'string', title: 'AI API key', secret: true },
          llmModel: {
            type: 'string',
            title: 'AI model (initial)',
            description: 'Initial model id. An operator can change it at runtime with /tr model switch.',
            default: 'grok-4.20-0309-non-reasoning',
          },
          llmTimeoutMs: { type: 'number', title: 'AI timeout (ms)', default: 8000 },
          contextTurns: { type: 'number', title: 'Context turns sent to the AI', default: 10 },
          defaultPrivacy: {
            type: 'string',
            title: 'Default privacy mode',
            description:
              "'cloud' allows the AI translator by default; 'local' uses only LibreTranslate until a group opts in with /tr privacy cloud.",
            default: 'cloud',
          },
          operatorWids: {
            type: 'array',
            title: 'Operator WhatsApp IDs',
            description:
              'IDs allowed to run /tr model commands (e.g. 1234567890@c.us). A comma-separated string is also accepted.',
          },
        },
      },
    };

    this.pluginLoader.registerBuiltInPlugin(translationManifest, new TranslationPlugin());
    this.logger.log('Translation plugin registered (disabled)');
  }
}

@Module({
  providers: [ExtensionsRegistrar],
})
export class ExtensionsModule {}
