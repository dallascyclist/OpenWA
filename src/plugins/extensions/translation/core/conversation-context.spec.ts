// src/plugins/extensions/translation/core/conversation-context.spec.ts
import { ConversationContext } from './conversation-context';
import { ContextTurn } from './ports';

const turn = (text: string, author = 'A', lang = 'en'): ContextTurn => ({
  author,
  lang,
  text,
  at: '2026-09-16T00:00:00Z',
});

describe('ConversationContext', () => {
  it('returns an empty history for an unknown chat', () => {
    const ctx = new ConversationContext({ maxTurns: 3, maxChars: 100 });
    expect(ctx.get('s', 'g@g.us')).toEqual([]);
  });

  it('appends oldest-first and returns a copy', () => {
    const ctx = new ConversationContext({ maxTurns: 3, maxChars: 100 });
    ctx.append('s', 'g@g.us', turn('one'));
    ctx.append('s', 'g@g.us', turn('two'));
    const h = ctx.get('s', 'g@g.us');
    expect(h.map(t => t.text)).toEqual(['one', 'two']);
    h.push(turn('leak'));
    expect(ctx.get('s', 'g@g.us')).toHaveLength(2);
  });

  it('evicts the oldest turn beyond maxTurns', () => {
    const ctx = new ConversationContext({ maxTurns: 2, maxChars: 1000 });
    ['a', 'b', 'c'].forEach(t => ctx.append('s', 'g', turn(t)));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['b', 'c']);
  });

  it('evicts oldest turns beyond maxChars but always keeps the newest', () => {
    const ctx = new ConversationContext({ maxTurns: 10, maxChars: 10 });
    ctx.append('s', 'g', turn('12345'));
    ctx.append('s', 'g', turn('67890'));
    ctx.append('s', 'g', turn('x'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['67890', 'x']);
    ctx.append('s', 'g', turn('this one alone is longer than ten'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['this one alone is longer than ten']);
  });

  it('isolates chats and sessions', () => {
    const ctx = new ConversationContext({ maxTurns: 5, maxChars: 1000 });
    ctx.append('s1', 'g', turn('s1'));
    ctx.append('s2', 'g', turn('s2'));
    ctx.append('s1', 'h', turn('h'));
    expect(ctx.get('s1', 'g').map(t => t.text)).toEqual(['s1']);
    expect(ctx.get('s2', 'g').map(t => t.text)).toEqual(['s2']);
    expect(ctx.get('s1', 'h').map(t => t.text)).toEqual(['h']);
  });

  it('clamps maxTurns to at least 1 so an operator-set 0 still keeps the newest turn', () => {
    const ctx = new ConversationContext({ maxTurns: 0, maxChars: 1000 });
    ctx.append('s', 'g', turn('one'));
    ctx.append('s', 'g', turn('two'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['two']);
  });

  it('clamps a negative maxTurns the same way', () => {
    const ctx = new ConversationContext({ maxTurns: -5, maxChars: 1000 });
    ctx.append('s', 'g', turn('only'));
    expect(ctx.get('s', 'g').map(t => t.text)).toEqual(['only']);
  });

  it('clear() empties one chat only', () => {
    const ctx = new ConversationContext({ maxTurns: 5, maxChars: 1000 });
    ctx.append('s', 'g', turn('g'));
    ctx.append('s', 'h', turn('h'));
    ctx.clear('s', 'g');
    expect(ctx.get('s', 'g')).toEqual([]);
    expect(ctx.get('s', 'h')).toHaveLength(1);
  });
});
