import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { colors, font, radius } from '../../theme';

interface Point { x: number; y: number; label?: string }
interface Series { name: string; points: Point[]; color: string }

function number(value: unknown, fallback = 0): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function normalizeSeries(raw: unknown, keys: { xKey?: string; yKey?: string; nameKey?: string; valueKey?: string }): Series[] {
  const palette = [...colors.graph];
  const source = Array.isArray(raw) ? raw.slice(0, 500) : raw == null ? [] : [raw];
  const looksLikeSeries = source.some((row) => row && typeof row === 'object' && Array.isArray((row as any).data));
  const rows = looksLikeSeries ? source.slice(0, 12) : [{ name: '', data: source }];
  return rows.map((entry: any, seriesIndex) => {
    const values = Array.isArray(entry?.data) ? entry.data.slice(0, 500) : [];
    return {
      name: typeof entry?.[keys.nameKey || 'name'] === 'string' ? entry[keys.nameKey || 'name'] : '',
      // OA-UI inherits the client theme; data cannot inject arbitrary CSS
      // colors into SVG attributes.
      color: palette[seriesIndex % palette.length],
      points: values.map((value: any, index: number) => {
        if (typeof value === 'number') return { x: index, y: value, label: String(index + 1) };
        return {
          x: number(value?.[keys.xKey || 'x'], index),
          y: number(value?.[keys.yKey || keys.valueKey || 'y'] ?? value?.value),
          label: typeof value?.[keys.nameKey || 'label'] === 'string'
            ? value[keys.nameKey || 'label']
            : String(value?.[keys.xKey || 'x'] ?? index + 1),
        };
      }),
    };
  }).filter((series) => series.points.length > 0);
}

function polar(cx: number, cy: number, radiusValue: number, angle: number) {
  const rad = (angle - 90) * Math.PI / 180;
  return { x: cx + radiusValue * Math.cos(rad), y: cy + radiusValue * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, outer: number, start: number, end: number, inner = 0): string {
  const a = polar(cx, cy, outer, end);
  const b = polar(cx, cy, outer, start);
  const large = end - start > 180 ? 1 : 0;
  if (!inner) return `M ${cx} ${cy} L ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 0 ${b.x} ${b.y} Z`;
  const c = polar(cx, cy, inner, start);
  const d = polar(cx, cy, inner, end);
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 0 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 ${large} 1 ${d.x} ${d.y} Z`;
}

export default function OAUIChart({
  type,
  data,
  title,
  height = 220,
  stacked = false,
  xKey,
  yKey,
  nameKey,
  valueKey,
  min,
  max,
}: {
  type: string;
  data: unknown;
  title?: string;
  height?: number;
  stacked?: boolean;
  xKey?: string;
  yKey?: string;
  nameKey?: string;
  valueKey?: string;
  min?: number;
  max?: number;
}) {
  const [width, setWidth] = useState(560);
  const series = useMemo(
    () => normalizeSeries(data, { xKey, yKey, nameKey, valueKey }),
    [data, nameKey, valueKey, xKey, yKey],
  );
  const chartHeight = Math.max(120, Math.min(420, height));
  if (!series.length) {
    return (
      <View style={[styles.empty, { height: chartHeight }]}>
        <Text style={styles.emptyText}>No chart data</Text>
      </View>
    );
  }
  const isPie = type === 'pie-chart' || type === 'donut-chart';
  const isGauge = type === 'gauge';
  return (
    <View
      style={styles.root}
      onLayout={(event) => setWidth(Math.max(220, event.nativeEvent.layout.width))}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${title || type} chart with ${series.reduce((count, item) => count + item.points.length, 0)} data points`}
    >
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Svg width="100%" height={chartHeight} viewBox={`0 0 ${width} ${chartHeight}`}>
        {isPie
          ? <Pie series={series} width={width} height={chartHeight} donut={type === 'donut-chart'} />
          : isGauge
            ? <Gauge series={series} width={width} height={chartHeight} min={min} max={max} />
            : <Cartesian series={series} width={width} height={chartHeight} type={type} stacked={stacked} />}
      </Svg>
      {series.length > 1 ? (
        <View style={styles.legend}>
          {series.map((item) => (
            <View key={item.name || item.color} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: item.color }]} />
              <Text style={styles.legendText}>{item.name || 'Series'}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Cartesian({ series, width, height, type, stacked }: {
  series: Series[]; width: number; height: number; type: string; stacked: boolean;
}) {
  const pad = { left: 42, right: 16, top: 14, bottom: 28 };
  const all = series.flatMap((item) => item.points);
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const stackExtents = new Map<number, { positive: number; negative: number }>();
  if (stacked && type === 'bar-chart') {
    for (const point of all) {
      const current = stackExtents.get(point.x) ?? { positive: 0, negative: 0 };
      if (point.y >= 0) current.positive += point.y;
      else current.negative += point.y;
      stackExtents.set(point.x, current);
    }
  }
  const minY = stacked && type === 'bar-chart'
    ? Math.min(0, ...Array.from(stackExtents.values(), (item) => item.negative))
    : Math.min(0, ...all.map((point) => point.y));
  const maxY = stacked && type === 'bar-chart'
    ? Math.max(1, ...Array.from(stackExtents.values(), (item) => item.positive))
    : Math.max(1, ...all.map((point) => point.y));
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const sx = (x: number) => pad.left + ((x - minX) / Math.max(1, maxX - minX)) * plotW;
  const sy = (y: number) => pad.top + plotH - ((y - minY) / Math.max(1, maxY - minY)) * plotH;
  const zero = sy(0);
  const barCount = Math.max(...series.map((item) => item.points.length));
  const barWidth = Math.max(2, Math.min(28, plotW / Math.max(1, barCount * (stacked ? 1 : series.length)) * 0.68));
  const renderedStacks = new Map<number, { positive: number; negative: number }>();
  return (
    <G>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const y = pad.top + plotH * fraction;
        const label = maxY - (maxY - minY) * fraction;
        return (
          <G key={fraction}>
            <Line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke={colors.borderLight} strokeWidth={1} />
            <SvgText x={pad.left - 7} y={y + 4} textAnchor="end" fill={colors.textMuted} fontSize={9}>{format(label)}</SvgText>
          </G>
        );
      })}
      {series.map((item, seriesIndex) => {
        if (type === 'bar-chart') {
          return (
            <G key={`${item.name}-${seriesIndex}`}>
              {item.points.map((point, index) => {
                const current = renderedStacks.get(point.x) ?? { positive: 0, negative: 0 };
                const start = stacked ? (point.y >= 0 ? current.positive : current.negative) : 0;
                const end = start + point.y;
                if (stacked) {
                  if (point.y >= 0) current.positive = end;
                  else current.negative = end;
                  renderedStacks.set(point.x, current);
                }
                const x = stacked
                  ? sx(point.x) - barWidth / 2
                  : sx(point.x) - (series.length * barWidth) / 2 + seriesIndex * barWidth;
                const yStart = sy(start);
                const yEnd = sy(end);
                return <Rect key={index} x={x} y={Math.min(yStart, yEnd)} width={barWidth - 1} height={Math.max(1, Math.abs(yStart - yEnd))} rx={2} fill={item.color} />;
              })}
            </G>
          );
        }
        const points = item.points.map((point) => `${sx(point.x)},${sy(point.y)}`).join(' ');
        if (type === 'area-chart') {
          const first = item.points[0];
          const last = item.points[item.points.length - 1];
          const path = `M ${sx(first.x)} ${zero} L ${points.replace(/ /g, ' L ')} L ${sx(last.x)} ${zero} Z`;
          return (
            <G key={`${item.name}-${seriesIndex}`}>
              <Path d={path} fill={item.color} fillOpacity={0.18} />
              <Polyline points={points} fill="none" stroke={item.color} strokeWidth={2} />
            </G>
          );
        }
        if (type === 'scatter-chart') {
          return <G key={`${item.name}-${seriesIndex}`}>{item.points.map((point, index) => <Circle key={index} cx={sx(point.x)} cy={sy(point.y)} r={3.5} fill={item.color} />)}</G>;
        }
        return <Polyline key={`${item.name}-${seriesIndex}`} points={points} fill="none" stroke={item.color} strokeWidth={type === 'sparkline' ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />;
      })}
      {type !== 'sparkline' ? all.slice(0, 8).map((point, index) => (
        <SvgText key={index} x={sx(point.x)} y={height - 8} textAnchor="middle" fill={colors.textMuted} fontSize={9}>{point.label}</SvgText>
      )) : null}
    </G>
  );
}

function Pie({ series, width, height, donut }: {
  series: Series[]; width: number; height: number; donut: boolean;
}) {
  const values = series.length > 1
    ? series.map((item) => ({ value: Math.max(0, item.points.reduce((sum, p) => sum + p.y, 0)), color: item.color }))
    : series[0].points.map((point, index) => ({ value: Math.max(0, point.y), color: colors.graph[index % colors.graph.length] }));
  const total = Math.max(1, values.reduce((sum, item) => sum + item.value, 0));
  const radiusValue = Math.min(width, height) * 0.38;
  const cx = width / 2;
  const cy = height / 2;
  let cursor = 0;
  return <G>{values.map((item, index) => {
    const angle = item.value / total * 359.999;
    const path = arcPath(cx, cy, radiusValue, cursor, cursor + angle, donut ? radiusValue * 0.58 : 0);
    cursor += angle;
    return <Path key={index} d={path} fill={item.color} stroke={colors.bg} strokeWidth={1} />;
  })}</G>;
}

function Gauge({ series, width, height, min: configuredMin, max: configuredMax }: {
  series: Series[]; width: number; height: number; min?: number; max?: number;
}) {
  const value = series[0].points[0]?.y ?? 0;
  const min = configuredMin ?? 0;
  const max = configuredMax != null && configuredMax > min ? configuredMax : 100;
  const ratio = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
  const cx = width / 2;
  const cy = height * 0.72;
  const radiusValue = Math.min(width * 0.33, height * 0.58);
  return (
    <G>
      <Path d={arcPath(cx, cy, radiusValue, -90, 90, radiusValue * 0.72)} fill={colors.border} />
      {ratio > 0 ? <Path d={arcPath(cx, cy, radiusValue, -90, -90 + ratio * 180, radiusValue * 0.72)} fill={series[0].color} /> : null}
      <SvgText x={cx} y={cy - 8} textAnchor="middle" fill={colors.text} fontSize={24} fontWeight="600">{format(value)}</SvgText>
    </G>
  );
}

function format(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const styles = StyleSheet.create({
  root: { width: '100%', gap: 8 },
  title: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  empty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.md },
  emptyText: { fontFamily: font.sans, fontSize: 12, color: colors.textMuted },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  legendText: { fontFamily: font.sans, fontSize: 10, color: colors.textMuted },
});
