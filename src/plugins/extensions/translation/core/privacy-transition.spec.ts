import { shouldResetContext } from './privacy-transition';

describe('shouldResetContext', () => {
  it('resets when the instance default moves local -> cloud', () => {
    // Turns gathered while the instance was opted out of external processing must never ride
    // along into the first cloud request.
    expect(shouldResetContext('local', 'cloud')).toBe(true);
  });

  it('keeps context when the default tightens cloud -> local', () => {
    // Nothing crosses a boundary outward; the retained turns were already cloud-eligible.
    expect(shouldResetContext('cloud', 'local')).toBe(false);
  });

  it('keeps context when the default does not change', () => {
    expect(shouldResetContext('local', 'local')).toBe(false);
    expect(shouldResetContext('cloud', 'cloud')).toBe(false);
  });

  it('keeps context on the first build, when there is no previous default', () => {
    expect(shouldResetContext(undefined, 'cloud')).toBe(false);
    expect(shouldResetContext(undefined, 'local')).toBe(false);
  });
});
