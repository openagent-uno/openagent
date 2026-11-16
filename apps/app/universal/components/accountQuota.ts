/**
 * Quota and account-state helpers shared by the Accounts panel, the Models
 * grid tiles and the model edit dialog.
 *
 * One rule above all: **never invent a headroom number.** A window is only
 * drawn when the upstream reported a used-percentage for it; otherwise the
 * caller says "Quota not reported".
 */

import { colors } from '../theme';
import type { ProviderAccounts, ServingAccount } from '../../common/types';

/** "6.4 days", "3h", "12m", "45s" — whichever unit keeps it readable. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function windowLabel(minutes?: number): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = minutes / 60;
  if (h < 48) return `${Math.round(h)}h window`;
  const days = Math.round(h / 24);
  if (days === 7) return 'Weekly';
  return `${days}-day window`;
}

/** Colour by how much is LEFT, not by how much is used. */
export function headroomColor(usedPercent: number): string {
  if (usedPercent >= 90) return colors.error;
  if (usedPercent >= 70) return colors.warning;
  return colors.accent;
}

export type AccountState = 'ok' | 'rate_limited' | 'auth_expired';

/** The server's per-account status, with the older flags as a fallback. */
export function accountState(a: ServingAccount): AccountState {
  if (a.status === 'auth_expired' || a.dead) return 'auth_expired';
  if (a.status === 'rate_limited') return 'rate_limited';
  if (a.status === 'ok') return 'ok';
  return a.limited ? 'rate_limited' : 'ok';
}

/** Seconds until a limited account is usable again, when reported. */
export function limitedRemainingS(a: ServingAccount): number | null {
  if (a.cooldown_remaining_s) return a.cooldown_remaining_s;
  if (a.limited_until_ms) return Math.max(0, (a.limited_until_ms - Date.now()) / 1000);
  return null;
}

/** The account serving traffic now: the first usable one, else the first. */
export function servingAccount(entry: ProviderAccounts | null | undefined): ServingAccount | null {
  const list = entry?.accounts ?? [];
  return list.find((a) => accountState(a) === 'ok') ?? list[0] ?? null;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetAfterS: number | null;
}

/** Only windows the upstream actually reported. */
export function quotaWindows(a: ServingAccount): QuotaWindow[] {
  const q = a.quota;
  if (!q) return [];
  const out: QuotaWindow[] = [];
  if (typeof q.primary_used_percent === 'number') {
    out.push({
      label: windowLabel(q.primary_window_minutes) ?? 'Current window',
      usedPercent: q.primary_used_percent,
      resetAfterS: q.primary_reset_after_s ?? null,
    });
  }
  if (typeof q.secondary_used_percent === 'number') {
    out.push({
      label: windowLabel(q.secondary_window_minutes) ?? 'Second window',
      usedPercent: q.secondary_used_percent,
      resetAfterS: q.secondary_reset_after_s ?? null,
    });
  }
  return out;
}

/** "5h window · 41% used · resets in 2h" */
export function quotaWindowText(w: QuotaWindow): string {
  return [
    w.label,
    `${Math.round(w.usedPercent)}% used`,
    w.resetAfterS ? `resets in ${formatDuration(w.resetAfterS)}` : null,
  ].filter(Boolean).join(' · ');
}
