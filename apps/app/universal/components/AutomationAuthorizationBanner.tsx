import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  AutomationAuthorization,
  AutomationKind,
} from '../../common/types';
import {
  ApiError,
  approveAutomationAuthorization,
  getAutomationAuthorization,
} from '../services/api';
import { colors, font, radius } from '../theme';

interface Props {
  kind: AutomationKind;
  id: string;
  required?: boolean;
  onAuthorized?: () => void;
}

/** Explicit review gate for definitions that predate durable authorization.
 *
 * The server deliberately refuses to auto-adopt them. This component fetches
 * the exact current digest and sends that same digest back only after the
 * authenticated user presses Approve.
 */
export default function AutomationAuthorizationBanner({
  kind, id, required = false, onAuthorized,
}: Props) {
  const [review, setReview] = useState<AutomationAuthorization | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!required) return;
    setLoading(true);
    setError(null);
    try {
      setReview(await getAutomationAuthorization(kind, id));
    } catch (cause: any) {
      setError(cause?.message ?? String(cause));
    } finally {
      setLoading(false);
    }
  }, [id, kind, required]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!required || review?.authorized) return null;

  const approve = async () => {
    if (!review || approving) return;
    setApproving(true);
    setError(null);
    try {
      await approveAutomationAuthorization(kind, id, review.digest);
      setReview({ ...review, authorized: true });
      onAuthorized?.();
    } catch (cause: any) {
      if (cause instanceof ApiError && cause.status === 409) {
        // The definition changed after review. Fetch the new exact revision
        // rather than ever retrying approval with a stale digest.
        await load();
        setError('The definition changed. Review the updated fields and digest before approving.');
      } else {
        setError(cause?.message ?? String(cause));
      }
    } finally {
      setApproving(false);
    }
  };

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Feather name="shield" size={16} color={colors.warning} style={styles.icon} />
      <View style={styles.content}>
        <Text style={styles.title}>Review required before this can run</Text>
        <Text style={styles.copy}>
          This enabled definition predates durable authorization. Review the
          fields on this screen, then approve this exact revision for scheduled
          execution.
        </Text>
        {review ? (
          <Text style={styles.digest} selectable>SHA-256 · {review.digest}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.warning} />
          ) : error && !review ? (
            <Pressable onPress={() => void load()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Retry review</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void approve()}
              disabled={!review || approving}
              style={[styles.approveButton, (!review || approving) && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Approve this exact automation revision"
            >
              {approving ? (
                <ActivityIndicator size="small" color={colors.textInverse} />
              ) : (
                <Feather name="check" size={13} color={colors.textInverse} />
              )}
              <Text style={styles.approveButtonText}>
                {approving ? 'Approving…' : 'Approve exact revision'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    marginBottom: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.mutedSoft,
  },
  icon: { marginTop: 1 },
  content: { flex: 1, gap: 7 },
  title: { color: colors.warning, fontSize: 12.5, fontWeight: '700' },
  copy: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 17 },
  digest: {
    color: colors.textMuted,
    fontFamily: font.mono,
    fontSize: 9.5,
    lineHeight: 14,
  },
  error: { color: colors.error, fontSize: 11, lineHeight: 15 },
  actions: { flexDirection: 'row', alignItems: 'center', minHeight: 30 },
  approveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: colors.warning,
  },
  approveButtonText: {
    color: colors.textInverse,
    fontSize: 11,
    fontWeight: '700',
  },
  secondaryButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  secondaryButtonText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  disabled: { opacity: 0.55 },
});
