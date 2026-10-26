const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/**
 * Parses the duration format used by the JWT settings (`900`, `90s`, `15m`, `12h`, `30d`)
 * into whole seconds. Throws on anything else so a typo in config fails at boot, not at login.
 */
export function parseDurationSeconds(value: string): number {
  const match = /^\s*(\d+)\s*([smhd]?)\s*$/i.exec(value);
  if (!match) throw new Error(`[auth] invalid duration "${value}" (use e.g. 900, 15m, 12h, 30d)`);
  const amount = Number(match[1]);
  const seconds = amount * UNIT_SECONDS[(match[2] || 's').toLowerCase()];
  if (seconds <= 0) throw new Error(`[auth] duration "${value}" must be positive`);
  return seconds;
}
