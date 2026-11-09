import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useConnection } from '../stores/connection';
import { useConfirm } from './ConfirmDialog';
import Button from './Button';
import Input from './Input';
import ThemedSwitch from './ThemedSwitch';
import { accountAgentPresentation } from '../../common/account-target-recovery';
import { colors, font, radius, spacing, tracking, glassSurface } from '../theme';

export type AgentAccountPanelMode = 'connect' | 'open-window';

interface AgentAccountPanelProps {
  mode: AgentAccountPanelMode;
  embedded?: boolean;
  addOnly?: boolean;
  reconnectAccountId?: string | null;
  preferredAccountId?: string | null;
  onAttempt?: () => void;
  onComplete?: () => void;
}

/** Shared account-management surface used by both cold start and the
 * in-app agent switcher. Remembered secrets never enter this component: it
 * receives only the main-process outcome and asks for a password only when
 * that outcome says the credential is missing or invalid. */
export default function AgentAccountPanel({
  mode,
  embedded = false,
  addOnly = false,
  reconnectAccountId,
  preferredAccountId,
  onAttempt,
  onComplete,
}: AgentAccountPanelProps) {
  const confirm = useConfirm();
  const {
    accounts,
    activeAccountId,
    isConnected,
    isConnecting,
    isLoading,
    isRestoringSession,
    error,
    rememberedFailure,
    credentialStorageAvailable,
    refreshCredentialAvailability,
    connectAccount,
    connectRememberedAccount,
    joinNetwork,
    joinNetworkInNewWindow,
    removeAccount,
    openAccountWindow,
  } = useConnection();

  const [adding, setAdding] = useState(addOnly);
  const [signInId, setSignInId] = useState<string | null>(reconnectAccountId ?? preferredAccountId ?? null);
  const [passwordId, setPasswordId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [selectedAgentHandle, setSelectedAgentHandle] = useState('');
  const [directory, setDirectory] = useState<{
    accountId: string;
    agents: { handle: string; label: string }[];
    error?: string;
  } | null>(null);
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [ticket, setTicket] = useState('');
  const [handle, setHandle] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [intent, setIntent] = useState<{
    role: 'user' | 'device' | 'agent';
    bindTo: string;
    networkName: string;
  } | null>(null);

  const showPassword = !!signInId && passwordId === signInId && retryId !== signInId;
  const legacyAccount = !adding && showPassword
    ? accounts.find((account) => account.id === signInId && !account.agentHandle)
    : undefined;
  const currentDirectory = directory?.accountId === signInId ? directory : null;
  const needsSelection = !!legacyAccount;
  const targetReady = !needsSelection || !!currentDirectory?.agents.some(({ handle }) => handle === selectedAgentHandle);

  useEffect(() => {
    if (!legacyAccount) return;
    const { id, network, handle } = legacyAccount;
    const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
    setDirectory(null);
    setSelectedAgentHandle('');
    if (!desktop?.listSavedNetworkAgents) {
      setDirectory({ accountId: id, agents: [], error: 'Agent discovery requires the desktop app.' });
      return;
    }
    let current = true;
    void desktop.listSavedNetworkAgents(network, handle).then(agents => {
      if (!current) return;
      const savedLabel = accountAgentPresentation(legacyAccount).primary.toLowerCase();
      const matches = agents.filter(agent => agent.handle.toLowerCase() === savedLabel
        || agent.label.toLowerCase() === savedLabel);
      // An old label is a suggestion for the visible picker. The saved
      // target is pinned only after successful login with that choice.
      const suggested = agents.length === 1 ? agents[0] : matches.length === 1 ? matches[0] : null;
      setSelectedAgentHandle(suggested?.handle ?? '');
      setDirectory({
        accountId: id,
        agents,
        ...(agents.length ? {} : { error: 'No agents are registered in this network.' }),
      });
    }).catch(() => {
      if (current) setDirectory({ accountId: id, agents: [], error: 'Could not load agents from this network.' });
    });
    return () => { current = false; };
  }, [legacyAccount, directoryRetry]);

  const transition = useRef(new Animated.Value(1)).current;
  const uiAttempt = useRef(0);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void refreshCredentialAvailability();
  }, [refreshCredentialAvailability]);

  useEffect(() => {
    if (!isLoading && accounts.length === 0) setAdding(true);
  }, [isLoading, accounts.length]);

  useEffect(() => {
    if (preferredAccountId) setSignInId(preferredAccountId);
  }, [preferredAccountId]);

  useEffect(() => {
    if (!rememberedFailure || addOnly || (reconnectAccountId && rememberedFailure.accountId !== reconnectAccountId)) return;
    setSignInId(rememberedFailure.accountId);
    setRetryId(rememberedFailure.kind === 'retryable' ? rememberedFailure.accountId : null);
    setPasswordId(rememberedFailure.kind === 'retryable' ? null : rememberedFailure.accountId);
  }, [rememberedFailure, addOnly, reconnectAccountId]);

  // Small cross-platform layout transition for list ↔ join and inline auth
  // states; deliberately short and limited to opacity/translation.
  useEffect(() => {
    transition.setValue(0);
    Animated.timing(transition, {
      toValue: 1,
      duration: reduceMotion ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [adding, signInId, passwordId, retryId, reduceMotion, transition]);

  useEffect(() => {
    if (attempted && isConnected && !isConnecting) {
      setAttempted(false);
      onComplete?.();
    }
  }, [attempted, isConnected, isConnecting, onComplete]);

  useEffect(() => {
    const value = ticket.trim();
    if (!value.startsWith('oa1')) {
      setIntent(null);
      return;
    }
    const desktop = typeof window !== 'undefined' ? (window as any).desktop : null;
    if (typeof desktop?.decodeTicket !== 'function') {
      setIntent(null);
      return;
    }
    let cancelled = false;
    void desktop.decodeTicket(value).then((decoded: any) => {
      if (cancelled) return;
      if (!decoded || typeof decoded !== 'object') {
        setIntent(null);
        return;
      }
      setIntent({
        role: decoded.role,
        bindTo: decoded.bindTo ?? '',
        networkName: decoded.networkName ?? '',
      });
      if (decoded.role === 'device' && decoded.bindTo) setHandle(decoded.bindTo);
    });
    return () => { cancelled = true; };
  }, [ticket]);

  const animateStyle = {
    opacity: transition,
    transform: [{
      translateY: transition.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }),
    }],
  };

  const beginRemembered = async (accountId: string) => {
    const attemptToken = mode === 'connect' ? ++uiAttempt.current : 0;
    setAdding(false);
    setSignInId(accountId);
    setPassword('');
    setSelectedAgentHandle('');
    setPasswordId(null);
    setRetryId(null);
    setLocalError(null);
    setBusyId(accountId);
    onAttempt?.();

    if (mode === 'open-window') {
      const result = await openAccountWindow(accountId);
      setBusyId((current) => current === accountId ? null : current);
      if (result.ok) {
        onComplete?.();
      } else if (result.retryable) {
        setRetryId(accountId);
        setLocalError(result.error ?? 'Could not reach that agent.');
      } else {
        if (result.needsPassword) setPasswordId(accountId);
        setLocalError(result.error ?? null);
      }
      return;
    }

    setAttempted(true);
    const result = await connectRememberedAccount(accountId);
    if (attemptToken !== uiAttempt.current) return;
    setBusyId((current) => current === accountId ? null : current);
    if (result.status === 'retryable_error') setRetryId(accountId);
    if (result.status === 'missing' || result.status === 'invalid') setPasswordId(accountId);
  };

  const submitPassword = async () => {
    if (!signInId || !password || !targetReady) return;
    const attemptToken = mode === 'connect' ? ++uiAttempt.current : 0;
    const submittedPassword = password;
    setPassword('');
    setLocalError(null);
    setBusyId(signInId);
    onAttempt?.();
    if (mode === 'open-window') {
      const result = await openAccountWindow(
        signInId,
        submittedPassword,
        credentialStorageAvailable && remember,
        needsSelection ? selectedAgentHandle : undefined,
      );
      setBusyId((current) => current === signInId ? null : current);
      if (result.ok) {
        onComplete?.();
      } else {
        setLocalError(result.error ?? 'Could not open that agent.');
      }
      return;
    }

    setAttempted(true);
    await connectAccount(
      signInId,
      submittedPassword,
      credentialStorageAvailable && remember,
      needsSelection ? selectedAgentHandle : undefined,
    );
    if (attemptToken !== uiAttempt.current) return;
    setBusyId((current) => current === signInId ? null : current);
  };

  const retryRemembered = () => {
    if (signInId) void beginRemembered(signInId);
  };

  const submitJoin = async () => {
    const normalizedTicket = ticket.trim();
    const normalizedHandle = handle.trim().toLowerCase();
    if (!normalizedTicket.startsWith('oa1') || !normalizedHandle || !joinPassword) return;
    const attemptToken = ++uiAttempt.current;
    const submittedPassword = joinPassword;
    setJoinPassword('');
    onAttempt?.();
    const joinArgs = {
      ticket: normalizedTicket,
      handle: normalizedHandle,
      password: submittedPassword,
      remember: credentialStorageAvailable && remember,
      isLocal: false,
    };
    if (mode === 'open-window') {
      const opened = await joinNetworkInNewWindow(joinArgs);
      if (attemptToken !== uiAttempt.current) return;
      if (opened) onComplete?.();
      return;
    }
    setAttempted(true);
    await joinNetwork(joinArgs);
    if (attemptToken !== uiAttempt.current) return;
  };

  const confirmRemove = async (accountId: string, name: string) => {
    const accepted = await confirm({
      title: 'Remove agent',
      message: `Forget "${name}"? You'll need the invite and password again to reconnect.`,
      confirmLabel: 'Remove',
    });
    if (!accepted) return;
    await removeAccount(accountId);
    if (signInId === accountId) setSignInId(null);
  };

  const displayError = localError || (adding && !attempted ? null : error);
  const restoring = embedded && (isLoading || isRestoringSession);

  return (
    <View
      style={[styles.surface, embedded && styles.embeddedSurface]}
      {...(Platform.OS === 'web' ? { className: 'oa-slide-up' } as any : {})}
    >
      <View style={styles.rail} />
      <Text style={styles.title}>{adding ? 'Add an agent' : reconnectAccountId ? 'Sign in again' : 'Your agents'}</Text>
      {!adding && mode === 'open-window' ? (
        <Text style={styles.sheetHint}>Each agent opens in its own window.</Text>
      ) : null}

      {restoring ? (
        <View style={styles.restoring} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.restoringText}>
            {isLoading ? 'Loading your agents…' : 'Unlocking your saved agent…'}
          </Text>
        </View>
      ) : (
        <Animated.View style={animateStyle}>
          {adding ? (
            <View style={styles.joinForm}>
              <Input
                label="Invite ticket"
                value={ticket}
                onChangeText={setTicket}
                placeholder="oa1abcdef… (from `openagent invite`)"
                autoCapitalize="none"
                autoCorrect={false}
                mono
                containerStyle={{ marginTop: 0 }}
              />
              {intent ? (
                <Text style={styles.hint}>
                  {intent.role === 'device' && intent.bindTo
                    ? `Joining ${intent.networkName || 'this network'} as ${intent.bindTo}.`
                    : `Joining ${intent.networkName || 'this network'} — pick a handle.`}
                </Text>
              ) : null}
              <Input
                label="Handle"
                value={handle}
                onChangeText={setHandle}
                placeholder="alice"
                autoCapitalize="none"
                autoCorrect={false}
                mono
                containerStyle={{ marginTop: spacing.md }}
                editable={intent?.role !== 'device'}
              />
              <Input
                label="Password"
                value={joinPassword}
                onChangeText={setJoinPassword}
                placeholder="••••••••"
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                containerStyle={{ marginTop: spacing.md }}
                onSubmitEditing={submitJoin}
              />
              <RememberControl
                available={credentialStorageAvailable}
                value={remember}
                onValueChange={setRemember}
              />
              {displayError ? <ErrorText message={displayError} /> : null}
              <View style={styles.joinActions}>
                {accounts.length > 0 && !addOnly ? (
                  <Button
                    label="Back"
                    variant="ghost"
                    size="sm"
                    icon="arrow-left"
                    onPress={() => setAdding(false)}
                    disabled={isConnecting}
                  />
                ) : <View />}
                <Button
                  label={isConnecting ? 'Joining…' : 'Join network'}
                  variant="primary"
                  size="sm"
                  onPress={submitJoin}
                  disabled={
                    isConnecting || !ticket.trim().startsWith('oa1') ||
                    !handle.trim() || !joinPassword
                  }
                />
              </View>
            </View>
          ) : (
            <>
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {accounts.length === 0 ? (
                  <Text style={styles.empty}>No agents yet — add one to begin.</Text>
                ) : accounts.filter((a) => !reconnectAccountId || a.id === reconnectAccountId).map((account, index) => {
                  const active = account.id === activeAccountId && isConnected;
                  const selected = signInId === account.id;
                  const presentation = accountAgentPresentation(account);
                  const label = presentation.alias ?? presentation.primary;
                  const retrying = selected && retryId === account.id;
                  return (
                    <View key={account.id} style={[styles.rowWrap, index > 0 && styles.rowBorder]}>
                      <View style={styles.row}>
                        <Pressable
                          style={styles.rowMain}
                          onPress={() => void beginRemembered(account.id)}
                          disabled={(active && mode === 'connect') || busyId === account.id}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } as any : {})}
                        >
                          <View style={styles.rowAvatar}>
                            <Text style={styles.rowAvatarText}>{label.slice(0, 1).toUpperCase()}</Text>
                          </View>
                          <View style={styles.rowText}>
                            <Text style={styles.rowName} numberOfLines={1}>{label}</Text>
                            <Text style={styles.rowSub} numberOfLines={1}>
                              {presentation.verified
                                ? `Target: ${presentation.primary} · @${account.handle}`
                                : `${account.handle}@${account.network}`}
                            </Text>
                          </View>
                          {busyId === account.id ? (
                            <ActivityIndicator size="small" color={colors.accent} />
                          ) : active ? (
                            <Feather name="check" size={16} color={colors.accent} />
                          ) : (
                            <Feather
                              name={mode === 'open-window' ? 'external-link' : 'chevron-right'}
                              size={14}
                              color={colors.textMuted}
                            />
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => void confirmRemove(account.id, account.name)}
                          hitSlop={8}
                          style={styles.iconButton}
                          accessibilityLabel="Remove agent"
                        >
                          <Feather name="trash-2" size={14} color={colors.textMuted} />
                        </Pressable>
                      </View>

                      {selected && retrying ? (
                        <Animated.View style={[styles.retryBox, animateStyle]}>
                          {displayError ? <ErrorText message={displayError} compact /> : null}
                          <View style={styles.retryActions}>
                            <Button
                              label={busyId === account.id ? 'Retrying…' : 'Retry'}
                              variant="primary"
                              size="sm"
                              icon="refresh-cw"
                              onPress={retryRemembered}
                              disabled={busyId === account.id}
                            />
                            <Button
                              label="Change password"
                              variant="ghost"
                              size="sm"
                              onPress={() => {
                                setRetryId(null);
                                setPasswordId(account.id);
                                setLocalError(null);
                              }}
                            />
                          </View>
                        </Animated.View>
                      ) : selected && showPassword && !active ? (
                        <Animated.View style={[styles.passwordArea, animateStyle]}>
                          {needsSelection && !currentDirectory ? (
                            <Text style={styles.directoryHint} accessibilityLiveRegion="polite">
                              Finding agents in this network…
                            </Text>
                          ) : null}
                          {needsSelection && currentDirectory?.error ? (
                            <View style={styles.directory}>
                              <ErrorText message={currentDirectory.error} compact />
                              <Button label="Reload agents" variant="ghost" size="sm"
                                onPress={() => setDirectoryRetry(value => value + 1)} />
                            </View>
                          ) : null}
                          {needsSelection && (currentDirectory?.agents.length ?? 0) > 1 ? (
                            <View style={styles.directory}>
                              <Text style={styles.directoryTitle}>Choose the agent for this saved login</Text>
                              <ScrollView style={styles.directoryList} keyboardShouldPersistTaps="handled">
                                {currentDirectory?.agents.map(agent => {
                                  const selected = agent.handle === selectedAgentHandle;
                                  const label = agent.label === agent.handle ? agent.label : `${agent.label} · ${agent.handle}`;
                                  return (
                                    <Pressable key={agent.handle} accessibilityRole="radio"
                                      accessibilityLabel={label}
                                      accessibilityState={{ checked: selected }}
                                      {...(Platform.OS === 'web' ? { 'aria-checked': selected } : {})}
                                      onPress={() => setSelectedAgentHandle(agent.handle)}
                                      style={styles.directoryOption}>
                                      <Feather name={selected ? 'check-circle' : 'circle'} size={14}
                                        color={selected ? colors.accent : colors.textMuted} />
                                      <Text style={styles.directoryLabel} numberOfLines={1}>{label}</Text>
                                    </Pressable>
                                  );
                                })}
                              </ScrollView>
                            </View>
                          ) : null}
                          <View style={styles.passwordRow}>
                            <Input
                              value={password}
                              onChangeText={setPassword}
                              placeholder="Password"
                              secureTextEntry
                              autoComplete="current-password"
                              textContentType="password"
                              autoFocus
                              containerStyle={{ flex: 1, marginTop: 0 }}
                              onSubmitEditing={submitPassword}
                            />
                            <Button
                              label={mode === 'open-window' ? 'Open' : 'Connect'}
                              variant="primary"
                              size="sm"
                              onPress={submitPassword}
                              disabled={busyId === account.id || !password || !targetReady}
                            />
                          </View>
                          <RememberControl
                            available={credentialStorageAvailable}
                            value={remember}
                            onValueChange={setRemember}
                          />
                          {displayError ? <ErrorText message={displayError} compact /> : null}
                        </Animated.View>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              {!reconnectAccountId && <View style={styles.addFoot}>
                <Button
                  label="Add an agent"
                  variant="secondary"
                  icon="plus"
                  size="sm"
                  onPress={() => {
                    setAdding(true);
                    setSignInId(null);
                    setPasswordId(null);
                    setRetryId(null);
                    setLocalError(null);
                  }}
                  fullWidth
                />
              </View>}
            </>
          )}
        </Animated.View>
      )}
    </View>
  );
}

function RememberControl({
  available,
  value,
  onValueChange,
}: {
  available: boolean;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  if (!available) {
    return (
      <Text style={styles.securityHint}>
        Remember me is unavailable because secure OS credential storage is not available.
      </Text>
    );
  }
  return (
    <View style={styles.rememberRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rememberLabel}>Remember me on this device</Text>
        <Text style={styles.securityHint}>Protected by your operating system keychain.</Text>
      </View>
      <ThemedSwitch value={value} onValueChange={onValueChange} />
    </View>
  );
}

function ErrorText({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <View style={[styles.errorBox, compact && styles.errorBoxCompact]}>
      <Feather name="alert-triangle" size={13} color={colors.error} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: glassSurface.backgroundColor,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? ({ backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter } as any)
      : {}),
    shadowColor: colors.shadowColorStrong,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 1,
    shadowRadius: 32,
  },
  embeddedSurface: { alignSelf: 'center' },
  rail: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 2,
    backgroundColor: colors.panelRail,
    ...(Platform.OS === 'web' ? ({ boxShadow: `0 0 8px ${colors.accentGlow}` } as any) : {}),
  },
  title: {
    fontFamily: font.display,
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: tracking.wider,
    fontWeight: '600',
  },
  sheetHint: {
    fontFamily: font.sans, fontSize: 11, color: colors.textMuted,
    paddingHorizontal: spacing.lg, marginTop: -spacing.xs, paddingBottom: spacing.sm,
  },
  restoring: {
    minHeight: 96, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
  },
  restoringText: { fontFamily: font.sans, fontSize: 13, color: colors.textSecondary },
  list: { maxHeight: 380 },
  listContent: { paddingBottom: spacing.xs },
  empty: { fontFamily: font.sans, fontSize: 13, color: colors.textMuted, padding: spacing.lg },
  rowWrap: { paddingHorizontal: spacing.sm },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowMain: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, borderRadius: radius.md, minWidth: 0,
  },
  rowAvatar: {
    width: 30, height: 30, borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  rowAvatarText: { fontFamily: font.display, fontSize: 12.5, color: colors.accent, fontWeight: '600' },
  rowText: { flex: 1, gap: 2, minWidth: 0 },
  rowName: { fontFamily: font.sans, fontSize: 13.5, color: colors.text, fontWeight: '600' },
  rowSub: { fontFamily: font.mono, fontSize: 11, color: colors.textMuted },
  iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  passwordArea: { paddingBottom: spacing.sm },
  directory: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  directoryHint: {
    fontSize: 12, color: colors.textMuted, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm,
  },
  directoryTitle: { fontSize: 12, color: colors.textSecondary, marginBottom: spacing.xs },
  directoryList: { maxHeight: 150 },
  directoryOption: { minHeight: 32, flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  directoryLabel: { flex: 1, color: colors.text, fontSize: 12 },
  passwordRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  retryBox: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  retryActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  joinForm: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  joinActions: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.lg },
  hint: { fontFamily: font.sans, fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 15 },
  addFoot: {
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.borderLight, marginTop: spacing.xs,
  },
  rememberRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    marginTop: spacing.sm, paddingHorizontal: spacing.xs,
  },
  rememberLabel: { fontFamily: font.sans, fontSize: 11.5, color: colors.textSecondary },
  securityHint: { fontFamily: font.sans, fontSize: 10.5, color: colors.textMuted, marginTop: 4, lineHeight: 14 },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: colors.errorBorder,
    borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 10, marginTop: spacing.sm,
  },
  errorBoxCompact: { marginHorizontal: 0 },
  errorText: { flex: 1, color: colors.error, fontFamily: font.sans, fontSize: 11.5, lineHeight: 16 },
});
