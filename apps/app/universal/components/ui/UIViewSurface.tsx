import { useEffect, useMemo, useRef, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { useIsFocused } from '@react-navigation/native';
import { useNavigation, useRouter } from 'expo-router';
import { ActivityIndicator, Dimensions, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useUIViews } from '../../stores/uiViews';
import { colors, font, radius } from '../../theme';
import Button from '../Button';
import Card from '../Card';
import OAUIRenderer from './OAUIRenderer';

export default function UIViewSurface({
  viewId,
  revision,
  mode,
  active = true,
  ancestry = [],
}: {
  viewId: string;
  revision?: number;
  mode: 'inline' | 'page';
  active?: boolean;
  ancestry?: string[];
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const hostRef = useRef<any>(null);
  const visible = useSurfaceVisibility(hostRef, active && focused);
  const pinned = revision != null && revision > 0;
  const cacheKey = pinned ? `${viewId}@${revision}` : viewId;
  const circular = ancestry.includes(cacheKey) || ancestry.length >= 8;
  const view = useUIViews((state) => state.views[cacheKey]);
  const summary = useUIViews((state) => state.items.find((item) => item.id === viewId));
  const loading = useUIViews((state) => !!state.loadingViews[cacheKey]);
  const error = useUIViews((state) => state.viewErrors[cacheKey] ?? state.viewErrors[viewId]);
  const sourceStatus = useUIViews((state) => state.sourceStatus[viewId]);
  const compact = mode === 'inline';

  useEffect(() => {
    if (circular || !active || !focused || !visible) return;
    void useUIViews.getState().loadView(
      viewId,
      pinned ? { revision } : undefined,
    );
  }, [active, circular, focused, pinned, revision, viewId, visible]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    const start = () => {
      if (dispose || circular || !active || !visible || !navigation.isFocused()) return;
      dispose = useUIViews.getState().subscribe(viewId, {
        revision: pinned ? revision : undefined,
        knownRevision: view?.revision,
      });
    };
    const stop = () => {
      dispose?.();
      dispose = undefined;
    };
    start();
    // Explicit listeners matter with Drawer freezeOnBlur: the blur callback
    // runs even when React defers rendering the frozen chat subtree, so a
    // hidden dashboard never leaves a source pipeline alive in the meantime.
    const offFocus = navigation.addListener('focus', start);
    const offBlur = navigation.addListener('blur', stop);
    return () => { stop(); offFocus(); offBlur(); };
  }, [active, circular, navigation, pinned, revision, view?.revision, viewId, visible]);

  const data = useMemo(
    () => Object.fromEntries(Object.entries(view?.data ?? {}).map(([key, entry]) => [key, entry.value])),
    [view?.data],
  );
  const statuses = Object.values(sourceStatus ?? {});
  const liveError = statuses.find((status) => status.error)?.error;
  const status = view?.status ?? summary?.status;
  const dataEntries = Object.values(view?.data ?? {});
  const presentationState = liveError || dataEntries.some((entry) => entry.status === 'error')
    ? 'error'
    : view?.frozen || status === 'stale' || statuses.some((item) => item.status === 'expired' || item.status === 'stale') || dataEntries.some((entry) => entry.status === 'stale')
      ? 'stale'
      : dataEntries.some((entry) => entry.status === 'loading') || (statuses.some((item) => item.status === 'starting' || item.status === 'loading') && dataEntries.length === 0)
        ? 'loading'
        : dataEntries.some((entry) => entry.status === 'empty') || (dataEntries.length > 0 && dataEntries.every((entry) => emptyValue(entry.value)))
          ? 'empty'
          : undefined;

  return (
    <View ref={hostRef} style={compact ? styles.inlineHost : styles.pageHost}>
      <Card tight={compact} style={[styles.card, compact && styles.inlineCard]}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Feather name={safeIcon(view?.icon ?? summary?.icon)} size={14} color={colors.accent} />
          </View>
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>{view?.title ?? summary?.title ?? 'Custom view'}</Text>
            {view?.description ?? summary?.description ? (
              <Text style={styles.description} numberOfLines={compact ? 1 : 2}>{view?.description ?? summary?.description}</Text>
            ) : null}
          </View>
          {view?.frozen ? <Feather name="pause-circle" size={12} color={colors.textMuted} /> : null}
          {visible && focused && status === 'active' && !view?.frozen ? <View style={styles.liveDot} accessibilityLabel="Live" /> : null}
          {compact ? (
            <Pressable
              onPress={() => router.push(`/views/${encodeURIComponent(viewId)}${pinned ? `?revision=${revision}` : ''}` as any)}
              style={styles.expand}
              accessibilityRole="button"
              accessibilityLabel="Open view"
              {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } as any : {})}
            >
              <Feather name="maximize-2" size={13} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        {circular ? (
          <View style={styles.error}><Feather name="repeat" size={15} color={colors.error} /><Text style={styles.errorText}>Circular or excessively deep sub-view reference blocked.</Text></View>
        ) : status === 'expired' || status === 'deleted' ? (
          <View style={styles.state}>
            <Feather name="clock" size={17} color={colors.warning} />
            <Text style={styles.stateText}>{status === 'deleted' ? 'This view was removed.' : 'This view has expired.'}</Text>
            {!compact && view?.surface === 'sidebar' ? (
              <Button size="sm" variant="secondary" label="Reactivate" onPress={() => { void useUIViews.getState().reactivate(viewId); }} />
            ) : null}
          </View>
        ) : loading && !view ? (
          <View style={styles.state}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.stateText}>Loading view…</Text></View>
        ) : error ? (
          <View style={styles.error}><Feather name="alert-circle" size={15} color={colors.error} /><Text style={styles.errorText}>{error}</Text><Button label="Retry" size="xs" variant="ghost" onPress={() => { void useUIViews.getState().loadView(viewId, pinned ? { revision, force: true } : true); }} /></View>
        ) : view ? (
          <View style={styles.body}>
            {liveError ? <View style={styles.sourceError}><Feather name="wifi-off" size={12} color={colors.warning} /><Text style={styles.sourceErrorText}>{liveError}</Text></View> : null}
            <OAUIRenderer
              key={`${view.id}@${view.revision}`}
              spec={view.spec}
              data={data}
              actions={view.actions}
              canExecute={view.canExecute === true}
              compact={compact}
              presentationState={presentationState}
              viewContext={{ viewId: view.id, revision: view.revision }}
              renderSubView={(nestedId, nestedRevision) => (
                <UIViewSurface
                  viewId={nestedId}
                  revision={nestedRevision}
                  mode="inline"
                  active={active && visible && focused}
                  ancestry={[...ancestry, cacheKey]}
                />
              )}
              onAction={(actionId, input) => useUIViews.getState().invokeAction(
                viewId,
                actionId,
                input,
                view.revision,
                pinned ? revision : undefined,
              )}
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
}

function emptyValue(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value as object).length === 0;
}

function useSurfaceVisibility(ref: { current: any }, active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    if (Platform.OS !== 'web') {
      let cancelled = false;
      const measure = () => {
        const element = ref.current;
        if (!element?.measureInWindow) { setVisible(true); return; }
        element.measureInWindow((_x: number, y: number, width: number, height: number) => {
          if (cancelled) return;
          const viewportHeight = Dimensions.get('window').height;
          setVisible(width > 0 && height > 0 && y < viewportHeight + 120 && y + height > -120);
        });
      };
      measure();
      const timer = setInterval(measure, 1_000);
      return () => { cancelled = true; clearInterval(timer); };
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const element = ref.current;
    if (!element) { setVisible(true); return; }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)),
      { rootMargin: '120px 0px', threshold: 0.01 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, ref]);
  return active && visible;
}

function safeIcon(value?: string): keyof typeof Feather.glyphMap {
  return value && Object.prototype.hasOwnProperty.call(Feather.glyphMap, value)
    ? value as keyof typeof Feather.glyphMap
    : 'layout';
}

const styles = StyleSheet.create({
  inlineHost: { width: '100%', marginTop: 10 },
  pageHost: { width: '100%' },
  card: { width: '100%' },
  inlineCard: { backgroundColor: colors.surfaceElevated },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  headerIcon: { width: 27, height: 27, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.border },
  titleWrap: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.sans, color: colors.text, fontSize: 12.5, fontWeight: '600' },
  description: { fontFamily: font.sans, color: colors.textMuted, fontSize: 10.5, lineHeight: 15, marginTop: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  expand: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  body: { marginTop: 13 },
  state: { minHeight: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 14 },
  stateText: { fontFamily: font.sans, color: colors.textSecondary, fontSize: 12 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: colors.errorBorder, borderRadius: radius.md },
  errorText: { flex: 1, fontFamily: font.sans, color: colors.error, fontSize: 11 },
  sourceError: { flexDirection: 'row', alignItems: 'center', gap: 7, padding: 8, marginBottom: 10, backgroundColor: colors.mutedSoft, borderRadius: radius.sm },
  sourceErrorText: { flex: 1, fontFamily: font.sans, color: colors.warning, fontSize: 10.5 },
});
