/** Numeric helpers shared by the exchange clients (tick/step alignment). */

/** Number of decimal places implied by a numeric string like "0.001" -> 3. */
export function decimalsOf(v: string | number): number | null {
  const s = String(v);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Round UP to `decimals` places (無條件進位), fp-safe. */
export function ceilToDecimals(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.ceil(v * f - 1e-9) / f;
}

/** Round DOWN to `decimals` places (無條件縮減/捨去), fp-safe. */
export function floorToDecimals(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.floor(v * f + 1e-9) / f;
}

/** Round DOWN to the nearest multiple of `step` (fp-safe). */
export function floorToStep(v: number, step: number): number {
  if (!step || step <= 0) return v;
  const d = decimalsOf(step) ?? 8;
  return floorToDecimals(Math.floor(v / step + 1e-9) * step, d);
}
