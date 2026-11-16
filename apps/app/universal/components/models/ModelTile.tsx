/**
 * ModelTile — one configured model in the Models grid.
 *
 * Name, provider, how it is reached (Subscription / Local / API), its type,
 * the inputs a language model accepts, and one status line. The tile opens
 * the edit dialog; everything else lives in the overflow menu.
 */

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../theme';
import type { ModelEntry, ProviderAccounts } from '../../../common/types';
import PopupMenu, { type PopupMenuItem } from '../PopupMenu';
import {
  accountState, formatDuration, headroomColor, limitedRemainingS, quotaWindows, quotaWindowText,
  servingAccount,
} from '../accountQuota';
import {
  ACCESS_LABELS, KIND_LABELS, modelModalities, priceLabel, type Access, type ModelStatus,
} from './modelHelpers';
import { Badge, ModalityChips } from './ui';

const TONE_COLOR: Record<ModelStatus['tone'], string> = {
  danger: colors.error,
  warning: colors.warning,
  muted: colors.textMuted,
  primary: colors.primary,
  normal: colors.textSecondary,
};

export default function ModelTile({
  model, access, accounts, status, active, menu, onPress,
}: {
  model: ModelEntry;
  access: Access;
  /** /api/accounts entry for the provider; drawn for subscriptions. */
  accounts: ProviderAccounts | null;
  status: ModelStatus | null;
  /** Model and its provider are both on. */
  active: boolean;
  menu: PopupMenuItem[];
  onPress: () => void;
}) {
  const kind = model.kind ?? 'llm';
  const name = model.display_name || model.model;
  const modalities = kind === 'llm' ? modelModalities(model) : null;
  const price = kind === 'llm' ? priceLabel(model) : null;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.tile, !active && styles.tileOff]}
      accessibilityRole="button"
      accessibilityLabel={`Edit model ${name}`}
      {...(Platform.OS === 'web' ? ({ className: 'oa-hover-lift' } as any) : {})}
    >
      <View style={[styles.rail, active ? styles.railOn : styles.railOff]} />
      <View style={styles.body}>
        <View style={styles.headRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name} numberOfLines={1}>{name}</Text>
            <Text style={styles.provider} numberOfLines={1}>
              {model.provider_name}
              {model.display_name ? <Text style={styles.modelId}>{`  ·  ${model.model}`}</Text> : null}
            </Text>
          </View>
          <PopupMenu
            items={menu}
            accessibilityLabel={`Options for ${name}`}
            triggerSize={16}
            triggerStyle={styles.menuTrigger}
          />
        </View>

        <View style={styles.badges}>
          <Badge label={ACCESS_LABELS[access]} tone={access === 'subscription' ? 'primary' : 'neutral'} />
          <Badge label={KIND_LABELS[kind]} />
        </View>

        {modalities ? (
          <ModalityChips value={modalities.list} mode={modalities.mode} compact />
        ) : null}

        {model.tier_hint ? <Text style={styles.tierHint} numberOfLines={2}>{model.tier_hint}</Text> : null}
        {price ? (
          <Text style={styles.meta}>{price}</Text>
        ) : kind === 'llm' && access === 'api' ? (
          <Text style={styles.metaMuted}>No pricing</Text>
        ) : null}

        {access === 'subscription' ? <SubscriptionQuota entry={accounts} /> : null}

        <View style={{ flex: 1 }} />
        {status ? (
          <View style={styles.statusRow}>
            {status.tone === 'danger' || status.tone === 'warning' ? (
              <Feather name="alert-circle" size={11} color={TONE_COLOR[status.tone]} />
            ) : (
              <View style={[styles.dot, { backgroundColor: TONE_COLOR[status.tone] }]} />
            )}
            <Text style={[styles.statusText, { color: TONE_COLOR[status.tone] }]} numberOfLines={1}>
              {status.label}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The account serving this provider now, and how much of its window is used. */
function SubscriptionQuota({ entry }: { entry: ProviderAccounts | null }) {
  const account = servingAccount(entry);
  if (!entry || !account) {
    return <Text style={styles.metaMuted}>No accounts reported</Text>;
  }
  const count = entry.accounts.length;
  const state = accountState(account);
  const remaining = limitedRemainingS(account);
  const windows = quotaWindows(account);
  const plan = account.plan || account.quota?.plan;
  return (
    <View style={styles.quota}>
      <Text style={styles.meta} numberOfLines={1}>
        {[account.name || account.id, plan, count > 1 ? `${count} accounts` : null].filter(Boolean).join(' · ')}
      </Text>
      {state === 'rate_limited' ? (
        <Text style={[styles.meta, { color: colors.warning }]}>
          {remaining !== null ? `Limited · available in ${formatDuration(remaining)}` : 'Limited'}
        </Text>
      ) : null}
      {windows.length > 0 ? windows.map((w) => (
        <View key={w.label} style={styles.quotaWindow}>
          <View style={styles.meterTrack}>
            <View
              style={[
                styles.meterFill,
                { width: `${Math.min(100, Math.max(0, w.usedPercent))}%`, backgroundColor: headroomColor(w.usedPercent) },
              ]}
            />
          </View>
          <Text style={styles.meterText} numberOfLines={1}>{quotaWindowText(w)}</Text>
        </View>
      )) : (
        <Text style={styles.metaMuted}>Quota not reported</Text>
      )}
      {typeof account.quota?.credits_balance === 'number' ? (
        <Text style={styles.metaMuted}>{`${account.quota.credits_balance} credits`}</Text>
      ) : null}
    </View>
  );
}

/** Dashed last cell that opens the add wizard. */
export function AddModelTile({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.addTile}
      accessibilityRole="button"
      accessibilityLabel="Add model"
      {...(Platform.OS === 'web' ? ({ className: 'oa-hover-lift' } as any) : {})}
    >
      <Feather name="plus" size={16} color={colors.primary} />
      <Text style={styles.addText}>Add model</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: 132,
    flex: 1,
  },
  tileOff: { opacity: 0.72 },
  rail: { width: 3 },
  railOn: { backgroundColor: colors.primary },
  railOff: { backgroundColor: colors.borderStrong },
  body: { flex: 1, padding: 14, gap: 8, minWidth: 0 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  name: {
    fontSize: 14, fontWeight: '600', color: colors.text,
    fontFamily: font.sans, letterSpacing: -0.2,
  },
  provider: { fontSize: 11.5, color: colors.textSecondary, marginTop: 2, fontFamily: font.mono },
  modelId: { color: colors.textMuted },
  menuTrigger: { padding: 2, borderRadius: radius.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  tierHint: { fontSize: 11.5, color: colors.textSecondary, lineHeight: 16 },
  meta: { fontSize: 11, color: colors.textSecondary, fontFamily: font.mono },
  metaMuted: { fontSize: 11, color: colors.textMuted },
  quota: { gap: 5 },
  quotaWindow: { gap: 3 },
  meterTrack: { height: 4, borderRadius: 2, backgroundColor: colors.inputBg, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 2 },
  meterText: { fontSize: 10.5, color: colors.textMuted },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { flex: 1, fontSize: 11.5, fontFamily: font.mono },

  addTile: {
    minHeight: 132,
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  addText: { fontSize: 13, color: colors.primary, fontWeight: '600' },
});
