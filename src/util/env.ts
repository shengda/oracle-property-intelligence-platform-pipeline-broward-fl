/**
 * A positive number from the environment, or `fallback` when the variable is unset or empty (as
 * `.env.example` leaves optional settings). `Number("")` is 0, so a plain `Number(env.X ?? d)`
 * turns an empty line into a zero budget or a zero timeout. Any other non-positive value is a
 * configuration error and throws, naming the variable.
 */
export function envPositiveNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got '${value}'`);
  return n;
}
