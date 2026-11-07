// onebase's own version, and how versions compare.

export const VERSION = "0.2.0";

/** [major, minor, patch] of "v1.2.3" or "1.2.3-beta"; null when it isn't a version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, positive when newer, 0 when equal (or either isn't a version). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * Whether code built against `a` should run on `b`: the same major version, and before 1.0 the
 * same minor too (0.x releases may change the API).
 */
export function compatibleVersions(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return true;
  return x[0] === y[0] && (x[0] > 0 || x[1] === y[1]);
}
