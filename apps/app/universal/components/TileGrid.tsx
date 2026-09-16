/**
 * TileGrid — the shared dashboard grid used by Scheduled, Workflows, and
 * Events (and matching Connectors').
 *
 * Column count derives from the *container's* measured width (via
 * ``onLayout``), not the window's, so it stays correct when the sidebar or
 * window chrome reduces content width. Rows are chunked into independent
 * flexboxes of N equal cells, with the short last row padded by spacers so
 * columns stay aligned.
 *
 * Extracted from ``tasks/index.tsx`` so the three automation dashboards share
 * one layout and one set of proportions instead of drifting apart.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

export const CONTENT_MAX_WIDTH = 1120;
export const TILE_MIN_WIDTH = 300;
export const TILE_MAX_COLS = 4;
export const GRID_GAP = 14;

/** Column count from the container's measured width. */
export function columnsForWidth(width: number, gap: number = GRID_GAP): number {
  if (width <= 0) return 1;
  const n = Math.floor((width + gap) / (TILE_MIN_WIDTH + gap));
  return Math.max(1, Math.min(TILE_MAX_COLS, n));
}

/** Row-chunked grid of equal cells. */
export function Grid({ cols, children }: { cols: number; children: ReactNode }) {
  const nodes = Array.isArray(children) ? children : [children];
  const rows: ReactNode[][] = [];
  for (let i = 0; i < nodes.length; i += cols) {
    rows.push(nodes.slice(i, i + cols));
  }
  return (
    <View style={{ gap: GRID_GAP }}>
      {rows.map((row, ri) => (
        <View key={ri} style={[styles.row, { gap: GRID_GAP }]}>
          {row.map((child, ci) => (
            <View key={ci} style={styles.cell}>{child}</View>
          ))}
          {row.length < cols &&
            Array.from({ length: cols - row.length }).map((_, pi) => (
              <View key={`pad-${pi}`} style={styles.cell} />
            ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The full scrollable dashboard body: centered max-width column, measured
 * container, and the grid. ``header`` renders above the grid (e.g. an inline
 * create form) inside the same measured column.
 */
export function TileGridScreen({
  headerInset,
  header,
  children,
}: {
  headerInset: number;
  header?: ReactNode;
  children: ReactNode;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - containerWidth) > 1) setContainerWidth(w);
  }, [containerWidth]);
  // ``bodyInner`` carries 24px horizontal padding on each side.
  const cols = useMemo(
    () => columnsForWidth(Math.max(0, containerWidth - 48)),
    [containerWidth],
  );

  return (
    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
      <View
        style={[styles.bodyInner, { paddingTop: headerInset + 20 }]}
        onLayout={onContainerLayout}
      >
        {header}
        <Grid cols={cols}>{children}</Grid>
        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  bodyInner: {
    maxWidth: CONTENT_MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 24,
  },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { flex: 1, minWidth: 0 },
});
