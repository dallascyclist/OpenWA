// src/plugins/extensions/translation/core/conversation-context.ts
// In-memory, per-chat ring buffer of ORIGINAL message turns used as LLM context (spec §9).
// Not persisted by design; lost on restart.
import { ContextTurn } from './ports';

export interface ConversationContextOptions {
  maxTurns: number;
  maxChars: number;
}

export class ConversationContext {
  private readonly buffers = new Map<string, ContextTurn[]>();

  constructor(private readonly opts: ConversationContextOptions) {}

  private key(sessionId: string, chatId: string): string {
    return `${sessionId}:${chatId}`;
  }

  get(sessionId: string, chatId: string): ContextTurn[] {
    return [...(this.buffers.get(this.key(sessionId, chatId)) ?? [])];
  }

  append(sessionId: string, chatId: string, turn: ContextTurn): void {
    const k = this.key(sessionId, chatId);
    const buf = this.buffers.get(k) ?? [];
    buf.push(turn);
    while (buf.length > this.opts.maxTurns) buf.shift();
    // Character cap: evict oldest-first but always keep the newest turn.
    while (buf.length > 1 && totalChars(buf) > this.opts.maxChars) buf.shift();
    this.buffers.set(k, buf);
  }

  clear(sessionId: string, chatId: string): void {
    this.buffers.delete(this.key(sessionId, chatId));
  }
}

function totalChars(turns: ContextTurn[]): number {
  return turns.reduce((n, t) => n + t.text.length, 0);
}
