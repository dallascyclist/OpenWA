// src/modules/translation/core/ports.ts
// Framework-agnostic contracts for the translation core. NO NestJS/TypeORM/engine imports.

export interface DetectResult {
  lang: string; // ISO 639-1
  confidence: number; // 0..1
}

export interface Translation {
  lang: string;
  text: string;
}

export interface ParticipantState {
  lang: string | null; // null = not learned yet
  source: 'learned' | 'pinned';
  enabled: boolean;
  samples: number;
  /** Candidate language awaiting a 2nd consecutive detection before a learned switch. */
  pendingLang?: string;
  updatedAt: string;
  /** Last-seen WhatsApp pushName; a secondary identity anchor used to reconcile a misrouted
   * @lid author back to the real sender. */
  pushName?: string;
}

export type ParticipantMap = Record<string, ParticipantState>; // key = author WID

export interface GroupState {
  sessionId: string;
  chatId: string;
  active: boolean;
  participants: ParticipantMap;
  delegatedControllers: string[];
  announced: boolean;
  /** Per-group privacy override; undefined => instance default (`CoordinatorOptions.defaultPrivacy`). */
  privacy?: PrivacyMode;
  /** One-time cloud disclosure already posted in this group. */
  privacyDisclosed?: boolean;
}

export interface InboundMessage {
  id: string;
  chatId: string;
  body: string;
  author: string; // sender WID (group participant)
  isGroup: boolean;
  fromMe: boolean;
  mentionedIds: string[];
  pushName?: string;
}

export type CommandName =
  | 'help'
  | 'status'
  | 'on'
  | 'off'
  | 'setlang'
  | 'auto'
  | 'ignore'
  | 'unignore'
  | 'grant'
  | 'revoke'
  | 'privacy'
  | 'model';

export type ModelAction = 'show' | 'list' | 'switch';

export type CommandTarget = { kind: 'me' } | { kind: 'mention' } | { kind: 'number'; number: string };

export interface ParsedCommand {
  name: CommandName;
  lang?: string; // setlang only
  target?: CommandTarget; // setlang/auto/ignore/unignore/grant/revoke
  privacy?: PrivacyMode; // privacy only; undefined => show current
  modelAction?: ModelAction; // model only
  modelId?: string; // model switch only
}

export interface Translator {
  detect(text: string): Promise<DetectResult>;
  translate(text: string, source: string, target: string): Promise<string>;
  languages(): Promise<string[]>;
  isHealthy(): boolean;
}

export interface ConfigStore {
  load(sessionId: string, chatId: string): Promise<GroupState>;
  save(state: GroupState): Promise<void>;
}

export interface ChatGateway {
  sendText(sessionId: string, chatId: string, text: string): Promise<void>;
  sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void>;
  getGroupAdmins(sessionId: string, chatId: string): Promise<string[]>;
}

/**
 * Structured logging port for the translation core. Implemented at the plugin boundary over the
 * host's PluginLogger; declared here so `core/` stays framework-agnostic.
 */
export interface TranslationLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type PrivacyMode = 'cloud' | 'local';

export interface EffectivePrivacy {
  mode: PrivacyMode;
  source: 'group' | 'instance';
}

/** One prior message, ORIGINAL text only. Never a translation. */
export interface ContextTurn {
  author: string; // display name (pushName) or the wid's user part
  lang: string; // ISO 639-1 known at the time, or 'und'
  text: string;
  at: string; // ISO timestamp
}

export interface TranslateRequest {
  text: string;
  senderName: string;
  candidateLangs: string[]; // group's known languages; may be empty on a group's first message
  hintLang: string | null; // sender's learned/pinned language
  glossary: string[]; // participant display names; never translate
  history: ContextTurn[]; // oldest first; excludes the current message
  summary?: string; // RESERVED (spec D4); always undefined in this cut
  allowExternal: boolean; // false => external providers must be skipped
}

export interface TranslateResult {
  detected: string; // raw detection; feeds participant learning
  source: string; // language translated FROM after the sanity rule
  translations: Translation[]; // one per candidateLangs entry !== source (fewer on partial failure)
  provider: string; // 'llm' | 'libretranslate'
}

export interface ContextualTranslator {
  readonly name: string;
  readonly external: boolean;
  translateAll(req: TranslateRequest): Promise<TranslateResult>;
  languages(): Promise<string[]>;
  isHealthy(): boolean;
}

/** Reserved (spec D4). Not implemented or wired in this cut. */
export interface SummaryProvider {
  summarize(turns: ContextTurn[], previousSummary?: string): Promise<string>;
}

export interface ModelInfo {
  id: string;
  inputPerMTok?: number; // USD per 1M input tokens, when the provider exposes pricing
  outputPerMTok?: number; // USD per 1M output tokens
}

/** Implemented by providers whose model can be changed at runtime. */
export interface ModelSwitchable {
  listModels(): Promise<ModelInfo[]>;
  currentModel(): string;
  setModel(id: string): void;
}

export interface ModelSelection {
  model: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ModelStore {
  load(): Promise<ModelSelection | null>;
  save(sel: ModelSelection): Promise<void>;
}

export interface ProviderHealth {
  name: string;
  external: boolean;
  healthy: boolean;
}
