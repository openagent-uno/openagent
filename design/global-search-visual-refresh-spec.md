# Global search and visual refresh specification

- Status: Beta implementation present; visual and end-to-end acceptance evidence pending
- Date: 2026-08-26
- Scope: `openagent-app` universal client
- Related plan: [Unified history, storage, and global search beta](../plans/unified-history-storage-search-beta.md)
- API contract: [Unified history and search OpenAPI](../api/unified-history-search.openapi.yaml)
- Canonical wire types: [Search target and client DTOs](../api/search-target.ts)

## 1. Outcome

The client gains one global search surface for operational history and a quieter
typographic treatment. It should feel faster and less decorative without changing
OpenAgent's product identity.

This specification deliberately preserves:

- the current dark and light palettes;
- every existing color token and semantic color meaning;
- the frosted-glass recipe and blur strength;
- the desktop/sidebar and mobile/drawer layout model;
- the primary route hierarchy;
- the OpenAgent icon and product name;
- existing functional voice, status, and progress affordances.

It changes typography, decoration, interaction hierarchy, and the search experience.
No source-project or external-product name is added to source code, comments, assets,
package metadata, user-visible strings, or documentation shipped with OpenAgent.

## 2. Design principles

1. **Content first.** Titles, conversation text, results, and controls are more
   prominent than ornamental frames.
2. **One visual signal per state.** Selection does not need an animated rail, a glow,
   an uppercase label, and a color change at the same time.
3. **Glass is structure, not decoration.** Keep glass for overlays, navigation, and
   elevated surfaces; remove rails or halos that do not convey state.
4. **System typography.** Use platform-native sans typography for speed, consistency,
   and crisp rendering; reserve monospace for code, identifiers, times, and shortcuts.
5. **Stable geometry.** Search updates, loading, hover, and selection do not cause
   layout jumps.
6. **Accessible by default.** Keyboard, screen-reader, touch, reduced-motion, zoom,
   and high-content-density behavior are part of the component contract.

## 3. Typography

### 3.1 Tokens

`universal/theme.ts` currently exports four constant CSS-family strings and is also
re-exported by `common/theme.ts`. Replace those tokens with platform-aware values.
Importing `Platform` here is intentional; `undefined` is a valid React Native
`TextStyle.fontFamily` value and means “use the platform system family”. Keep the web
stack constants above `ensureGlobalCss()` so the injected body rule and exported token
cannot drift or hit temporal-dead-zone ordering during module initialization:

```ts
import { Platform } from 'react-native';

const WEB_SANS =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
const WEB_DISPLAY =
  '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const WEB_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const font = {
  sans: Platform.select({ web: WEB_SANS, default: undefined }),
  display: Platform.select({ web: WEB_DISPLAY, default: undefined }),
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    web: WEB_MONO,
    default: 'monospace',
  })!,
} as const;
```

Native `undefined` means React Native's system font. Do not bundle proprietary Apple
fonts. On macOS/iOS the system resolves to San Francisco; Windows and Linux use their
native fallback.

Most call sites pass these tokens to `StyleSheet`, which accepts `undefined`. Audit
any string interpolation separately. The current canvas interpolation in
`GraphView.tsx` is web-guarded and therefore receives `WEB_SANS`; no native string
consumer may stringify an undefined family.

`font.serif` is removed. Its current call sites migrate as follows:

- empty/chat headline: `font.display`, non-italic;
- connector-install editorial copy: `font.sans`, optional italic only when it carries
  semantic emphasis;
- all code, paths, handles, shortcut labels, and structured telemetry: `font.mono`.

### 3.2 Loading and privacy

- remove `ensureFonts()` and the Google Fonts stylesheet injection;
- remove `FONTS_ELEMENT_ID`, and change the injected web `body` rule to `WEB_SANS`;
- do not add a remote font request, tracking endpoint, or preload dependency;
- the first paint and hydrated paint must use the same metrics class where possible;
- Content Security Policy no longer needs `fonts.googleapis.com` or
  `fonts.gstatic.com` for app typography;
- Electron and offline web builds render fully without Internet access.

### 3.3 Hierarchy

Initial scale, subject to screenshot validation:

| Role | Size | Weight | Tracking | Case |
|---|---:|---:|---:|---|
| Page title | 22–24 | 600 | -0.02em | sentence/title case |
| Panel title | 16–18 | 600 | -0.01em | sentence case |
| Body/message | 14–15 | 400 | normal | authored case |
| Control label | 13–14 | 500–600 | normal | sentence case |
| Metadata | 11–12 | 400–500 | normal | sentence case |
| Code/ID/time | 11–13 mono | 400–500 | normal | source case |

Uppercase and wide tracking are retained only where the text is genuinely a short
machine-state label or protocol token. Buttons, navigation labels, form labels,
section titles, model names, and ordinary metadata stop forcing uppercase.

Search highlights use weight and the existing accent color. They do not change font
family, font size, or line height.

## 4. Global search entry points

### 4.1 Persistent entry

Add a compact search row immediately below `New session` in the existing sidebar.
It uses the current row height, spacing, icon set, surface/hover tokens, and sidebar
width. It contains:

- search glyph;
- `Search` label;
- right-aligned platform shortcut hint.

On narrow layouts, the same action appears near the top of the drawer. The mobile
header may expose a search icon if the drawer path proves too slow in usability tests;
this does not alter header geometry.

### 4.2 Keyboard command

- primary shortcut: `Cmd+P` on macOS, `Ctrl+P` elsewhere;
- the listener is owned once by `app/(tabs)/_layout.tsx`, not by an individual
  frozen drawer screen;
- remove the `Cmd/Ctrl+P` branch and `CommandPalette` mount from `chat.tsx` to
  prevent double open, while leaving its other chat shortcuts intact;
- do not capture the shortcut while an IME is composing;
- ignore repeated keydown events and already-prevented events;
- native platforms expose the same command through the visible search entry;
- retain `Cmd/Ctrl+K` as the existing New session command. It is not available as a
  search alias.

### 4.3 Scope availability

The first beta exposes:

- All;
- Chats;
- Tools;
- Workflows;
- Scheduled;
- Events.

Memory is not included in All and is not shown as a disabled tab. It remains in its
existing dedicated product area until the separate vault-search workstream is ready.
`All` is a client label, not an API enum: it sends all five explicit values in the
required `scopes` array. The client never omits `scopes` and never sends an invented
`all` value.

## 5. Search overlay

### 5.1 Shell

Reuse the existing command-palette geometry and visual tokens, but not its current
mounting implementation. `CommandPalette.tsx` is web-only, uses a raw HTML input,
maps at most 40 rows, and renders as an absolute child of Chat. It cannot provide a
global native overlay or escape route stacking contexts as-is.

The beta implementation uses:

- one React Native `Modal`, mounted as a sibling of the Drawer in
  `app/(tabs)/_layout.tsx`; React Native Web portals that modal at the document root;
- `GlobalSearchOverlay.web.tsx` for the DOM combobox/focus contract and
  `GlobalSearchOverlay.native.tsx` for `TextInput`, keyboard avoidance, back-button
  handling, and native accessibility;
- existing scrim color;
- the existing `BlurView` wrapper at the existing 2.6 px recipe plus
  `glassSurface.backgroundColor`, border, radius, and shadow; do not introduce a
  second native or web blur value;
- visual width `min(92vw, 540px)`;
- top offset approximately 72–80 px on desktop;
- result area height up to `min(560px, 70vh)`;
- full-width modal sheet on narrow native screens, respecting safe areas and keyboard;
- no standalone search route in the initial beta.

Those `min()` expressions are design constraints, not React Native style strings.
Implement them with `width: '92%'`, `maxWidth: 540`, and a numeric max height derived
from `useWindowDimensions()`; this keeps the same component valid under React Native
Web and avoids unsupported CSS-only values in `StyleSheet`.

The modal must remain outside Drawer content and every `Drawer.Screen`. The navigator
currently uses `freezeOnBlur: true`; mounting search in Chat or another screen would
freeze requests, focus, and keyboard handling as soon as navigation changes.

The panel has three stable regions:

1. query input;
2. scope/filter strip;
3. virtualized result list plus a small status/footer row.

Opening and changing filters must not resize the panel horizontally. Loading and empty
states occupy the same result region as rows.

### 5.2 Input

The web input is a true combobox. Native uses the corresponding modal, text field,
list, and accessibility actions rather than pretending ARIA exists there:

- placeholder `Search OpenAgent…`;
- visible search glyph and clear action;
- `aria-expanded`, `aria-controls`, and `aria-activedescendant` on web;
- focus remains in the input while arrow keys move the active option;
- draft text is separate from the query represented by currently displayed results;
- Enter can open only a target belonging to the displayed query generation;
- 180 ms initial debounce, adjustable after measurement;
- previous request is aborted when query/filter/account generation changes.

On native, `onRequestClose` handles the Android back button, a
`KeyboardAvoidingView` keeps the input/results visible, and the sheet respects safe
area insets. Opening it from the phone drawer leaves the drawer state unchanged under
the modal so closing can restore the same trigger context.

The shortcut hint moves to the footer after focus so it does not compete with the clear
button or loading indicator.

### 5.3 Scope and filters

Use one horizontally scrollable chip row on narrow widths and a single non-wrapping
row on desktop. Scope is single-select; All is the default.

Initial filters:

- status;
- period: any, 24 hours, 7 days, 30 days, custom;
- errors-only preset;
- clear filters.

Status is disabled for Chats. Errors-only writes `failed`, `rejected`, and `timed_out`
into the same canonical `status` filter rather than creating a second independent
state. Advanced query syntax, provider, model, and tags are not exposed in the first
beta.

### 5.4 Query-empty behavior

With no query, the overlay may reuse the account-scoped first page already present in
the unified history store only when the selected scope is All and every filter is
empty. This is a paginated first-page optimization, not a complete local result set.
Opening that exact state therefore does not issue a duplicate first-page history
request.

A specific scope, or any status, period, errors-only, origin, parent, or future
filter, calls `POST /api/search` even when `query` is empty. The normalized request
uses `query: ""`, the explicit selected scopes (all five scopes for filtered All),
the normalized filters, `sort: "recent"`, `grouping: "match"`, and `cursor: null`.
The current `stores/activity.ts` plus `useChat` split and its
workflow/task/event fan-out are legacy inputs, not the final store contract; use them
only behind the explicit old-server fallback.

Tools with an empty query calls `POST /api/search`, because a tool invocation is not a
top-level history item. The normalized request uses `query: ""`, `scopes: ["tools"]`,
`sort: "recent"`, `grouping: "match"`, an explicit empty `filters` object, and
`cursor: null`. The UI labels this state `Recent tools`, not search results.

### 5.5 Result row

Every row has this fixed structure:

- 20 px category glyph column;
- flexible text column with title, breadcrumb, and at most two snippet lines;
- compact trailing column for relative time or status;
- optional definition/run badge next to the title;
- optional fidelity/redaction indicator with an accessible label: `Partial` for
  `partial`, `Incomplete history` for `legacy_compacted`, `malformed_source`, or
  `unknown`, and `Redacted` for redacted sensitivity;
- selected background using the existing hover/surface token.

Do not add cyan rails, animated borders, glow, or per-category colors. Category is
communicated through glyph, label/breadcrumb, and accessible text.

The server supplies structured snippet fragments. Render them as plain text spans;
never inject HTML or parse tool output as Markdown. Truncation preserves Unicode
graphemes and bidirectional isolation.

Grouped results expose the one or two entries in `matches` as selectable passages.
Each passage opens its own `SearchMatch.target`; the row's default `target` equals the
first passage target. `N more` starts a new request with `grouping: "match"` and
`filters.root` set to that `SearchRootRef`; the interface never shows an unreachable
`match_count`.

### 5.6 Opening a target

The client delegates to one exhaustive navigation adapter, never ad-hoc URL assembly
or component-ref manipulation in a result row:

```text
SearchResultRow
  → openSearchTarget(SearchTarget, caused_by?)
  → NavigationIntent
  → destination screen loader
  → authorized detail/messages-around fetch
  → render destination and focus an advertised anchor, when present
```

`openSearchTarget` is owned by a search-navigation service, is exhaustive over the
nine OpenAPI `SearchTarget.kind` values, and performs no fetch after the overlay starts
unmounting. The target uses canonical snake_case at the API boundary; conversion to
the app's camelCase route params happens only in this adapter. Destination screens own
loading, not the search store:

| Target | Existing route intent | Destination owner and required work |
|---|---|---|
| `chat` | `/chat?session=…` | `chat.tsx` loads the transcript tail. |
| `chat_message`, `chat_tool` | `/chat?session=…&message=…&toolInvocation=…` | `chat.tsx` loads `/api/sessions/{sessionId}/messages?around=…`; a tool anchor also resolves `/api/tool-invocations/{toolInvocationId}` and expands only the matching invocation. |
| `workflow_definition` | `/workflows/{id}` | `workflows/[id].tsx` fetches the correct definition root. Node/field focus is a follow-up gated by `definition_field_anchors`. |
| `workflow_run` | `/runs/{run_id}?kind=workflow&parentId={workflow_id}` | `runs/[id].tsx` and `RunDetailView` fetch the exact run. Match-specific trace-step/tool focus is not promised in beta. |
| `scheduled_definition` | `/tasks/{task_id}` | `tasks/[id].tsx` fetches the correct definition root. Field focus is a follow-up. |
| `scheduled_run` | `/runs/{run_id}?kind=task&parentId={task_id}&message=…&toolInvocation=…` | `RunDetailView` replaces the current latest-50 lookup with `/api/scheduled-runs/{runId}` and owns any transcript anchor. |
| `event_definition` | `/events/{event_id}` | `events/[id].tsx` fetches the correct definition root. Field focus is a follow-up. |
| `event_delivery` | `/runs/{delivery_id}?kind=event&parentId={event_id}&message=…&toolInvocation=…` | `RunDetailView` fetches `/api/event-deliveries/{deliveryId}` and owns delivery/transcript anchors. |

These route strings describe existing Expo Router screens, not a second public API.
`parentId`, `traceStep`, and similar URL keys may remain camelCase internally.
Whenever a target carries `tool_invocation_id`, the destination uses that canonical ID
with the tool-detail resolver; it never substitutes legacy `tool_call_id`. Scheduled
and event run detail is loaded first when `session_id` is absent so a message anchor
can resolve its owning session without guessing.

Opening a message or tool invocation:

- requests a bidirectional message window around the target;
- merges it into range-aware chat state by stable message ID and ordinal;
- centers and briefly highlights the message;
- expands the matching tool card;
- moves screen-reader focus to the target heading;
- suspends tail auto-scroll and shows `New messages` if live content arrives.

This requires replacing `MessageList`'s current tail-only slicing as the source of
truth for an anchored load. Chat state keeps ordered, mergeable message ranges keyed
by stable message ID/ordinal. Rendered message and tool rows expose an anchor registry
(`nativeID` plus measured/ref handles); the destination screen performs the scroll and
focus after the requested range commits. It also preserves the durable
`SessionMessage.status` so interrupted, cancelled, failed, complete, and genuinely
streaming messages are not inferred from text. `MessageList` does not fetch or
navigate.

When detailed workflow anchors are introduced, they use trace-step IDs, not repeatable
graph-node IDs. In beta, workflow search opens the exact run root. Scheduled runs load
by run ID rather than searching the latest 50. A downstream resource caused by an
event opens its real workflow/scheduled/chat target and shows `Caused by event …` as
context. The resolver consumes `SearchResult.caused_by` for a direct search hit or
`EventDeliveryDetail.downstream_target` plus the delivery metadata when the user opens
the downstream link from delivery detail; it does not navigate to a second delivery.

`RunDetailView` currently keys workflow rows by `node_id` plus array index and accepts
no anchor props. The detail DTO preserves `WorkflowTraceStep.id` for the future
attempt-level anchor contract, while `node_id` remains display/editor metadata; this
does not turn step focus into a first-beta search gate.

If a target was deleted or access was revoked after the search response, show `This
result is no longer available` and return focus to the result list. `SearchRoot` is
grouping/display metadata, not a fallback `SearchTarget`, so the initial contract does
not authorize opening it. A future root fallback requires a new explicit target field
in the API; never synthesize one from `root.kind` and `root.id`.

## 6. Search state and loading behavior

One account-scoped store owns:

- overlay open state;
- draft and displayed query;
- scopes and filters;
- results, active result, and cursor;
- initial, refresh, and pagination loading states;
- per-page error and retry state;
- history revision, index generation, indexed sequence, and coverage;
- request/account generation and abort controller;
- stale-result notification without automatic reordering.

Behavior:

- keep prior results visible while refreshing and mark them non-openable by Enter until
  the displayed query catches up;
- skeletons appear only on the first uncached load;
- pagination uses an inline footer spinner/error;
- when advertised, `Results updated` appears after `search_index_changed`; it does
  not reorder while the user is navigating; without that optional capability the
  store uses bounded REST refreshes and does not synthesize realtime support;
- close/reopen keeps query, filters, list, scroll offset, and selection in memory for
  the same account;
- Clear, logout, and account switch abort requests and erase all search state;
- no query or result text is persisted to disk in the first beta;
- legacy fallback happens only when capability discovery is absent on an old server
  (404/405) or the server explicitly returns HTTP 501 with `unsupported`; never fall
  back after 401, timeout, an advertised-capability contract failure, or another 5xx.

## 7. Visual cleanup inventory

### 7.1 Global theme

In `universal/theme.ts`:

- replace `font.sans`, `font.display`, and `font.mono` with the stacks in §3;
- remove the remote font loader and related element ID;
- remove global body tracking;
- keep palette variables, glass recipe, radii, spacing, shadows, and theme switching;
- keep functional focus indicators and reduced-motion handling;
- keep existing animation/class identifiers unless the referenced component is
  removed; broad renaming is outside this beta;
- remove unused decorative keyframes after component cleanup, verified by `rg`.

Do not change `darkColors`, `lightColors`, any scalar color value,
`glassSurface.webFilter`, `BlurView`'s native intensity mapping, radii, spacing,
shadows, Drawer widths, or navigator header height. A typography edit must not become
a theme-token redesign.

### 7.2 Brand and headers

- `BrandLogo`: retain the existing icon; render the optional wordmark in the display
  stack with moderate weight and normal/tight tracking;
- production navigator headers are owned by `components/screenHeader.tsx` and
  `themedHeader`; use the display stack there without changing header geometry, glass,
  drag regions, or actions;
- `components/AppHeader.tsx` and `components/ResponsiveSidebar.tsx` have no current
  import sites. Do not spend visual-refresh work updating dead paths; remove them only
  as a separately verified dead-code cleanup;
- screen and modal headers do not force uppercase;
- do not replace source logo assets or introduce a new logo.

### 7.3 Sidebar

- preserve width, nav order, drawer behavior, footer, and Recent placement;
- in `Sidebar.tsx`, remove only the Reanimated gliding-rail values/effect/style and the
  `Animated.View`/`railFill`; apply the same `surface` background and `border` directly
  through a static `rowActive` style on the selected navigation row;
- add the Search row without moving destinations to new sections;
- the Search row opens the shell-owned store directly and does not call Sidebar's
  route `go()`/`onNavigate`; on phone it is an overlay action, not drawer navigation;
- keep `ROW_H` for row geometry, place Search directly after New session, and move the
  existing section margin to the two-row action group so the sidebar width/order and
  Recent placement stay unchanged apart from the explicit added row;
- remove ornamental section rails and excessive tracking within the touched sidebar;
- do not remove the status rails in `TaskTile`, `WorkflowTile`, `EventTile`, `McpTile`,
  or `RunDetailView`: those communicate enabled/run state and are not the animated
  selection rail;
- keep hover/pressed feedback and the active state visible without relying on color
  alone;
- history rows continue to show semantic status dots where those dots convey run state.

### 7.4 Login

- retain the centered form width and account/join flow;
- reduce the brand icon from 108 px to an initial target of 72–80 px;
- remove the `JarvisClock` import, render, wrapper, and `clockWrap` style from
  `app/index.tsx`; if `rg` still shows no other consumer, its component/barrel export
  and clock-only keyframes may be removed in the same cleanup;
- reduce the 32 px gap below the hero to 20–24 px;
- replace uppercase tracked kickers with small semibold sentence-case labels;
- keep window drag controls, cards, colors, and blur unchanged.

### 7.5 Cards, tiles, and forms

- change the shared `Card` default from `rail = true` to `false`; opt in explicitly
  only where the top rail communicates an actual selected/progress state. The rail is
  absolutely positioned, so this does not change card geometry;
- remove pulsing rails and ambient glow that do not communicate live activity;
- buttons use sentence case and normal tracking;
- field labels use sans rather than mono unless the value is code-like;
- retain existing error/success colors, borders, card geometry, and control placement;
- do not redesign workflow nodes, scheduled tiles, event tiles, or settings layouts in
  this beta; only apply token-level typography and decoration cleanup.

### 7.6 Chat

- retain message grouping, composer position, voice controls, tool cards, attachment
  layout, and conversation width;
- keep `SoundWaves` because it communicates voice state;
- remove decorative empty-state oversizing and use the quieter brand scale;
- use body sans for conversation prose and platform mono for code/tool payloads;
- avoid animated entrance on already-existing history when opening an old anchor;
- preserve meaningful streaming/progress animation with reduced-motion alternatives.

## 8. Component ownership

Target structure:

```text
app/(tabs)/_layout.tsx
├── GlobalSearchProvider / shortcut controller
├── Drawer
│   ├── Sidebar → GlobalSearchTrigger
│   └── existing screens
└── GlobalSearchOverlay (.web / .native)
    ├── SearchCombobox (.web) / SearchInput (.native)
    ├── SearchScopeBar
    ├── SearchFilters
    ├── FlatList<SearchResultRow>
    └── SearchStatusFooter

stores/search.ts (account-scoped, memory-only)
├── history-cache adapter
├── search API adapter
├── optional capability-gated realtime invalidation
└── request generations / pagination

services/searchNavigation.ts
└── SearchTarget → NavigationIntent

destination screens/stores
└── detail fetch, range merge, render, scroll, highlight, focus
```

The old `CommandPalette` may donate geometry and styles, but its local fuzzy ranking,
40-row slice, chat-only entries, absolute Chat mount, and HTML-input-only
implementation are not part of the new contract. Do not keep a second command palette
mounted in Chat.

Use React Native's existing `FlatList` for the beta; no new virtualization dependency
is needed for bounded 100-row pages. Do not nest it inside a result `ScrollView`.
Pagination uses `onEndReached`, stable keys use `result_id` plus match ID when needed,
and keyboard selection calls `scrollToIndex` with `onScrollToIndexFailed` recovery.
Avoid fixed `getItemLayout` until dynamic type proves row heights invariant; the
two-line snippet cap does not make 200% text a fixed-height row.

## 9. Accessibility requirements

- web dialog/modal semantics and focus trap; native `accessibilityViewIsModal`,
  `onAccessibilityEscape`, and Android `onRequestClose`;
- focus restored to the invoking control on close;
- web combobox/listbox/option pattern with one tab stop for results; option rows expose
  stable DOM IDs through `nativeID` so `aria-activedescendant` never references an
  unmounted virtual row;
- arrow keys, Home, End, PageUp, PageDown, Enter, and Escape;
- filter popover consumes the first Escape before the dialog closes;
- `FlatList` uses `keyboardShouldPersistTaps="handled"`; touch selection must not be
  swallowed by keyboard dismissal;
- 44×44 minimum touch targets on native;
- visible focus using existing focus color and sufficient contrast;
- selected state announced and not communicated by color alone;
- polite live region for counts, loading completion, coverage, and update notice;
- no live announcement for every keystroke or every streamed index mutation;
- VoiceOver and TalkBack manual checks in addition to automated web semantics;
- 200% zoom and dynamic type do not clip title, query, or active result;
- reduced motion removes decorative movement without hiding progress state.

## 10. Validation matrix

Capture before/after screenshots using identical data, route, viewport, theme, and
font-rendering environment for:

| Surface | Widths / platforms | Required states |
|---|---|---|
| Login | 390, 768, 1440; iOS/Android/web | saved accounts, join, error, connecting |
| Sidebar/drawer | 390, 1024, 1440 | active nav, recent rows, reconnecting, empty |
| Chat | 390, 768, 1440 | empty, long transcript, tools, voice, old anchor |
| Search | 390, 768, 1440 | empty, results, filters, loading, no match, partial, stale |
| Workflows | 390, 1024, 1440 | list, editor, exact run root; repeated step anchor is follow-up |
| Scheduled | 390, 1024, 1440 | list, definition, old run anchor |
| Events | 390, 1024, 1440 | list, definition root, delivery/downstream target |
| Settings/system | 390, 1024, 1440 | forms, tables, status/error states |

Acceptance gates:

- no color-token or blur-value changes in the visual-refresh diff;
- no unintended route/layout geometry change beyond the explicit search row and
  overlay;
- no request to a remote font origin;
- no clipped controls or text at supported breakpoints and dynamic type;
- screenshot diffs reviewed for dark and light themes;
- keyboard-only search flow completes without focus loss;
- two consecutive end-to-end passes for every target kind;
- existing voice, composer, navigation, workflow editing, scheduled editing, event
  editing, and account flows remain functional.

The current `openagent-app/test.sh` provides lint, TypeScript, and Node unit tests but
no UI automation harness. Therefore “two consecutive end-to-end passes” is not
satisfied by that script alone. Before implementation is declared complete, add or
adopt executable web/Electron and iOS/Android UI harnesses that can seed deterministic
fixtures, address stable accessibility IDs, and retain screenshots/logs. At minimum,
automate:

- shortcut and sidebar/drawer open/close paths;
- debounce cancellation and stale displayed-query Enter protection;
- pagination, cursor-stale refresh, warming/degraded/offline, and account clearing;
- all nine `SearchTarget.kind` branches, including deleted/revoked targets;
- message/tool centering, workflow run roots, old scheduled runs, and
  event downstream breadcrumbs;
- native keyboard/back/safe-area behavior and web focus restoration.

## 11. Rollout order

1. introduce typography tokens and remove remote font loading on the beta branch;
2. update shared primitives: headers, buttons, inputs, cards, tabs, brand lockup;
3. replace sidebar selected rail and add the global search trigger;
4. implement the global overlay/store against mocked frozen API fixtures;
5. implement typed target resolvers and messages-around range state;
6. connect history/search capability negotiation and subscribe to realtime only if
   the server advertises its optional event;
7. clean screen-specific typography and decoration without structural redesign;
8. run screenshot, accessibility, unit, integration, and full E2E gates;
9. dogfood only on the beta channel after storage/search correctness gates pass.

The beta train is authorized by the plan/runbook, not by this visual document.
Authorization does not prove the visual, capability, or deep-link gates passed:
visual changes and the search surface ship in the same prerelease only after the
server contract and deep-link matrix are complete.
The app currently has no general runtime feature-flag facility, so the beta
branch/prerelease is the visual rollout boundary. Search itself remains hidden unless
the authenticated server advertises the required capability versions; do not describe
a nonexistent visual flag in implementation or QA.

## 12. Open decisions

- whether the mobile header also needs a direct search icon after drawer usability
  testing;
- exact brand icon size on login after screenshot comparison at 390 and 768 px;
- whether the static sidebar active state needs a 2 px indicator in addition to its
  background for high-contrast users;
