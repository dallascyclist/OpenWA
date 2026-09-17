// src/modules/translation/core/reply.formatter.spec.ts
import {
  formatCombinedReply,
  buildHelpText,
  formatStatus,
  buildDisclosureText,
  formatHealthNotice,
  formatModelList,
  formatPrivacy,
} from './reply.formatter';
import { GroupState } from './ports';

describe('reply.formatter', () => {
  it('formats one line per translation with an uppercased code label', () => {
    const out = formatCombinedReply([
      { lang: 'es', text: 'Hola' },
      { lang: 'fr', text: 'Bonjour' },
    ]);
    expect(out).toContain('Hola');
    expect(out).toContain('Bonjour');
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toMatch(/ES/);
  });

  it('buildHelpText lists key commands with the active prefix', () => {
    const help = buildHelpText('/tr');
    expect(help).toContain('/tr on');
    expect(help).toContain('/tr setlang');
  });

  it('formatStatus reports active state, providers, privacy, model, and participants', () => {
    const state: GroupState = {
      sessionId: 's',
      chatId: 'c@g.us',
      active: true,
      participants: { '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' } },
      delegatedControllers: [],
      announced: true,
    };
    const out = formatStatus(
      state,
      [
        { name: 'llm', external: true, healthy: false },
        { name: 'libretranslate', external: false, healthy: true },
      ],
      { mode: 'cloud', source: 'instance' },
      'grok-4.3',
    );
    expect(out).toMatch(/active/i);
    expect(out).toContain('AI translator (grok-4.3): degraded');
    expect(out).toContain('Basic translator (libretranslate): ok');
    expect(out).toContain('Privacy: cloud (instance default)');
    expect(out).toContain('en');
  });

  it('formatStatus shows the AI translator as disabled when absent and off (privacy) in a local group', () => {
    const state: GroupState = {
      sessionId: 's',
      chatId: 'c',
      active: true,
      participants: {},
      delegatedControllers: [],
      announced: true,
    };
    const absent = formatStatus(state, [{ name: 'libretranslate', external: false, healthy: true }], {
      mode: 'cloud',
      source: 'instance',
    });
    expect(absent).toContain('AI translator: disabled');
    const local = formatStatus(
      state,
      [
        { name: 'llm', external: true, healthy: true },
        { name: 'libretranslate', external: false, healthy: false },
      ],
      { mode: 'local', source: 'group' },
      'm',
    );
    expect(local).toContain('AI translator (m): off (privacy)');
    expect(local).toContain('Basic translator (libretranslate): unreachable');
    expect(local).toContain('Privacy: local (group override)');
  });

  it('buildHelpText mentions privacy and model commands', () => {
    const out = buildHelpText('/tr');
    expect(out).toContain('/tr privacy');
    expect(out).toContain('/tr model');
  });

  it('buildDisclosureText names the external provider and the opt-out command', () => {
    const out = buildDisclosureText('/tr');
    expect(out).toMatch(/external AI/i);
    expect(out).toContain('/tr privacy local');
  });

  // It is a compliance notice, so it has to cover the whole payload, not just the one message being
  // translated: recent turns (including ones from ignored participants) and display names go too.
  it('buildDisclosureText discloses the context turns and display names, not just the one message', () => {
    const out = buildDisclosureText('/tr');
    expect(out).toMatch(/recent messages/i);
    expect(out).toMatch(/context/i);
    expect(out).toMatch(/display names/i);
    expect(out).toMatch(/does not translate/i);
  });

  it('formatHealthNotice distinguishes provider and direction', () => {
    expect(formatHealthNotice({ name: 'llm', external: true, healthy: false })).toBe(
      '⚠️ AI translation is temporarily unavailable; using basic translation until it recovers.',
    );
    expect(formatHealthNotice({ name: 'llm', external: true, healthy: true })).toBe('✅ AI translation is back.');
    expect(formatHealthNotice({ name: 'libretranslate', external: false, healthy: false })).toBe(
      '⚠️ Basic translation is temporarily unavailable.',
    );
    expect(formatHealthNotice({ name: 'libretranslate', external: false, healthy: true })).toBe(
      '✅ Basic translation is back.',
    );
  });

  it('formatModelList marks the active model, shows prices, and truncates at 30', () => {
    const models = Array.from({ length: 32 }, (_, i) => ({ id: `m${i}`, inputPerMTok: 1.25, outputPerMTok: 2.5 }));
    const out = formatModelList(models, 'm1');
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/models/i);
    expect(out).toContain('▶ m1 — in $1.25 / out $2.50 per 1M tok');
    expect(out).toContain('• m0 — in $1.25 / out $2.50 per 1M tok');
    expect(out).toContain('(+2 more)');
    expect(formatModelList([{ id: 'plain' }], 'x')).toContain('• plain');
  });

  it('formatPrivacy explains the effective mode', () => {
    expect(formatPrivacy({ mode: 'local', source: 'group' }, '/tr')).toContain('local (group override)');
    expect(formatPrivacy({ mode: 'cloud', source: 'instance' }, '/tr')).toContain('cloud (instance default)');
  });
});
