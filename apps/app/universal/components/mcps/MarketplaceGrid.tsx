import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function Grid({ cols, children }: { cols: number; children: React.ReactNode }) {
  // Chunk the children into fixed-size rows and give each cell ``flex: 1``.
  // Why not ``flexBasis: 33.33%`` with wrap: percent-sized cells plus a
  // ``gap`` overflow slightly, and the last-row orphans need explicit
  // ``maxWidth`` caps to keep columns aligned. Row-chunking sidesteps both
  // problems — every row is an independent flexbox with N equal cells,
  // and the last row is padded with empty spacers so columns line up.
  const gap = 14;
  const nodes = Array.isArray(children) ? children : [children];
  const rows: React.ReactNode[][] = [];
  for (let i = 0; i < nodes.length; i += cols) {
    rows.push(nodes.slice(i, i + cols));
  }
  return (
    <View style={{ gap }}>
      {rows.map((row, ri) => (
        <View key={ri} style={[gridStyles.row, { gap }]}>
          {row.map((child, ci) => (
            <View key={ci} style={gridStyles.cell}>{child}</View>
          ))}
          {/* Pad short last row so remaining columns don't stretch. */}
          {row.length < cols &&
            Array.from({ length: cols - row.length }).map((_, pi) => (
              <View key={`pad-${pi}`} style={gridStyles.cell} />
            ))}
        </View>
      ))}
    </View>
  );
}

const gridStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  cell: { flex: 1, minWidth: 0 },
});
