/**
 * Group auto-translation extension plugin.
 *
 * Ports the former core `translation` module onto the Tier-2 capability layer (#294): the
 * framework-agnostic `core/` (coordinator, parser, formatter, ports) is reused unchanged, with
 * `ChatGateway`/`ConfigStore` implemented over `ctx.messages`/`ctx.engine`/`ctx.storage`.
 * Registered DISABLED by default — enable via `POST /plugins/translation/enable`.
 *
 * Provider composition (spec §4): an optional OpenAI-compatible LLM in front of LibreTranslate,
 * behind a `FallbackChain`. The LLM is added ONLY when `llmEnabled` is true AND an API key is
 * configured — with the shipped default (`llmEnabled: false`) the chain holds exactly one
 * provider, LibreTranslate, and nothing external is ever contacted.
 */
import { PluginContext, IPlugin } from '../../../core/plugins';
import { HookContext, HookResult } from '../../../core/hooks';
import { IncomingMessage } from '../../../engine/interfaces/whatsapp-engine.interface';
import { TranslationCoordinator, CoordinatorOptions } from './core/translation.coordinator';
import { ContextualTranslator, InboundMessage, PrivacyMode, TranslationLogger } from './core/ports';
import { LibreTranslateClient } from './libretranslate.client';
import { LibreTranslateContextual } from './core/libretranslate.contextual';
import { FallbackChain } from './core/fallback-chain';
import { ConversationContext } from './core/conversation-context';
import { shouldResetContext } from './core/privacy-transition';
import { OpenAiCompatibleClient, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from './llm-openai-compatible.client';
import { PluginChatGateway } from './plugin-chat.gateway';
import { PluginConfigStore } from './plugin-config.store';
import { PluginModelStore } from './plugin-model.store';

function readString(cfg: Record<string, unknown>, key: string, fallback: string): string {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
function readOptionalString(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function readNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function readBool(cfg: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = cfg[key];
  return typeof v === 'boolean' ? v : fallback;
}
/** Accepts a JSON array or a comma-separated string, since dashboard forms post the latter. */
function readStringList(cfg: Record<string, unknown>, key: string): string[] {
  const v = cfg[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}
function readPrivacy(cfg: Record<string, unknown>, key: string, fallback: PrivacyMode): PrivacyMode {
  const v = cfg[key];
  return v === 'cloud' || v === 'local' ? v : fallback;
}

export class TranslationPlugin implements IPlugin {
  private coordinator: TranslationCoordinator | null = null;
  /**
   * Retained across config rebuilds on purpose: a dashboard config edit must not wipe every
   * group's conversation history. The one exception is the privacy flip handled in
   * `buildCoordinator`.
   */
  private context: ConversationContext | null = null;
  /** Instance default privacy the retained `context` was gathered under; see `shouldResetContext`. */
  private defaultPrivacy: PrivacyMode | undefined;

  async onEnable(context: PluginContext): Promise<void> {
    this.coordinator = await this.buildCoordinator(context);
    context.registerHook('message:received', ctx => this.onMessage(context, ctx as HookContext<IncomingMessage>));
    context.logger.log('Translation plugin enabled', { action: 'translation_enabled' });
  }

  async onConfigChange(context: PluginContext): Promise<void> {
    // Rebuild the coordinator so a config edit (e.g. a new LibreTranslate URL/key saved from the
    // dashboard) takes effect immediately, without a disable/enable cycle.
    this.coordinator = await this.buildCoordinator(context);
    context.logger.log('Translation plugin config updated', { action: 'translation_config_changed' });
  }

  private async buildCoordinator(context: PluginContext): Promise<TranslationCoordinator> {
    const cfg = context.config;
    const logger: TranslationLogger = {
      debug: (m, meta) => context.logger.debug(m, meta),
      info: (m, meta) => context.logger.log(m, meta),
      warn: (m, meta) => context.logger.warn(m, meta),
    };

    const libre = new LibreTranslateClient({
      url: readString(cfg, 'libretranslateUrl', 'http://localhost:7001'),
      apiKey: readOptionalString(cfg, 'libretranslateApiKey'),
      timeoutMs: readNumber(cfg, 'timeoutMs', 5000),
    });

    const modelStore = new PluginModelStore(context.storage);
    const providers: ContextualTranslator[] = [];
    let llm: OpenAiCompatibleClient | undefined;
    const llmApiKey = readOptionalString(cfg, 'llmApiKey');
    if (readBool(cfg, 'llmEnabled', false) && llmApiKey) {
      const persisted = await modelStore.load();
      // `??` alone would let a blank persisted value through as the active model.
      const persistedModel =
        typeof persisted?.model === 'string' && persisted.model.length > 0 ? persisted.model : undefined;
      llm = new OpenAiCompatibleClient({
        baseUrl: readString(cfg, 'llmBaseUrl', DEFAULT_LLM_BASE_URL),
        apiKey: llmApiKey,
        model: persistedModel ?? readString(cfg, 'llmModel', DEFAULT_LLM_MODEL),
        timeoutMs: readNumber(cfg, 'llmTimeoutMs', 8000),
      });
      providers.push(llm);
      context.logger.log('LLM translator enabled', { action: 'translation_llm_enabled', model: llm.currentModel() });
    }

    // The coordinator speaks `ContextualTranslator`; this wrapper reproduces the previous
    // detect-then-fan-out behaviour over the LibreTranslate client, so runtime output is unchanged.
    providers.push(new LibreTranslateContextual(libre, logger));
    const chain = new FallbackChain(providers, logger);

    const defaultPrivacy = readPrivacy(cfg, 'defaultPrivacy', 'cloud');
    // Groups with no per-group override follow `defaultPrivacy`, so flipping the instance default
    // local -> cloud makes them cloud-eligible. History gathered while the instance was opted out
    // of external processing must not ride along into the first cloud request.
    if (shouldResetContext(this.defaultPrivacy, defaultPrivacy)) {
      this.context = null;
      context.logger.log('Conversation context dropped: instance privacy default moved local to cloud', {
        action: 'translation_context_reset_privacy',
      });
    }
    this.defaultPrivacy = defaultPrivacy;

    if (!this.context) {
      this.context = new ConversationContext({ maxTurns: readNumber(cfg, 'contextTurns', 10), maxChars: 2000 });
    }

    const store = new PluginConfigStore(context.storage);
    const gateway = new PluginChatGateway(context.messages, context.engine);
    const opts: CoordinatorOptions = {
      prefix: readString(cfg, 'commandPrefix', '/tr'),
      minLength: readNumber(cfg, 'minLength', 2),
      maxLength: readNumber(cfg, 'maxLength', 2000),
      denyReply: readBool(cfg, 'denyReply', false),
      defaultPrivacy,
      operatorWids: readStringList(cfg, 'operatorWids'),
    };

    return new TranslationCoordinator(chain, store, gateway, opts, logger, {
      context: this.context,
      models: llm,
      modelStore,
      providerHealth: () => chain.providerHealth(),
    });
  }

  onDisable(context: PluginContext): Promise<void> {
    // The loader unregisters this plugin's hooks on disable; drop the coordinator too.
    this.coordinator = null;
    this.context = null;
    this.defaultPrivacy = undefined;
    context.logger.log('Translation plugin disabled', { action: 'translation_disabled' });
    return Promise.resolve();
  }

  private async onMessage(context: PluginContext, ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    const msg = ctx.data;
    // Only act on engine-originated inbound messages for a known session. The bot's own sends are
    // `fromMe` and route through `message:sent`, so they never reach here (no translation loop).
    if (!this.coordinator || ctx.source !== 'Engine' || !ctx.sessionId) {
      return { continue: true };
    }
    try {
      const inbound: InboundMessage = {
        id: msg.id,
        chatId: msg.chatId,
        body: msg.body,
        author: msg.author ?? '',
        isGroup: msg.isGroup,
        fromMe: msg.fromMe,
        mentionedIds: msg.mentionedIds ?? [],
        pushName: msg.contact?.pushName,
      };
      const { swallow } = await this.coordinator.handleMessage(ctx.sessionId, inbound);
      return { continue: !swallow };
    } catch (error) {
      context.logger.error('Translation hook failed', error, {
        sessionId: ctx.sessionId,
        action: 'translation_hook_error',
      });
      return { continue: true };
    }
  }
}

export default TranslationPlugin;
