// src/modules/translation/core/command.parser.spec.ts
import { parseCommand } from './command.parser';

describe('parseCommand', () => {
  it('returns null for non-prefixed text', () => {
    expect(parseCommand('hello world', '/tr')).toBeNull();
  });

  it('parses bare commands', () => {
    expect(parseCommand('/tr on', '/tr')).toEqual({ name: 'on' });
    expect(parseCommand('/tr help', '/tr')).toEqual({ name: 'help' });
  });

  it('accepts the /translate alias and is case-insensitive on the verb', () => {
    expect(parseCommand('/translate OFF', '/tr')).toEqual({ name: 'off' });
  });

  it('parses setlang with default me target', () => {
    expect(parseCommand('/tr setlang es', '/tr')).toEqual({
      name: 'setlang',
      lang: 'es',
      target: { kind: 'me' },
    });
  });

  it('parses a number target', () => {
    expect(parseCommand('/tr grant 14155551212', '/tr')).toEqual({
      name: 'grant',
      target: { kind: 'number', number: '14155551212' },
    });
  });

  it('parses a mention target', () => {
    expect(parseCommand('/tr ignore @someone', '/tr')).toEqual({
      name: 'ignore',
      target: { kind: 'mention' },
    });
  });

  it('returns null for an unknown verb', () => {
    expect(parseCommand('/tr frobnicate', '/tr')).toBeNull();
  });

  it('parses privacy with and without a mode', () => {
    expect(parseCommand('/tr privacy', '/tr')).toEqual({ name: 'privacy' });
    expect(parseCommand('/tr privacy local', '/tr')).toEqual({ name: 'privacy', privacy: 'local' });
    expect(parseCommand('/tr privacy CLOUD', '/tr')).toEqual({ name: 'privacy', privacy: 'cloud' });
    expect(parseCommand('/tr privacy bogus', '/tr')).toEqual({ name: 'privacy' });
  });

  it('parses model show/list/switch', () => {
    expect(parseCommand('/tr model', '/tr')).toEqual({ name: 'model', modelAction: 'show' });
    expect(parseCommand('/tr model list', '/tr')).toEqual({ name: 'model', modelAction: 'list' });
    expect(parseCommand('/tr model switch grok-4.6', '/tr')).toEqual({
      name: 'model',
      modelAction: 'switch',
      modelId: 'grok-4.6',
    });
    expect(parseCommand('/tr model switch', '/tr')).toEqual({ name: 'model', modelAction: 'switch' });
    expect(parseCommand('/tr model nonsense', '/tr')).toEqual({ name: 'model', modelAction: 'show' });
  });
});
