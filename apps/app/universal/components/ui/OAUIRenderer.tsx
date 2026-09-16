import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import {
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { UIAction, UIJson, UINode, UIProp, UISpec } from '../../../common/ui-views';
import { canInvokeUIViewAction, resolveUIProp } from '../../../common/ui-views';
import { apiUrl } from '../../services/api';
import { colors, font, radius } from '../../theme';
import AttachmentBlock from '../Attachments';
import Button from '../Button';
import Card from '../Card';
import Markdown from '../Markdown';
import ThemedSwitch from '../ThemedSwitch';
import { useConfirm } from '../ConfirmDialog';
import OAUIChart from './OAUIChart';

type IconName = keyof typeof Feather.glyphMap;

interface RendererProps {
  spec: UISpec;
  data: Record<string, unknown>;
  actions?: Record<string, UIAction>;
  onAction?: (actionId: string, input?: unknown) => Promise<unknown>;
  canExecute?: boolean;
  compact?: boolean;
  presentationState?: 'loading' | 'empty' | 'stale' | 'error';
  viewContext?: { viewId: string; revision: number };
  renderSubView?: (viewId: string, revision?: number) => ReactNode;
}

interface BoundaryState { error: Error | null }

export class OAUIErrorBoundary extends Component<{ children: ReactNode; compact?: boolean }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[OA-UI] renderer error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={[styles.error, this.props.compact && styles.errorCompact]}>
        <Feather name="alert-triangle" size={14} color={colors.error} />
        <View style={styles.flex}>
          <Text style={styles.errorTitle}>This view could not be rendered</Text>
          <Text style={styles.errorText} numberOfLines={3}>{this.state.error.message}</Text>
        </View>
      </View>
    );
  }
}

export default function OAUIRenderer({
  spec,
  data,
  actions = {},
  onAction,
  canExecute = false,
  compact = false,
  presentationState,
  viewContext,
  renderSubView,
}: RendererProps) {
  const confirm = useConfirm();
  const [uiState, setUIState] = useState<Record<string, UIJson>>({});
  const runAction = async (actionId: string, input?: unknown) => {
    if (!canInvokeUIViewAction(canExecute, actionId)) return;
    const action = actions[actionId];
    if (!action) return;
    if (action?.confirm) {
      const ok = await confirm({
        title: action.label || 'Confirm action',
        message: `Run “${action.label || actionId}”?`,
        confirmLabel: 'Run',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    return onAction?.(actionId, input);
  };
  const bindingData = useMemo(() => ({ ...data, state: uiState }), [data, uiState]);
  const updateUIState = useCallback((name: string, value: UIJson) => {
    setUIState((current) => Object.is(current[name], value)
      ? current
      : { ...current, [name]: value });
  }, []);
  const renderedRoot = presentationState && spec.states?.[presentationState]
    ? spec.states[presentationState]!
    : spec.root;
  return (
    <OAUIErrorBoundary compact={compact}>
      <Node
        node={renderedRoot}
        data={bindingData}
        actions={actions}
        onAction={runAction}
        canExecute={canExecute}
        onStateChange={updateUIState}
        compact={compact}
        depth={0}
        viewContext={viewContext}
        renderSubView={renderSubView}
      />
    </OAUIErrorBoundary>
  );
}

interface NodeProps {
  node: UINode;
  data: Record<string, unknown>;
  actions: Record<string, UIAction>;
  onAction: (actionId: string, input?: unknown) => Promise<unknown> | undefined;
  canExecute: boolean;
  onStateChange: (name: string, value: UIJson) => void;
  compact?: boolean;
  depth: number;
  viewContext?: { viewId: string; revision: number };
  renderSubView?: (viewId: string, revision?: number) => ReactNode;
}

function Node({ node, data, actions, onAction, canExecute, onStateChange, compact, depth, viewContext, renderSubView }: NodeProps) {
  const p = useMemo(() => resolveProps(node.props, data), [node.props, data]);
  if (depth > 24) return <Unknown type="depth-limit" />;
  if (p.hidden === true) return null;
  const children = (node.children ?? []).map((child, index) => (
    <Node
      key={child.id || `${child.type}-${index}`}
      node={child}
      data={data}
      actions={actions}
      onAction={onAction}
      canExecute={canExecute}
      onStateChange={onStateChange}
      compact={compact}
      depth={depth + 1}
      viewContext={viewContext}
      renderSubView={renderSubView}
    />
  ));
  const gap = bounded(p.gap, 0, 32, 10);
  switch (node.type) {
    case 'stack':
      return <View style={[styles.stack, { gap }]}>{children}</View>;
    case 'row':
      return <View style={[styles.row, p.wrap !== false && styles.wrap, { gap }]}>{children}</View>;
    case 'grid': {
      const columns = bounded(p.columns, 1, 6, compact ? 1 : 2);
      return (
        <View style={[styles.row, styles.wrap, { gap }, Platform.OS === 'web' && ({ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } as any)]}>
          {children.map((child, index) => (
            <View
              key={node.children?.[index]?.id ?? index}
              style={Platform.OS === 'web'
                ? styles.gridCell
                : [styles.gridCell, { flexBasis: `${Math.max(10, 100 / columns - 2)}%` as any }]}
            >
              {child}
            </View>
          ))}
        </View>
      );
    }
    case 'card':
      return <Card tight={p.tight !== false} rail={p.rail === true} style={styles.nodeCard}>{children}</Card>;
    case 'scroll':
      return <ScrollView style={{ maxHeight: bounded(p.maxHeight, 120, 900, compact ? 360 : 680) }} nestedScrollEnabled>{children}</ScrollView>;
    case 'divider':
      return <View style={styles.divider} />;
    case 'spacer':
      return <View style={{ height: bounded(p.size ?? p.height, 0, 120, 12), width: bounded(p.width, 0, 120, 0) }} />;
    case 'heading':
      return <Text selectable style={[styles.heading, headingStyle(p.level), alignStyle(p.align)]}>{display(p.text ?? p.value)}</Text>;
    case 'text':
      return <Text selectable style={[styles.text, p.muted === true && styles.muted, alignStyle(p.align)]}>{display(p.text ?? p.value)}</Text>;
    case 'markdown':
      return <Markdown text={sanitizeOAUIMarkdown(display(p.text ?? p.value))} />;
    case 'code':
      return <View style={styles.code}><Text selectable style={styles.codeText}>{display(p.code ?? p.text ?? p.value)}</Text></View>;
    case 'badge':
      return <Badge label={display(p.label ?? p.text ?? p.value)} tone={display(p.tone)} />;
    case 'status':
      return <Status label={display(p.label ?? p.text ?? p.value)} status={display(p.status ?? p.tone)} />;
    case 'metric':
      return <Metric label={display(p.label)} value={display(p.value)} detail={display(p.detail)} trend={display(p.trend)} />;
    case 'progress':
      return <Progress value={number(p.value)} max={number(p.max, 100)} label={display(p.label)} />;
    case 'image':
      return <SafeImage reference={p.src ?? p.assetId ?? p.fileId} context={viewContext} alt={display(p.alt ?? p.label)} height={bounded(p.height, 80, 720, compact ? 200 : 320)} />;
    case 'icon':
      return <Icon name={display(p.name ?? p.icon)} label={display(p.label)} size={bounded(p.size, 10, 64, 18)} />;
    case 'file-link':
      return <FileLink reference={p.fileId ?? p.src ?? p.href} context={viewContext} filename={display(p.filename ?? p.label ?? 'File')} kind={display(p.kind)} />;
    case 'button':
      return <ActionButton props={p} onAction={onAction} canExecute={canExecute} />;
    case 'toggle':
      return <Toggle nodeId={node.id} props={p} onAction={onAction} canExecute={canExecute} onStateChange={onStateChange} />;
    case 'select':
      return <SelectControl nodeId={node.id} props={p} onAction={onAction} canExecute={canExecute} onStateChange={onStateChange} />;
    case 'segmented':
      return <Segmented nodeId={node.id} props={p} onAction={onAction} canExecute={canExecute} onStateChange={onStateChange} />;
    case 'text-input':
      return <TextInputControl nodeId={node.id} props={p} onAction={onAction} canExecute={canExecute} onStateChange={onStateChange} />;
    case 'tabs':
      return <Tabs node={node} data={data} actions={actions} onAction={onAction} canExecute={canExecute} onStateChange={onStateChange} compact={compact} depth={depth} viewContext={viewContext} renderSubView={renderSubView} />;
    case 'sub-view': {
      const nestedId = typeof (p.viewId ?? p.view_id ?? p.view) === 'string'
        ? String(p.viewId ?? p.view_id ?? p.view)
        : '';
      const nestedRevision = positiveInteger(p.revision);
      if (!nestedId) {
        return children.length ? <View style={styles.subView}>{children}</View> : <Unknown type="missing-sub-view" />;
      }
      if (!renderSubView) {
        return children.length ? <View style={styles.subView}>{children}</View> : <Unknown type="missing-sub-view" />;
      }
      if (nestedRevision == null) return <Unknown type="unpinned-sub-view" />;
      return <View style={styles.subView}>{renderSubView(nestedId, nestedRevision)}</View>;
    }
    case 'table':
      return <Table props={p} />;
    case 'list':
      return <List props={p} />;
    case 'key-value':
      return <KeyValue props={p} />;
    case 'line-chart':
    case 'bar-chart':
    case 'area-chart':
    case 'pie-chart':
    case 'donut-chart':
    case 'scatter-chart':
    case 'gauge':
    case 'sparkline':
      return (
        <OAUIChart
          type={node.type}
          data={p.data ?? p.values ?? p.series}
          title={display(p.title)}
          height={bounded(p.height, 100, 420, compact ? 170 : 230)}
          stacked={p.stacked === true}
          xKey={display(p.xKey)}
          yKey={display(p.yKey)}
          nameKey={display(p.nameKey)}
          valueKey={display(p.valueKey)}
          min={numberOrUndefined(p.min)}
          max={numberOrUndefined(p.max)}
        />
      );
    case 'loading-state':
      return <StatePanel kind="loading" props={p} />;
    case 'empty-state':
      return <StatePanel kind="empty" props={p} />;
    case 'stale-state':
      return <StatePanel kind="stale" props={p} />;
    case 'error-state':
      return <StatePanel kind="error" props={p} />;
    default:
      return <Unknown type={node.type} />;
  }
}

function resolveProps(props: Record<string, UIProp> | undefined, data: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(props ?? {})) out[key] = resolveUIProp(value, data);
  return out;
}

function ActionButton({ props, onAction, canExecute }: {
  props: Record<string, any>;
  onAction: NodeProps['onAction'];
  canExecute: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const action = typeof props.action === 'string' ? props.action : '';
  const press = async () => {
    if (!canInvokeUIViewAction(canExecute, action) || running) return;
    setRunning(true); setError('');
    try { await onAction(action, props.input); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunning(false); }
  };
  return (
    <View style={styles.controlWrap}>
      <Button
        label={running ? 'Running…' : display(props.label ?? props.text ?? 'Run')}
        icon={safeIcon(props.icon)}
        variant={props.variant === 'danger' ? 'danger' : props.variant === 'secondary' || props.variant === 'ghost' ? props.variant : 'primary'}
        size={props.size === 'xs' || props.size === 'sm' ? props.size : 'md'}
        disabled={!canInvokeUIViewAction(canExecute, action) || running || props.disabled === true}
        onPress={() => { void press(); }}
      />
      {error ? <Text style={styles.inlineError}>{error}</Text> : null}
    </View>
  );
}

function Toggle({ nodeId, props, onAction, canExecute, onStateChange }: {
  nodeId?: string;
  props: Record<string, any>;
  onAction: NodeProps['onAction'];
  canExecute: boolean;
  onStateChange: NodeProps['onStateChange'];
}) {
  const actionRunner = useControlAction(onAction, canExecute);
  const [value, setValue] = useState(Boolean(props.checked ?? props.value));
  useEffect(() => setValue(Boolean(props.checked ?? props.value)), [props.checked, props.value]);
  useEffect(() => {
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, value);
  }, [nodeId, onStateChange, props.name, value]);
  const action = typeof props.action === 'string' ? props.action : '';
  const actionBlocked = action.length > 0 && !canInvokeUIViewAction(canExecute, action);
  const change = (next: boolean) => {
    if (actionBlocked) return;
    setValue(next);
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, next);
    if (action) void actionRunner.run(action, { ...(recordValue(props.input)), value: next });
  };
  return (
    <View style={styles.stack}>
      <View style={styles.toggleRow}>
        <View style={styles.flex}>
          <Text style={styles.controlLabel}>{display(props.label)}</Text>
          {props.description ? <Text style={styles.controlDescription}>{display(props.description)}</Text> : null}
        </View>
        <ThemedSwitch value={value} onValueChange={change} disabled={props.disabled === true || actionBlocked || actionRunner.running} />
      </View>
      {actionRunner.error ? <Text style={styles.inlineError}>{actionRunner.error}</Text> : null}
    </View>
  );
}

function Segmented({ nodeId, props, onAction, canExecute, onStateChange }: {
  nodeId?: string;
  props: Record<string, any>;
  onAction: NodeProps['onAction'];
  canExecute: boolean;
  onStateChange: NodeProps['onStateChange'];
}) {
  const actionRunner = useControlAction(onAction, canExecute);
  const options = normalizeOptions(props.options);
  const action = typeof props.action === 'string' ? props.action : '';
  const actionBlocked = action.length > 0 && !canInvokeUIViewAction(canExecute, action);
  const defaultValue = String(props.selected ?? props.value ?? options[0]?.value ?? '');
  const [value, setValue] = useState(defaultValue);
  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);
  useEffect(() => {
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, value);
  }, [nodeId, onStateChange, props.name, value]);
  return (
    <View style={styles.stack}>
      {props.label ? <Text style={styles.controlLabel}>{display(props.label)}</Text> : null}
      <View style={[styles.segmented, styles.wrap, actionBlocked && styles.controlDisabled]}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => {
                if (actionBlocked) return;
                setValue(option.value);
                const name = stateName(props.name, nodeId);
                if (name) onStateChange(name, option.value);
                if (action) void actionRunner.run(action, { ...(recordValue(props.input)), value: option.value });
              }}
              style={[styles.segment, active && styles.segmentActive]}
              disabled={props.disabled === true || actionBlocked || actionRunner.running}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled: props.disabled === true || actionBlocked || actionRunner.running }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {actionRunner.error ? <Text style={styles.inlineError}>{actionRunner.error}</Text> : null}
    </View>
  );
}

function SelectControl({ nodeId, props, onAction, canExecute, onStateChange }: {
  nodeId?: string;
  props: Record<string, any>;
  onAction: NodeProps['onAction'];
  canExecute: boolean;
  onStateChange: NodeProps['onStateChange'];
}) {
  const options = useMemo(() => normalizeOptions(props.options), [props.options]);
  const multiple = props.multiple === true;
  const initial = useMemo<string | string[]>(() => multiple
    ? (Array.isArray(props.selected ?? props.value) ? (props.selected ?? props.value).map(String) : [])
    : String(props.selected ?? props.value ?? options[0]?.value ?? ''),
  [multiple, options, props.selected, props.value]);
  const [value, setValue] = useState<string | string[]>(initial);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const action = typeof props.action === 'string' ? props.action : '';
  const actionBlocked = action.length > 0 && !canInvokeUIViewAction(canExecute, action);
  useEffect(() => setValue(initial), [initial]);
  useEffect(() => {
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, value);
  }, [nodeId, onStateChange, props.name, value]);
  const selected = Array.isArray(value) ? value : [value];
  const label = selected.length
    ? options.filter((option) => selected.includes(option.value)).map((option) => option.label).join(', ')
    : display(props.placeholder) || 'Select…';
  const choose = async (optionValue: string) => {
    if (running || props.disabled === true || actionBlocked) return;
    const next: string | string[] = multiple
      ? (selected.includes(optionValue)
          ? selected.filter((item) => item !== optionValue)
          : [...selected, optionValue])
      : optionValue;
    setValue(next);
    if (!multiple) setOpen(false);
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, next);
    if (!action) return;
    setRunning(true); setError('');
    try { await onAction(action, { ...recordValue(props.input), value: next }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunning(false); }
  };
  return (
    <View style={styles.stack}>
      {props.label ? <Text style={styles.controlLabel}>{display(props.label)}</Text> : null}
      <Pressable
        style={[styles.selectButton, open && styles.selectButtonOpen, actionBlocked && styles.controlDisabled]}
        onPress={() => setOpen((current) => !current)}
        disabled={props.disabled === true || actionBlocked || running}
        accessibilityRole="button"
        accessibilityLabel={display(props.label ?? props.name ?? 'Select')}
        accessibilityState={{ expanded: open, disabled: props.disabled === true || actionBlocked || running }}
      >
        <Text style={styles.selectText} numberOfLines={1}>{running ? 'Updating…' : label}</Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
      </Pressable>
      {open ? (
        <ScrollView style={styles.selectMenu} accessibilityRole="menu" nestedScrollEnabled>
          {options.map((option) => {
            const active = selected.includes(option.value);
            return (
              <Pressable
                key={option.value}
                style={[styles.selectOption, active && styles.selectOptionActive]}
                onPress={() => { void choose(option.value); }}
                disabled={props.disabled === true || actionBlocked || running}
                accessibilityRole={multiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: active, selected: active, disabled: props.disabled === true || actionBlocked || running }}
              >
                <Text style={[styles.selectOptionText, active && styles.segmentTextActive]}>{option.label}</Text>
                {active ? <Feather name="check" size={13} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {error ? <Text style={styles.inlineError}>{error}</Text> : null}
    </View>
  );
}

function TextInputControl({ nodeId, props, onAction, canExecute, onStateChange }: {
  nodeId?: string;
  props: Record<string, any>;
  onAction: NodeProps['onAction'];
  canExecute: boolean;
  onStateChange: NodeProps['onStateChange'];
}) {
  const actionRunner = useControlAction(onAction, canExecute);
  const [value, setValue] = useState(display(props.value));
  useEffect(() => setValue(display(props.value)), [props.value]);
  useEffect(() => {
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, value);
  }, [nodeId, onStateChange, props.name, value]);
  const action = typeof props.action === 'string' ? props.action : '';
  const actionBlocked = action.length > 0 && !canInvokeUIViewAction(canExecute, action);
  const update = (next: string) => {
    setValue(next);
    const name = stateName(props.name, nodeId);
    if (name) onStateChange(name, next);
  };
  const submit = () => {
    if (!actionBlocked && action) void actionRunner.run(action, { ...(recordValue(props.input)), value });
  };
  return (
    <View style={styles.stack}>
      {props.label ? <Text style={styles.controlLabel}>{display(props.label)}</Text> : null}
      <TextInput
        value={value}
        onChangeText={update}
        onSubmitEditing={submit}
        placeholder={display(props.placeholder)}
        placeholderTextColor={colors.textMuted}
        editable={props.disabled !== true && !actionBlocked && !actionRunner.running}
        multiline={props.multiline === true}
        maxLength={bounded(props.maxLength, 1, 10_000, 2_000)}
        secureTextEntry={false}
        style={[styles.textInput, props.multiline === true && styles.textInputMultiline, actionBlocked && styles.controlDisabled]}
        accessibilityLabel={display(props.ariaLabel ?? props.label ?? props.name ?? 'Text input')}
        accessibilityState={{ disabled: props.disabled === true || actionBlocked || actionRunner.running }}
      />
      {action && props.submitLabel ? (
        <Button
          label={actionRunner.running ? 'Running…' : display(props.submitLabel)}
          size="sm"
          variant="secondary"
          onPress={submit}
          disabled={props.disabled === true || actionBlocked || actionRunner.running}
        />
      ) : null}
      {actionRunner.error ? <Text style={styles.inlineError}>{actionRunner.error}</Text> : null}
    </View>
  );
}

function useControlAction(onAction: NodeProps['onAction'], canExecute: boolean) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (actionId: string, input?: unknown) => {
    if (running || !canInvokeUIViewAction(canExecute, actionId)) return;
    setRunning(true); setError('');
    try { return await onAction(actionId, input); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setRunning(false);
    }
  }, [canExecute, onAction, running]);
  return { run, running, error };
}

function Tabs(props: NodeProps) {
  const entries = props.node.children ?? [];
  const [selected, setSelected] = useState(0);
  if (!entries.length) return null;
  const index = Math.min(selected, entries.length - 1);
  return (
    <View style={styles.stack}>
      <View style={[styles.segmented, styles.wrap]}>
        {entries.map((child, childIndex) => (
          <Pressable
            key={child.id || childIndex}
            onPress={() => setSelected(childIndex)}
            style={[styles.segment, childIndex === index && styles.segmentActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: childIndex === index }}
            accessibilityLabel={display(resolveUIProp(child.props?.label ?? child.props?.title, props.data)) || `Tab ${childIndex + 1}`}
          >
            <Text style={[styles.segmentText, childIndex === index && styles.segmentTextActive]}>
              {display(resolveUIProp(child.props?.label ?? child.props?.title, props.data)) || `Tab ${childIndex + 1}`}
            </Text>
          </Pressable>
        ))}
      </View>
      <Node {...props} node={entries[index]} depth={props.depth + 1} />
    </View>
  );
}

function Table({ props }: { props: Record<string, any> }) {
  const rows = Array.isArray(props.rows ?? props.data) ? (props.rows ?? props.data).slice(0, 1_000) : [];
  const explicit = Array.isArray(props.columns) ? props.columns : [];
  const columns = (explicit.length ? explicit : Object.keys(recordValue(rows[0]))).slice(0, 12).map((column: any) => (
    typeof column === 'string' ? { key: column, label: column } : { key: String(column?.key ?? ''), label: String(column?.label ?? column?.key ?? '') }
  )).filter((column: any) => column.key);
  const pageSize = bounded(props.pageSize, 5, 50, 12);
  const renderRow = ({ item: row }: { item: any }) => (
    <View style={styles.tableRow}>
      {columns.map((column: any) => <Text selectable key={column.key} style={styles.tableCell} numberOfLines={3}>{display(recordValue(row)[column.key])}</Text>)}
    </View>
  );
  return (
    <ScrollView horizontal style={styles.tableScroll}>
      <View>
        <View style={[styles.tableRow, styles.tableHead]}>
          {columns.map((column: any) => <Text key={column.key} style={[styles.tableCell, styles.tableHeadText]}>{column.label}</Text>)}
        </View>
        <FlatList
          data={rows}
          renderItem={renderRow}
          keyExtractor={(_row, index) => String(index)}
          style={{ maxHeight: pageSize * 38 }}
          initialNumToRender={pageSize}
          maxToRenderPerBatch={pageSize}
          windowSize={5}
          nestedScrollEnabled
          scrollEnabled={rows.length > pageSize}
        />
      </View>
    </ScrollView>
  );
}

function List({ props }: { props: Record<string, any> }) {
  const rows = Array.isArray(props.items ?? props.data) ? (props.items ?? props.data).slice(0, 1_000) : [];
  const renderItem = ({ item: row }: { item: any }) => {
    const item = recordValue(row);
    return (
      <View style={styles.listRow}>
        <View style={styles.listDot} />
        <View style={styles.flex}>
          <Text selectable style={styles.text}>{display(item.label ?? item.title ?? row)}</Text>
          {item.detail ?? item.description ? <Text style={styles.muted}>{display(item.detail ?? item.description)}</Text> : null}
        </View>
      </View>
    );
  };
  return (
    <FlatList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(row, index) => display(recordValue(row).id ?? recordValue(row).key) || String(index)}
      style={[styles.list, { maxHeight: 480 }]}
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={5}
      nestedScrollEnabled
      scrollEnabled={rows.length > 20}
    />
  );
}

function KeyValue({ props }: { props: Record<string, any> }) {
  const raw = props.items ?? props.value ?? props.data;
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.slice(0, 100).map((item, index) => {
        const row = recordValue(item);
        return [display(row.key ?? row.label) || String(index + 1), row.value ?? row.detail ?? item];
      })
    : Object.entries(recordValue(raw)).slice(0, 100);
  return <View style={styles.keyValue}>{entries.map(([key, item]) => (
    <View key={key} style={styles.keyValueRow}>
      <Text style={styles.key}>{key}</Text><Text selectable style={styles.value}>{display(item)}</Text>
    </View>
  ))}</View>;
}

function Metric({ label, value, detail, trend }: { label: string; value: string; detail: string; trend: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text selectable style={styles.metricValue}>{value || '—'}</Text>
      {detail || trend ? <Text style={styles.metricDetail}>{[trend, detail].filter(Boolean).join(' · ')}</Text> : null}
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: string }) {
  const color = toneColor(tone);
  return <View style={[styles.badge, { borderColor: color }]}><Text style={[styles.badgeText, { color }]}>{label}</Text></View>;
}

function Status({ label, status }: { label: string; status: string }) {
  const color = toneColor(status);
  return <View style={styles.status}><View style={[styles.statusDot, { backgroundColor: color }]} /><Text style={styles.text}>{label || status}</Text></View>;
}

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(1, max)));
  return <View style={styles.stack}>{label ? <Text style={styles.controlLabel}>{label}</Text> : null}<View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${ratio * 100}%` as any }]} /></View></View>;
}

function SafeImage({ reference, context, alt, height }: {
  reference: unknown;
  context?: { viewId: string; revision: number };
  alt: string;
  height: number;
}) {
  const uri = safeViewResourceUrl(reference, context);
  if (!uri) return <Unknown type="unsafe-image" />;
  return <View style={styles.imageWrap}><Image source={{ uri }} resizeMode="contain" accessibilityLabel={alt || 'View image'} style={[styles.image, { height }]} />{alt ? <Text style={styles.imageCaption}>{alt}</Text> : null}</View>;
}

function Icon({ name, label, size }: { name: string; label: string; size: number }) {
  const icon = safeIcon(name) ?? 'circle';
  return <View style={styles.iconRow}><Feather name={icon} size={size} color={colors.accent} />{label ? <Text style={styles.text}>{label}</Text> : null}</View>;
}

function FileLink({ reference, context, filename, kind }: {
  reference: unknown;
  context?: { viewId: string; revision: number };
  filename: string;
  kind: string;
}) {
  const path = safeViewResourcePath(reference, context);
  if (!path) return <Unknown type="missing-file" />;
  const type = kind === 'image' || kind === 'voice' || kind === 'video' ? kind : 'file';
  return <AttachmentBlock attachments={[{ type, path, filename }]} downloadable />;
}

function Unknown({ type }: { type: string }) {
  return (
    <View style={styles.unknown}>
      <Feather name="box" size={13} color={colors.textMuted} />
      <Text style={styles.unknownText}>Unsupported component: {type}</Text>
    </View>
  );
}

function StatePanel({ kind, props }: {
  kind: 'loading' | 'empty' | 'stale' | 'error';
  props: Record<string, any>;
}) {
  const defaults = {
    loading: { icon: 'loader', title: 'Loading…' },
    empty: { icon: 'inbox', title: 'No data' },
    stale: { icon: 'pause-circle', title: 'Last saved data' },
    error: { icon: 'alert-circle', title: 'Data unavailable' },
  } as const;
  const fallback = defaults[kind];
  return (
    <View style={[styles.statePanel, kind === 'error' && styles.statePanelError]}>
      <Feather name={safeIcon(props.icon) ?? fallback.icon} size={16} color={kind === 'error' ? colors.error : kind === 'stale' ? colors.warning : colors.textMuted} />
      <View style={styles.flex}>
        <Text style={styles.statePanelTitle}>{display(props.title ?? props.label ?? fallback.title)}</Text>
        {props.description ?? props.text ? <Text style={styles.statePanelText}>{display(props.description ?? props.text)}</Text> : null}
      </View>
    </View>
  );
}

function safeViewResourcePath(
  value: unknown,
  context?: { viewId: string; revision: number },
): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  const artifact = value.match(/^artifact:(?:\/\/)?([A-Za-z0-9][A-Za-z0-9_-]{0,255})$/);
  if (artifact) return `/api/artifacts/${encodeURIComponent(artifact[1])}/content`;
  if (/^\/api\/artifacts\/[A-Za-z0-9_-]+\/content$/.test(value)) return value;
  const asset = value.match(/^asset:(?:\/\/)?([A-Za-z0-9][A-Za-z0-9_./-]{0,1023})$/);
  if (!asset || !context || context.revision < 1) return null;
  const pieces = asset[1].split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) return null;
  const safePath = pieces.map(encodeURIComponent).join('/');
  return `/api/ui/views/${encodeURIComponent(context.viewId)}/revisions/${context.revision}/assets/${safePath}`;
}

function safeViewResourceUrl(
  value: unknown,
  context?: { viewId: string; revision: number },
): string | null {
  const path = safeViewResourcePath(value, context);
  return path ? apiUrl(path) : null;
}

/** OA-UI markdown can format prose and links but cannot smuggle a remote
 * image around the compiler's artifact/asset-only media policy. */
export function sanitizeOAUIMarkdown(value: string): string {
  return value.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt: string) => alt || '[image]');
}

function safeIcon(value: unknown): IconName | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(Feather.glyphMap, value)
    ? value as IconName
    : undefined;
}

function stateName(value: unknown, nodeId?: string): string | null {
  const candidate = typeof value === 'string' && value ? value : nodeId;
  return candidate && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)
    ? candidate
    : null;
}

function normalizeOptions(value: unknown): { label: string; value: string }[] {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((option) => {
    if (typeof option === 'string' || typeof option === 'number') return { label: String(option), value: String(option) };
    const row = recordValue(option);
    return { label: display(row.label ?? row.value), value: display(row.value ?? row.label) };
  }).filter((option) => option.value);
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function display(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 100_000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value).slice(0, 100_000); } catch { return String(value); }
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, number(value, fallback)));
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toneColor(tone: string): string {
  if (/success|ok|ready|online|positive/i.test(tone)) return colors.success;
  if (/error|fail|danger|offline|negative/i.test(tone)) return colors.error;
  if (/warn|stale|pending|running/i.test(tone)) return colors.warning;
  return colors.accent;
}

function headingStyle(level: unknown) {
  const n = bounded(level, 1, 6, 2);
  if (n === 1) return styles.heading1;
  if (n === 2) return styles.heading2;
  return styles.heading3;
}

function alignStyle(align: unknown) {
  return align === 'center' ? styles.center : align === 'right' ? styles.right : undefined;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stack: { width: '100%', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  gridCell: { minWidth: 0 },
  nodeCard: { minWidth: 0 },
  divider: { height: 1, width: '100%', backgroundColor: colors.borderLight },
  heading: { fontFamily: font.display, color: colors.text, fontWeight: '600' },
  heading1: { fontSize: 24, lineHeight: 30 },
  heading2: { fontSize: 19, lineHeight: 25 },
  heading3: { fontSize: 15, lineHeight: 21 },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  text: { fontFamily: font.sans, fontSize: 13, lineHeight: 19, color: colors.text },
  muted: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 17, color: colors.textMuted },
  code: { backgroundColor: colors.codeBg, borderWidth: 1, borderColor: colors.codeBorder, borderRadius: radius.md, padding: 11 },
  codeText: { fontFamily: font.mono, color: colors.codeText, fontSize: 12, lineHeight: 18 },
  error: { flexDirection: 'row', gap: 9, padding: 14, borderWidth: 1, borderColor: colors.errorBorder, backgroundColor: colors.errorSoft, borderRadius: radius.md },
  errorCompact: { padding: 10 },
  errorTitle: { fontFamily: font.sans, color: colors.error, fontWeight: '600', fontSize: 12 },
  errorText: { fontFamily: font.sans, color: colors.textSecondary, fontSize: 11, marginTop: 3 },
  unknown: { flexDirection: 'row', alignItems: 'center', gap: 7, padding: 9, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.mutedSoft },
  unknownText: { fontFamily: font.mono, color: colors.textMuted, fontSize: 10.5 },
  controlWrap: { alignItems: 'flex-start', gap: 5 },
  controlDisabled: { opacity: 0.4 },
  inlineError: { fontFamily: font.sans, fontSize: 10.5, color: colors.error },
  subView: { width: '100%', minWidth: 0 },
  toggleRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12 },
  controlLabel: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  controlDescription: { fontFamily: font.sans, fontSize: 10.5, lineHeight: 15, color: colors.textMuted, marginTop: 2 },
  textInput: { width: '100%', minHeight: 38, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.inputBg, color: colors.text, fontFamily: font.sans, fontSize: 12 },
  textInputMultiline: { minHeight: 86, textAlignVertical: 'top' },
  segmented: { flexDirection: 'row', gap: 3, padding: 3, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg, borderRadius: radius.md, alignSelf: 'flex-start' },
  segment: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.primaryLight },
  segmentText: { fontFamily: font.sans, fontSize: 11, color: colors.textMuted },
  segmentTextActive: { color: colors.accent, fontWeight: '600' },
  selectButton: { minHeight: 38, width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.inputBg },
  selectButtonOpen: { borderColor: colors.accent },
  selectText: { flex: 1, fontFamily: font.sans, fontSize: 12, color: colors.text },
  selectMenu: { width: '100%', maxHeight: 260, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceElevated },
  selectOption: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  selectOptionActive: { backgroundColor: colors.primaryLight },
  selectOptionText: { flex: 1, fontFamily: font.sans, fontSize: 11.5, color: colors.textSecondary },
  tableScroll: { maxWidth: '100%', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  tableHead: { backgroundColor: colors.inputBg },
  tableCell: { width: 150, paddingHorizontal: 10, paddingVertical: 8, fontFamily: font.sans, fontSize: 11, color: colors.textSecondary },
  tableHeadText: { color: colors.text, fontWeight: '600' },
  list: { width: '100%' },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  listDot: { width: 5, height: 5, borderRadius: 3, marginTop: 7, backgroundColor: colors.accent },
  keyValue: { width: '100%' },
  keyValueRow: { flexDirection: 'row', gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  key: { width: 130, fontFamily: font.sans, fontSize: 11, color: colors.textMuted },
  value: { flex: 1, fontFamily: font.mono, fontSize: 11, color: colors.text },
  metric: { minWidth: 120, gap: 3 },
  metricLabel: { fontFamily: font.sans, fontSize: 10.5, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  metricValue: { fontFamily: font.display, fontSize: 25, color: colors.text, fontWeight: '600' },
  metricDetail: { fontFamily: font.sans, fontSize: 10.5, color: colors.textSecondary },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.mutedSoft },
  badgeText: { fontFamily: font.sans, fontSize: 9.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  progressTrack: { width: '100%', height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.border },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 4 },
  imageWrap: { width: '100%', overflow: 'hidden', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  image: { width: '100%', backgroundColor: colors.inputBg },
  imageCaption: { paddingHorizontal: 9, paddingVertical: 6, fontFamily: font.sans, fontSize: 10.5, color: colors.textMuted },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statePanel: { width: '100%', minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.md, backgroundColor: colors.mutedSoft },
  statePanelError: { borderColor: colors.errorBorder, backgroundColor: colors.errorSoft },
  statePanelTitle: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  statePanelText: { marginTop: 2, fontFamily: font.sans, fontSize: 10.5, lineHeight: 15, color: colors.textMuted },
});
