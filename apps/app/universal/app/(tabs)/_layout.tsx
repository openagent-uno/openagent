/**
 * Authenticated app shell — a react-navigation Drawer.
 *
 * One navigator drives both form factors (no collapsed middle stage):
 *   - tablet / desktop (≥768): the full Sidebar starts open beside the
 *     content, but remains toggleable from the symmetric header button.
 *   - phone (<768): `drawerType: 'back'` — the same full Sidebar rides in a
 *     drawer; the content slides right to reveal it (Claude-style), toggled
 *     by the menu button in each screen's header.
 *
 * The Sidebar is the drawer content. Navigation is plain expo-router
 * (`router.push` from the Sidebar); each route renders the real
 * react-navigation header with its own title + actions (see the per-tab
 * stacks and `components/screenHeader.tsx`). Pushed workspace screens pair
 * Back with the sidebar toggle; detached terminals can keep Back alone.
 */

import { createDrawerNavigator } from '@react-navigation/drawer';
import { usePathname, useRouter, withLayoutContext } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import Sidebar from '../../components/Sidebar';
import DrawerResizeHandle from '../../components/DrawerResizeHandle';
import GlobalSearchOverlay from '../../components/search/GlobalSearchOverlay';
import { HeaderMenu, themedHeader } from '../../components/screenHeader';
import { useLayout } from '../../hooks/useLayout';
import {
  useReducedMotion,
  useWebInert,
  webDrawerWidthTransition,
} from '../../hooks/useDrawerMotion';
import { useConnection } from '../../stores/connection';
import { useChat } from '../../stores/chat';
import { globalSearchAvailable, useSearch } from '../../stores/search';
import { useNavigationSidebar } from '../../stores/navigationSidebar';
import { useDrawerPreferences } from '../../stores/drawerPreferences';
import { useSessionDetailsDrawer } from '../../stores/sessionDetailsDrawer';
import { useUIViews } from '../../stores/uiViews';
import { openSearchTarget } from '../../services/searchNavigation';
import type { SearchOpenMetadata } from '../../../common/search-navigation';
import { sessionEntryFromActivity } from '../../services/api';
import type { EventCause, SearchTarget } from '../../../common/unified-history';
import { colors } from '../../theme';
import { drawerMotionDuration, resolvedDrawerWidth } from '../../../common/drawer-motion';
import {
  NAVIGATION_DRAWER_DEFAULT_WIDTH,
  clampDrawerWidth,
  responsiveDrawerWidthBounds,
} from '../../../common/drawer-resize';

const { Navigator } = createDrawerNavigator();
const Drawer = withLayoutContext(Navigator);

async function initializeAccountSearch(accountId: string, force = false): Promise<void> {
  await useSearch.getState().initialize(accountId, force);
  const search = useSearch.getState();
  if (search.accountId !== accountId) return;
  if (search.support === 'v2') useChat.getState().setSessionHistoryMode('v2');
  else if (search.support === 'legacy') useChat.getState().setSessionHistoryMode('legacy');
}

export default function AppDrawerLayout() {
  const layout = useLayout();
  const router = useRouter();
  const pathname = usePathname();
  const accountId = useConnection((state) => state.activeAccountId);
  const ws = useConnection((state) => state.ws);
  const wideSidebarOpen = useNavigationSidebar((state) => state.isOpen);
  const navigationWidth = useDrawerPreferences((state) => state.navigationWidth);
  const detailsWidth = useDrawerPreferences((state) => state.sessionDetailsWidth);
  const setNavigationWidth = useDrawerPreferences((state) => state.setNavigationWidth);
  const sessionDetailsOpen = useSessionDetailsDrawer((state) => state.isOpen);
  const [isResizing, setIsResizing] = useState(false);
  const reducedMotion = useReducedMotion();
  // Two widths, one toggleable drawer. Wide layouts start open; phones start
  // closed. There is no collapsed icon-only middle stage.
  const permanent = !layout.isPhone;
  const detailsRouteActive = pathname === '/chat' || pathname.startsWith('/runs/');
  const resizeBounds = useMemo(() => responsiveDrawerWidthBounds(
    'navigation',
    layout.width,
    {
      otherDrawerOpen: sessionDetailsOpen && detailsRouteActive,
      otherDrawerWidth: detailsWidth,
    },
  ), [detailsRouteActive, detailsWidth, layout.width, sessionDetailsOpen]);
  const expandedWidth = permanent
    ? clampDrawerWidth(navigationWidth || NAVIGATION_DRAWER_DEFAULT_WIDTH, resizeBounds)
    : 296;
  const width = resolvedDrawerWidth(expandedWidth, !permanent, wideSidebarOpen);
  const motionDuration = drawerMotionDuration(reducedMotion);
  const sidebarInertRef = useWebInert(!wideSidebarOpen);

  // Top-level screens get the sidebar button at every width; pushed screens
  // pair it with Back so a closed desktop sidebar is never a dead end.
  const leaf = (title: string) => ({
    ...themedHeader,
    title,
    headerLeft: () => <HeaderMenu />,
  });

  useEffect(() => {
    if (!accountId) {
      useSearch.getState().clear();
      useUIViews.getState().clear();
      return;
    }
    void initializeAccountSearch(accountId);
    void useUIViews.getState().initialize(accountId);
  }, [accountId]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((message) => {
      if (message.type === 'history_changed') {
        useSearch.getState().handleHistoryChanged(message);
        if (message.action === 'upsert') {
          const entry = sessionEntryFromActivity(message.item);
          const chat = useChat.getState();
          // The sidebar already owns every summary. Keep only metadata for a
          // session the user opened (or a live frame already stubbed) so the
          // chat store cannot turn back into an unbounded session index.
          if (entry && chat.sessions.some((session) => session.id === entry.session_id)) {
            chat.hydrateFromServer([entry]);
          }
        } else if (message.kind === 'chat' || message.kind === 'delegated_session') {
          useChat.getState().dropSessionLocal(message.resource_id);
        }
      } else if (message.type === 'search_index_changed') {
        useSearch.getState().handleSearchIndexChanged(message);
      } else if (message.type === 'auth_ok' && accountId) {
        // REST discovery remains authoritative. A reconnect can change server
        // generation/version, so re-run it even when the auth frame omits its
        // optional inline capabilities (the stable gateway does today).
        void initializeAccountSearch(accountId, true);
        void useUIViews.getState().initialize(accountId, true);
      }
    });
  }, [accountId, ws]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'p') return;
      const state = useSearch.getState();
      if (!globalSearchAvailable(state)) return;
      event.preventDefault();
      state.show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleOpenTarget = useCallback((
    target: SearchTarget,
    causedBy?: EventCause | null,
    metadata?: SearchOpenMetadata,
  ) => {
    openSearchTarget(router, target, causedBy, metadata);
  }, [router]);

  return (
    <>
      <Drawer
        // The Drawer is the cross-section "back" boundary. react-navigation's
          // default backBehavior is 'firstRoute', which REBUILDS the drawer
          // history to [firstRoute(chat), current] on every section switch — so
          // any back that bubbles out of a section stack lands on chat (the
          // first route) instead of the section you came from. 'history' keeps a
          // real visited-section trail, so a back that bubbles into the Drawer
          // returns to the previously focused section (and canGoBack reflects it).
          backBehavior="history"
          defaultStatus={permanent ? 'open' : 'closed'}
          drawerContent={(props: any) => (
            permanent
              ? (
                  <View
                    ref={sidebarInertRef}
                    testID="navigation-drawer-content"
                    pointerEvents={wideSidebarOpen ? 'auto' : 'none'}
                    accessibilityElementsHidden={!wideSidebarOpen}
                    importantForAccessibility={wideSidebarOpen ? 'auto' : 'no-hide-descendants'}
                    style={{ width: expandedWidth, flex: 1 }}
                    {...(Platform.OS === 'web'
                      ? ({ 'aria-hidden': !wideSidebarOpen } as any)
                      : {})}
                  >
                    <Sidebar />
                    {wideSidebarOpen && Platform.OS === 'web' ? (
                      <DrawerResizeHandle
                        side="left"
                        width={expandedWidth}
                        bounds={resizeBounds}
                        label="Resize navigation sidebar"
                        onChange={setNavigationWidth}
                        onResizingChange={setIsResizing}
                      />
                    ) : null}
                  </View>
                )
              : (
                  <Sidebar
                    onNavigate={() => props.navigation.closeDrawer()}
                  />
                )
          )}
          screenOptions={{
            headerShown: false,
            // Freeze a screen's React tree while it's not the focused route, so
            // a backgrounded tab (e.g. Chat) stops re-rendering on every store
            // mutation — the chat delta storm and any per-screen effects pause
            // until the user returns. The global store still receives updates;
            // the screen just defers rendering them until it's focused again.
            freezeOnBlur: true,
            drawerType: permanent ? 'permanent' : 'back',
            drawerStyle: {
              width,
              overflow: 'hidden',
              backgroundColor: 'transparent',
              borderRightWidth: 0,
              ...(permanent
                ? webDrawerWidthTransition(isResizing ? 0 : motionDuration)
                : undefined),
            },
            overlayColor: 'transparent',
            swipeEnabled: !permanent,
            // The divider lives on the content's left edge (not the sidebar's
            // right) so it always sits at the true sidebar↔content boundary,
            // regardless of the drawer width.
            sceneStyle: {
              backgroundColor: colors.bg,
              // On desktop web the resize handle owns the one visible
              // boundary line. Native/mobile keep the original scene divider.
              borderLeftWidth: Platform.OS === 'web' && permanent
                ? 0
                : permanent && !wideSidebarOpen ? 0 : 1,
              borderLeftColor: colors.borderLight,
            },
          }}
      >
        {/* Leaf screens render the drawer header directly. */}
        <Drawer.Screen name="chat" options={leaf('Chat')} />
        <Drawer.Screen name="model" options={leaf('Model')} />
        <Drawer.Screen name="system" options={leaf('System')} />
        <Drawer.Screen name="logs" options={leaf('Logs')} />
        <Drawer.Screen name="settings" options={leaf('Settings')} />
        {/* Stacks own their own headers (per-screen titles + back). */}
        <Drawer.Screen name="memory" options={{ headerShown: false }} />
        <Drawer.Screen name="mcps" options={{ headerShown: false }} />
        <Drawer.Screen name="skills" options={{ headerShown: false }} />
        <Drawer.Screen name="workflows" options={{ headerShown: false }} />
        <Drawer.Screen name="tasks" options={{ headerShown: false }} />
        <Drawer.Screen name="events" options={{ headerShown: false }} />
        <Drawer.Screen name="views" options={{ headerShown: false }} />
        {/* Hidden / legacy routes — reachable by link, never listed. */}
        {/* Single-run detail (from the sidebar's Recent feed) — a drawer-root
            stack so opening a run never highlights a workspace tab. */}
        <Drawer.Screen name="runs" options={{ headerShown: false, drawerItemStyle: { display: 'none' } }} />
        <Drawer.Screen name="terminal" options={{ headerShown: false, drawerItemStyle: { display: 'none' } }} />
        <Drawer.Screen name="automations" options={{ headerShown: false, drawerItemStyle: { display: 'none' } }} />
        <Drawer.Screen name="members" options={{ headerShown: false, drawerItemStyle: { display: 'none' } }} />
      </Drawer>
      <GlobalSearchOverlay onOpenTarget={handleOpenTarget} />
    </>
  );
}
