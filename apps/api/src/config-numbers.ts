/** Reject invalid, negative and nonfinite numeric settings before resource loops. */
export function positiveNumber(value: unknown, fallback: number, minimum = 1): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}
