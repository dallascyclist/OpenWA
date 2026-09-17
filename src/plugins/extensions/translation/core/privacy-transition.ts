// src/plugins/extensions/translation/core/privacy-transition.ts
// Framework-free privacy rule for the instance default privacy mode (spec D7).
import { PrivacyMode } from './ports';

/**
 * Whether retained conversation context must be discarded because the instance default privacy
 * mode changed.
 *
 * Groups without a per-group override follow `defaultPrivacy`. Flipping it from `local` to `cloud`
 * therefore makes previously local-only groups cloud-eligible, and any history gathered while the
 * instance was opted out of external processing would otherwise be sent to the external provider
 * on the very next message. Same boundary crossing as the per-group `/tr privacy cloud` switch,
 * one level up.
 *
 * `prev === undefined` is the first build of the plugin's lifetime: there is no retained context
 * to leak, so nothing is reset.
 */
export function shouldResetContext(prev: PrivacyMode | undefined, next: PrivacyMode): boolean {
  return prev === 'local' && next === 'cloud';
}
