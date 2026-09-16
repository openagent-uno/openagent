export type RunDateWireValue = string | number | null | undefined;

export interface LegacyRunDateFields {
  started_at?: RunDateWireValue;
  finished_at?: RunDateWireValue;
  started_at_iso?: RunDateWireValue;
  finished_at_iso?: RunDateWireValue;
}

export interface NormalizedRunDateFields {
  /** Epoch seconds, matching the legacy workflow/task/event contracts. */
  started_at: number;
  finished_at: number | null;
  /** Canonical ISO mirrors used for display. */
  started_at_iso?: string;
  finished_at_iso?: string | null;
}

export type WithNormalizedRunDates<T extends LegacyRunDateFields> =
  Omit<T, keyof LegacyRunDateFields> & NormalizedRunDateFields;

export interface NormalizedRunTimestamp {
  epochSeconds: number;
  iso: string;
}

const NUMERIC_WIRE_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
// Modern epoch seconds are ~1e9; modern epoch milliseconds are ~1e12. A
// 1e11 boundary also handles millisecond dates before September 2001 without
// mistaking any realistic run timestamp expressed in seconds.
const MILLISECOND_THRESHOLD = 1e11;

/** Parse either an ISO timestamp or a Unix epoch expressed in seconds/ms. */
export function normalizeRunTimestamp(
  value: RunDateWireValue,
): NormalizedRunTimestamp | null {
  if (value == null) return null;

  let epoch = value;
  if (typeof epoch === 'string') {
    const trimmed = epoch.trim();
    if (!trimmed) return null;
    if (!NUMERIC_WIRE_VALUE.test(trimmed)) {
      const parsed = Date.parse(trimmed);
      if (!Number.isFinite(parsed)) return null;
      const date = new Date(parsed);
      return { epochSeconds: parsed / 1000, iso: date.toISOString() };
    }
    epoch = Number(trimmed);
  }

  if (!Number.isFinite(epoch)) return null;
  const milliseconds = Math.abs(epoch) < MILLISECOND_THRESHOLD
    ? epoch * 1000
    : epoch;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  return { epochSeconds: milliseconds / 1000, iso: date.toISOString() };
}

function preferredTimestamp(
  iso: RunDateWireValue,
  legacy: RunDateWireValue,
  nullable: boolean,
): NormalizedRunTimestamp | null {
  // A server-supplied null finished_at_iso is authoritative: the run is
  // still live even if an older numeric mirror is stale. Missing/invalid ISO
  // fields fall back to the legacy epoch/string for older gateways.
  if (nullable && iso === null) return null;
  return normalizeRunTimestamp(iso) ?? normalizeRunTimestamp(legacy);
}

/**
 * Normalize the date boundary shared by legacy workflow, scheduled-task and
 * event detail payloads. Server ISO mirrors win; fallback values may be ISO,
 * epoch seconds or epoch milliseconds. The numeric result remains seconds so
 * existing duration arithmetic cannot accidentally inflate by 1000x.
 */
export function normalizeLegacyRunDates<T extends LegacyRunDateFields>(
  value: T,
): WithNormalizedRunDates<T> {
  const started = preferredTimestamp(value.started_at_iso, value.started_at, false);
  const finished = preferredTimestamp(value.finished_at_iso, value.finished_at, true);
  return {
    ...value,
    started_at: started?.epochSeconds ?? 0,
    finished_at: finished?.epochSeconds ?? null,
    started_at_iso: started?.iso,
    finished_at_iso: finished?.iso ?? null,
  } as WithNormalizedRunDates<T>;
}
