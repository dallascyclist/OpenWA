// src/modules/translation/core/reply.formatter.ts
import { Translation, GroupState, ProviderHealth, EffectivePrivacy, ModelInfo } from './ports';

const FLAGS: Record<string, string> = {
  en: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  pt: '🇵🇹',
  it: '🇮🇹',
  nl: '🇳🇱',
  ru: '🇷🇺',
  ar: '🇸🇦',
  zh: '🇨🇳',
  ja: '🇯🇵',
};

function label(lang: string): string {
  const flag = FLAGS[lang];
  return flag ? `${flag} ${lang.toUpperCase()}` : lang.toUpperCase();
}

export function formatCombinedReply(translations: Translation[]): string {
  return translations.map(t => `${label(t.lang)}: ${t.text}`).join('\n');
}

export function buildHelpText(prefix: string): string {
  return [
    '👋 Translation bot. I am OFF in this group until an admin runs `' + prefix + ' on`.',
    'Commands:',
    `${prefix} on / ${prefix} off — enable/disable translation here`,
    `${prefix} setlang <code> [me|@user|number] — pin a language (default: you)`,
    `${prefix} auto [me|@user|number] — go back to auto-detect`,
    `${prefix} ignore <@user|number> / ${prefix} unignore <@user|number>`,
    `${prefix} grant <@user|number> / ${prefix} revoke <@user|number> — delegate control (admins)`,
    `${prefix} privacy [cloud|local] — show or set whether an external AI service may translate here`,
    `${prefix} model [list|switch <id>] — operator only: view or change the AI model`,
    `${prefix} status — show settings`,
    `${prefix} help — this message`,
  ].join('\n');
}

/**
 * Compliance notice, so it must not understate the payload. The provider receives more than the one
 * message being translated: the sender's display name, a glossary of every participant's display
 * name, and up to `contextTurns` recent messages — which include messages from participants the bot
 * ignores and messages it never got to translate.
 */
export function buildDisclosureText(prefix: string): string {
  return (
    'ℹ️ Translations in this group are produced by an external AI service: messages sent here go to that ' +
    'provider, along with recent messages kept for context — including ones the bot does not translate — ' +
    'and participants’ display names. ' +
    `An admin can switch to local-only translation with \`${prefix} privacy local\`.`
  );
}

function providerLabel(p: ProviderHealth): string {
  return p.name === 'llm' ? 'AI translation' : 'Basic translation';
}

export function formatHealthNotice(p: ProviderHealth): string {
  const label = providerLabel(p);
  if (p.healthy) return `✅ ${label} is back.`;
  return p.name === 'llm'
    ? `⚠️ ${label} is temporarily unavailable; using basic translation until it recovers.`
    : `⚠️ ${label} is temporarily unavailable.`;
}

export function formatPrivacy(p: EffectivePrivacy, prefix: string): string {
  const where = p.source === 'group' ? 'group override' : 'instance default';
  return [
    `Privacy: ${p.mode} (${where})`,
    p.mode === 'cloud'
      ? `Messages are sent to an external AI service for translation. Switch with \`${prefix} privacy local\`.`
      : `Only the local translator is used here. Switch with \`${prefix} privacy cloud\`.`,
  ].join('\n');
}

const MODEL_LIST_MAX = 30;

export function formatModelList(models: ModelInfo[], active: string): string {
  const lines = [`Available models (${models.length}):`];
  for (const m of models.slice(0, MODEL_LIST_MAX)) {
    const mark = m.id === active ? '▶' : '•';
    const price =
      m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
        ? ` — in $${m.inputPerMTok.toFixed(2)} / out $${m.outputPerMTok.toFixed(2)} per 1M tok`
        : '';
    lines.push(`${mark} ${m.id}${price}`);
  }
  if (models.length > MODEL_LIST_MAX) lines.push(`(+${models.length - MODEL_LIST_MAX} more)`);
  return lines.join('\n');
}

export function formatStatus(
  state: GroupState,
  health: ProviderHealth[],
  privacy: EffectivePrivacy,
  activeModel?: string,
): string {
  const lines: string[] = [];
  lines.push(`Translation: ${state.active ? 'ACTIVE' : 'inactive'}`);

  const llm = health.find(h => h.name === 'llm');
  if (!llm) {
    lines.push('AI translator: disabled');
  } else {
    const status = privacy.mode === 'local' ? 'off (privacy)' : llm.healthy ? 'ok' : 'degraded';
    lines.push(`AI translator (${activeModel ?? 'unknown'}): ${status}`);
  }
  for (const h of health.filter(x => x.name !== 'llm')) {
    lines.push(`Basic translator (${h.name}): ${h.healthy ? 'ok' : 'unreachable'}`);
  }
  lines.push(`Privacy: ${privacy.mode} (${privacy.source === 'group' ? 'group override' : 'instance default'})`);

  const entries = Object.entries(state.participants);
  if (entries.length === 0) {
    lines.push('No participants learned yet.');
  } else {
    lines.push('Participants:');
    for (const [wid, p] of entries) {
      const lang = p.lang ?? 'unknown';
      const flags = `${p.source}${p.enabled ? '' : ', ignored'}`;
      lines.push(`• ${wid}: ${lang} (${flags})`);
    }
  }
  if (state.delegatedControllers.length > 0) {
    lines.push(`Delegated controllers: ${state.delegatedControllers.join(', ')}`);
  }
  return lines.join('\n');
}
