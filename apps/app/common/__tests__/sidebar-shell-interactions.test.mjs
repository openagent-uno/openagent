import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(
  new URL('../../universal/components/Sidebar.tsx', import.meta.url),
  'utf8',
);
const theme = readFileSync(
  new URL('../../universal/theme.ts', import.meta.url),
  'utf8',
);
const tabsLayout = readFileSync(
  new URL('../../universal/app/(tabs)/_layout.tsx', import.meta.url),
  'utf8',
);
const detailsDrawer = readFileSync(
  new URL('../../universal/components/SessionDetailsDrawer.tsx', import.meta.url),
  'utf8',
);
const resizeHandle = readFileSync(
  new URL('../../universal/components/DrawerResizeHandle.tsx', import.meta.url),
  'utf8',
);
const appHeader = readFileSync(
  new URL('../../universal/components/AppHeader.tsx', import.meta.url),
  'utf8',
);
const chatScreen = readFileSync(
  new URL('../../universal/app/(tabs)/chat.tsx', import.meta.url),
  'utf8',
);
const renameDialog = readFileSync(
  new URL('../../universal/components/RenameSessionDialog.tsx', import.meta.url),
  'utf8',
);
const popupMenu = readFileSync(
  new URL('../../universal/components/PopupMenu.tsx', import.meta.url),
  'utf8',
);

test('recent rows own one hover surface across their title and dots controls', () => {
  // RN Web forwards testID to data-testid even when it filters arbitrary
  // className props from a View, so the DOM selector is intentional.
  assert.match(sidebar, /testID=\{`oa-history-feed-row-\$\{item\.key\}`\}/);
  assert.match(sidebar, /accessibilityLabel=\{`Options for \$\{item\.label\}`\}/);
  assert.match(theme, /\[data-testid\^="oa-history-feed-row-"\]:hover/);
  const historyHover = theme.match(
    /\[data-testid\^="oa-history-feed-row-"\]:hover\s*\{([\s\S]*?)\}/,
  )?.[1] || '';
  assert.match(historyHover, /background-color:\s*var\(--oa-hover\)/);
  assert.match(historyHover, /border-color:\s*transparent/);
  assert.doesNotMatch(historyHover, /var\(--oa-borderStrong\)/);
  assert.match(
    theme,
    /\[data-testid\^="oa-history-feed-row-"\] > \[role="button"\]:hover/,
  );
});

test('recent timestamps appear only while their compound row is hovered', () => {
  assert.match(sidebar, /testID="oa-history-feed-date"/);
  assert.match(
    theme,
    /\[data-testid\^="oa-history-feed-row-"\][\s\S]*\[data-testid="oa-history-feed-date"\][\s\S]*opacity:\s*0/,
  );
  assert.match(
    theme,
    /\[data-testid\^="oa-history-feed-row-"\]:hover[\s\S]*\[data-testid="oa-history-feed-date"\][\s\S]*opacity:\s*1/,
  );
});

test('agent picker and utility actions share one 32px footer row', () => {
  const row = sidebar.match(/<View style=\{styles\.footerActionRow\}>([\s\S]*?)<\/View>/)?.[1] || '';
  assert.match(row, /<AgentSwitcher variant="compact"/);
  assert.match(row, /label="Settings"/);
  assert.match(row, /label="Logs"/);
  assert.match(row, /label="System"/);
  assert.match(sidebar, /footerBtn: \{ width: ROW_H, height: ROW_H/);
});

test('desktop resize rails are the sole drawer boundary', () => {
  assert.match(tabsLayout, /borderLeftWidth: Platform\.OS === 'web' && permanent\s*\? 0/);
  assert.match(detailsDrawer, /drawerSurfaceResizeBoundary: \{ borderLeftWidth: 0 \}/);
  assert.match(resizeHandle, /leftRail: \{ right: 0 \}/);
  assert.match(resizeHandle, /rightRail: \{ left: 0 \}/);
});

test('new and selected chats keep their session id in navigation history', () => {
  assert.match(sidebar, /router\.push\(chatSessionIntent\(id\)/);
  assert.match(sidebar, /router\.push\(chatSessionIntent\(session\.id\)/);
  assert.match(appHeader, /router\.push\(chatSessionIntent\(id\)/);
  assert.match(chatScreen, /routerRef\.current\.push\(chatSessionIntent\(id\)/);
  assert.match(chatScreen, /action: startNewSession/);
});

test('v2 sidebar overlays local live chats until normalized history persists them', () => {
  assert.match(sidebar, /localSessionIdsMissingFromHistory\(sessions, unifiedItems\)/);
  assert.match(sidebar, /key: `c-session:\$\{session\.id\}`/);
  assert.match(sidebar, /sessionId \? `c-session:\$\{sessionId\}`/);
});

test('v2 Recent uses parent resource names for automation runs', () => {
  assert.match(sidebar, /label: sidebarActivityTitle\(item\)/);
});

test('dashboard views and recent history share one infinite sidebar scroller', () => {
  assert.equal((sidebar.match(/<FlatList/g) || []).length, 1);
  assert.match(sidebar, /ListHeaderComponent=\{\(/);
  assert.match(sidebar, /ListHeaderComponent=\{\([\s\S]*NAV\.map/);
  assert.match(sidebar, /customViews\.map\(\(item, index\) =>/);
  assert.doesNotMatch(sidebar.slice(0, sidebar.indexOf('<RecentFeed')), /<View style=\{styles\.nav\}>/);
  assert.doesNotMatch(sidebar, /viewList:\s*\{[^}]*maxHeight/);
  assert.match(sidebar, /onEndReached=\{\(\) => \{/);
  assert.match(sidebar, /void loadMoreHistory\(\)/);
});

test('custom views have no duplicate generic Views navigation row', () => {
  assert.doesNotMatch(sidebar, /href:\s*['"]\/views['"]/);
  assert.match(sidebar, /customViews\.map\(\(item, index\) =>/);
  assert.match(sidebar, /`\/views\/\$\{encodeURIComponent\(item\.id\)\}`/);
});

test('conversation rename is shared by menus, selected history, and details title', () => {
  assert.match(sidebar, /label: 'Rename'/);
  assert.match(sidebar, /item\.active && item\.onRename \? item\.onRename : item\.onPress/);
  assert.match(detailsDrawer, /accessibilityLabel=\{`Rename \$\{session\.title/);
  assert.match(chatScreen, /label: 'Rename'[\s\S]*renameSession\(activeSession\)/);
  assert.match(renameDialog, /await useChat\.getState\(\)\.renameSession/);
  assert.match(renameDialog, /useSearch\.getState\(\)\.renameSessionTitle/);
  assert.match(renameDialog, /maxLength=\{200\}/);
});

test('right-clicking a history conversation opens its existing popup menu', () => {
  assert.match(sidebar, /onContextMenu:\s*\(event: any\) =>/);
  assert.match(sidebar, /event\.preventDefault\?\.\(\)/);
  assert.match(sidebar, /menuRef\.current\?\.openAt\(x, y\)/);
  assert.match(sidebar, /ref=\{menuRef\}/);
  assert.match(popupMenu, /openAt: \(x, y\) => setAnchor/);
  assert.match(popupMenu, /anchor\.point \? anchor\.y/);
});

test('sidebar status uses hover-colored icons without separate dots', () => {
  assert.doesNotMatch(sidebar, /styles\.feedDot|styles\.viewDot/);
  assert.match(sidebar, /oa-history-status-icon-\$\{item\.statusTone\}/);
  assert.match(theme, /oa-history-status-icon-success[\s\S]*var\(--oa-success\)/);
  assert.match(theme, /oa-history-status-icon-error[\s\S]*var\(--oa-error\)/);
  assert.match(sidebar, /name="layout"[\s\S]*styles\.viewText/);
  assert.match(sidebar, /viewRow: \{ height: ROW_H/);
});
