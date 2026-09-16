/**
 * CronPicker — reusable scheduling control.
 *
 * Two modes drive the same callback shape:
 *
 *   - **Recurring** — cron presets (every-N-minutes / hourly / daily /
 *     weekly) plus a free-form custom field. The string emitted is a
 *     standard 5-field cron expression.
 *   - **Once at…** — a date+time picker. Emits ``@once:<epoch>``,
 *     which the backend's ``validate_schedule_expression`` and
 *     ``next_run_for_expression`` already accept everywhere; the
 *     scheduler auto-disables one-shot rows after they fire.
 *
 * Same widget renders inside the Tasks list, the workflow editor's
 * trigger-schedule properties panel, and any future scheduler-aware
 * surface, so the cron string ends up identical regardless of where
 * it was set. The live preview hits ``/api/cron/describe`` on every
 * change to validate and show the next 1-3 fire times.
 */

import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { describeCron, type CronDescribeResponse } from '../services/api';
import { colors, font, radius } from '../theme';

export interface CronPreset {
  label: string;
  expression: string;
}

const ONE_SHOT_PREFIX = '@once:';

const DEFAULT_PRESETS: CronPreset[] = [
  { label: 'Every 1 min', expression: '* * * * *' },
  { label: 'Every 5 min', expression: '*/5 * * * *' },
  { label: 'Every 15 min', expression: '*/15 * * * *' },
  { label: 'Hourly', expression: '0 * * * *' },
  { label: 'Daily 9am', expression: '0 9 * * *' },
  { label: 'Weekly Mon 9am', expression: '0 9 * * 1' },
];

interface Props {
  value: string;
  onChange: (expression: string) => void;
  presets?: CronPreset[];
  label?: string;
  disabled?: boolean;
}

type Mode = 'recurring' | 'once';

function isOneShot(expr: string): boolean {
  return typeof expr === 'string' && expr.startsWith(ONE_SHOT_PREFIX);
}

function parseOneShotEpoch(expr: string): number | null {
  if (!isOneShot(expr)) return null;
  const n = Number(expr.slice(ONE_SHOT_PREFIX.length));
  return Number.isFinite(n) ? n : null;
}

/**
 * Format an epoch (seconds) as the ``YYYY-MM-DDTHH:mm`` string that
 * ``<input type="datetime-local">`` round-trips. Uses local time —
 * matching the input element's own semantics.
 */
function epochToLocalInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function localInputToEpoch(local: string): number | null {
  if (!local) return null;
  const ms = new Date(local).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function defaultLocalInput(): string {
  // Round to the next minute so the picker doesn't show seconds.
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 5);
  return epochToLocalInput(Math.floor(now.getTime() / 1000));
}

export default function CronPicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  label = 'Schedule',
  disabled = false,
}: Props) {
  const [preview, setPreview] = useState<CronDescribeResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Persisted across mode flips so toggling Recurring → Once → Recurring
  // doesn't lose the user's draft. Seeds from the incoming value the
  // first render, then drifts on local edits.
  const [mode, setMode] = useState<Mode>(() => (isOneShot(value) ? 'once' : 'recurring'));
  const [localDateTime, setLocalDateTime] = useState<string>(() => {
    const ep = parseOneShotEpoch(value);
    return ep != null ? epochToLocalInput(ep) : defaultLocalInput();
  });

  // Keep local mode in sync if the parent swaps in a value of a
  // different shape (e.g. switching between two scheduled tasks in a
  // single panel). Only flips when the *kind* changes, so typing a
  // free-form cron doesn't bounce us back into recurring.
  useEffect(() => {
    if (isOneShot(value) && mode !== 'once') {
      setMode('once');
      const ep = parseOneShotEpoch(value);
      if (ep != null) setLocalDateTime(epochToLocalInput(ep));
    } else if (!isOneShot(value) && mode === 'once' && value !== '') {
      setMode('recurring');
    }
  }, [value]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce describe calls so typing feels instant instead of
  // flooding the gateway per keystroke.
  useEffect(() => {
    if (!value) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await describeCron(value, 3);
        if (!cancelled) setPreview(res);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [value]);

  const isPreset = useMemo(
    () => presets.some((p) => p.expression === value),
    [presets, value],
  );

  const setRecurringMode = () => {
    if (disabled) return;
    if (mode === 'recurring') return;
    setMode('recurring');
    // If the active value was a one-shot, blank it so the recurring
    // input shows no "valid: false" preview from the now-stale cron.
    if (isOneShot(value)) onChange('');
  };

  const setOnceMode = () => {
    if (disabled) return;
    if (mode === 'once') return;
    setMode('once');
    // Seed the cron value with the current date input so the preview
    // shows the planned fire time immediately.
    const epoch = localInputToEpoch(localDateTime);
    if (epoch != null) onChange(`${ONE_SHOT_PREFIX}${epoch}`);
  };

  const handleLocalDateChange = (next: string) => {
    setLocalDateTime(next);
    const epoch = localInputToEpoch(next);
    if (epoch != null) onChange(`${ONE_SHOT_PREFIX}${epoch}`);
  };

  return (
    <View>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <View style={styles.modeRow}>
        <TouchableOpacity
          onPress={setRecurringMode}
          disabled={disabled}
          style={[
            styles.modeChip,
            mode === 'recurring' && styles.modeChipActive,
            disabled && styles.disabled,
          ]}
        >
          <Feather
            name="repeat"
            size={11}
            color={mode === 'recurring' ? colors.primary : colors.textMuted}
          />
          <Text
            style={[
              styles.modeText,
              mode === 'recurring' && styles.modeTextActive,
            ]}
          >
            Recurring
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={setOnceMode}
          disabled={disabled}
          style={[
            styles.modeChip,
            mode === 'once' && styles.modeChipActive,
            disabled && styles.disabled,
          ]}
        >
          <Feather
            name="calendar"
            size={11}
            color={mode === 'once' ? colors.primary : colors.textMuted}
          />
          <Text
            style={[styles.modeText, mode === 'once' && styles.modeTextActive]}
          >
            Once at…
          </Text>
        </TouchableOpacity>
      </View>

      {mode === 'recurring' ? (
        <>
          <View style={styles.presetRow}>
            {presets.map((p) => (
              <TouchableOpacity
                key={p.expression}
                onPress={() => !disabled && onChange(p.expression)}
                disabled={disabled}
                style={[
                  styles.presetChip,
                  value === p.expression && styles.presetChipActive,
                  disabled && styles.disabled,
                ]}
              >
                <Text
                  style={[
                    styles.presetText,
                    value === p.expression && styles.presetTextActive,
                  ]}
                >
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            style={[styles.input, disabled && styles.disabled]}
            value={isOneShot(value) ? '' : value}
            onChangeText={onChange}
            editable={!disabled}
            placeholder="Custom cron (e.g. 0 9 * * *)"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </>
      ) : Platform.OS === 'web' ? (
        // Native datetime-local input: round-trips ``YYYY-MM-DDTHH:mm``
        // in the user's local timezone. Saved epoch = local-clock epoch;
        // see the timezone hint below.
        <input
          type="datetime-local"
          value={localDateTime}
          onChange={(e: any) => handleLocalDateChange(e.target.value)}
          disabled={disabled}
          style={
            {
              backgroundColor: colors.inputBg,
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              padding: 9,
              color: colors.text,
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            } as any
          }
        />
      ) : (
        // Native fallback. Without a date-picker dependency we ask the
        // user to type the local string; the preview validates it.
        // Apps that ship the picker module can swap this in.
        <TextInput
          style={[styles.input, disabled && styles.disabled]}
          value={localDateTime}
          onChangeText={handleLocalDateChange}
          editable={!disabled}
          placeholder="YYYY-MM-DDTHH:mm (local time)"
          placeholderTextColor={colors.textMuted}
          autoCorrect={false}
          autoCapitalize="none"
        />
      )}

      {/* Preview area — valid + next 3, or error message. */}
      <View style={styles.previewBox}>
        {!value ? (
          <Text style={styles.previewMuted}>
            {mode === 'once'
              ? 'Pick a date and time to fire once.'
              : 'Pick a preset or enter a cron string.'}
          </Text>
        ) : loading ? (
          <Text style={styles.previewMuted}>Validating…</Text>
        ) : preview && preview.valid ? (
          <>
            <View style={styles.previewHeader}>
              <Feather name="check-circle" size={11} color={colors.success} />
              <Text style={styles.previewOk}>
                {preview.one_shot ? 'Fires once at:' : 'Next 3 runs:'}
              </Text>
            </View>
            {(preview.upcoming || []).map((u, i) => (
              <Text key={i} style={styles.previewLine}>
                {u.iso}
              </Text>
            ))}
            {mode === 'once' ? (
              <Text style={styles.previewHint}>
                Time is in your device's local clock — the agent's clock
                may differ on remote installs.
              </Text>
            ) : isPreset ? null : (
              <Text style={styles.previewHint}>
                Custom cron — 5 fields: minute hour day month weekday
              </Text>
            )}
          </>
        ) : (
          <View style={styles.previewHeader}>
            <Feather name="alert-circle" size={11} color={colors.error} />
            <Text style={styles.previewErr}>
              {preview?.error || 'Invalid cron expression'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeChipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  modeText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  modeTextActive: {
    color: colors.primary,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginBottom: 8,
  },
  presetChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetChipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  presetText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
  },
  presetTextActive: {
    color: colors.primary,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 12,
    fontFamily: font.mono,
  },
  previewBox: {
    marginTop: 8,
    padding: 8,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    minHeight: 42,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 3,
  },
  previewOk: {
    fontSize: 10,
    color: colors.success,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  previewErr: {
    fontSize: 11,
    color: colors.error,
    flex: 1,
  },
  previewLine: {
    fontSize: 11,
    color: colors.textSecondary,
    fontFamily: font.mono,
    lineHeight: 16,
  },
  previewMuted: {
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  previewHint: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    fontStyle: 'italic',
  },
  disabled: { opacity: 0.5 },
});
