import {
  normalizeAttachmentRefs,
  type AttachmentRef,
} from './attachments.ts';

export { normalizeAttachmentRefs } from './attachments.ts';

/**
 * OA-UI v1 wire model.
 *
 * A custom view is declarative data, never executable HTML or JavaScript.
 * Bindings address one named data slot with an RFC 6901 JSON Pointer.  This
 * module deliberately has no React dependency so adapters and tests can use
 * the exact same validation/resolution rules as the renderer.
 */

export type UIJson =
  | null
  | boolean
  | number
  | string
  | UIJson[]
  | { [key: string]: UIJson };

export interface UIBinding {
  $bind: {
    source: string;
    path: string;
  };
  fallback?: UIJson;
}

export type UIProp = UIJson | UIBinding;

export interface UINode {
  type: string;
  id?: string;
  props?: Record<string, UIProp>;
  children?: UINode[];
}

export interface UISpec {
  schemaVersion: 1;
  root: UINode;
  states?: Partial<Record<'loading' | 'empty' | 'stale' | 'error', UINode>>;
}

export type UIViewSurface = 'inline' | 'sidebar';
export type UIViewStatus = 'active' | 'stale' | 'expired' | 'deleted' | 'error';

export interface UIViewSummary {
  id: string;
  surface: UIViewSurface;
  title: string;
  description?: string;
  icon?: string;
  revision: number;
  status: UIViewStatus;
  sessionId?: string;
  expiresAt?: string | number | null;
  createdAt?: string | number;
  updatedAt?: string | number;
  sidebarOrder?: number;
  sidebarGroup?: string;
  lastViewedAt?: string | number;
  frozen?: boolean;
  frozenAt?: string | number | null;
  /** Actor-specific server authorization. Missing is intentionally treated
   * as false by clients so an older gateway cannot accidentally enable
   * server-side actions. */
  canExecute?: boolean;
}

export interface UIDataEntry {
  value: UIJson;
  version: number;
  generation?: number;
  sequence?: number;
  updatedAt: string | number;
  status: 'ready' | 'loading' | 'empty' | 'stale' | 'error';
  error?: string;
}

export interface UISource {
  key: string;
  driver: 'static' | 'push' | 'file_watch' | 'command_poll' | 'command_stream' | (string & {});
  activation: 'while_visible' | 'always' | 'manual' | (string & {});
  status: string;
  config?: Record<string, UIJson>;
  outputSchema?: UIJson;
  updatedAt?: string | number;
  expiresAt?: string | number;
}

export interface UIAction {
  id: string;
  kind:
    | 'command'
    | 'mcp_tool'
    | 'refresh_source'
    | 'set_data'
    | 'run_workflow'
    | 'run_scheduled_task'
    | 'trigger_event'
    | (string & {});
  label?: string;
  inputSchema?: UIJson;
  confirm?: boolean;
  config?: Record<string, UIJson>;
}

export interface UIView extends UIViewSummary {
  schemaVersion: number;
  markup?: string;
  spec: UISpec;
  data: Record<string, UIDataEntry>;
  sources: Record<string, UISource>;
  actions: Record<string, UIAction>;
}

export interface UICapabilities {
  version: number;
  schemaVersions: number[];
  surfaces: UIViewSurface[];
  realtime: boolean;
  maxNodes?: number;
  maxDepth?: number;
  componentTypes?: string[];
}

/** Ordered transcript parts use snake_case as the stable compatibility
 * envelope.  Wire adapters also accept camelCase/type aliases from early
 * beta gateways, but every component sees this canonical shape. */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; attachment: AttachmentRef }
  | { kind: 'ui_view'; view_id: string; revision: number };

export type RenderableAttachment = AttachmentRef;

export function isUIBinding(value: unknown): value is UIBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = (value as { $bind?: unknown }).$bind;
  return !!binding
    && typeof binding === 'object'
    && typeof (binding as { source?: unknown }).source === 'string'
    && typeof (binding as { path?: unknown }).path === 'string';
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Resolve a binding without eval/property-expression parsing. Invalid or
 * missing pointers return the binding's explicit fallback. */
export function resolveUIBinding(
  binding: UIBinding,
  data: Record<string, unknown>,
): unknown {
  // OA-UI's documented `{{data.cpu.percent}}` form compiles to source=data
  // plus /cpu/percent. Named data-source bindings (cpu:/percent) keep their
  // original direct lookup semantics. `state` is injected by the renderer
  // and never evaluates an expression.
  let current: unknown = binding.$bind.source === 'data'
    ? data
    : data[binding.$bind.source];
  const pointer = binding.$bind.path;
  if (pointer !== '') {
    if (!pointer.startsWith('/')) return binding.fallback;
    for (const raw of pointer.slice(1).split('/')) {
      const token = decodePointerToken(raw);
      if (Array.isArray(current)) {
        if (!/^\d+$/.test(token)) return binding.fallback;
        current = current[Number(token)];
      } else if (current && typeof current === 'object') {
        if (!Object.prototype.hasOwnProperty.call(current, token)) return binding.fallback;
        current = (current as Record<string, unknown>)[token];
      } else {
        return binding.fallback;
      }
      if (current === undefined) return binding.fallback;
    }
  }
  return current === undefined ? binding.fallback : current;
}

export function resolveUIProp(value: UIProp | undefined, data: Record<string, unknown>): unknown {
  return isUIBinding(value) ? resolveUIBinding(value, data) : value;
}

/** Custom View actions are fail-closed. Only the literal boolean emitted by
 * the authenticated gateway enables an invocation; truthy compatibility
 * values and a missing field remain read-only. */
export function canInvokeUIViewAction(
  canExecute: unknown,
  actionId: unknown,
): actionId is string {
  return canExecute === true
    && typeof actionId === 'string'
    && actionId.length > 0;
}

function finiteRevision(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Accept both the final ordered-parts envelope and the two beta aliases the
 * server used while the contract converged. Malformed entries are ignored. */
export function normalizeMessageParts(
  rawParts: unknown,
  fallbackText = '',
  fallbackAttachments: AttachmentRef[] = [],
): MessagePart[] {
  const out: MessagePart[] = [];
  const parts = Array.isArray(rawParts) ? rawParts : [];
  for (const raw of parts) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const kind = row.kind ?? row.type;
    if (kind === 'text' && typeof row.text === 'string') {
      out.push({ kind: 'text', text: row.text });
      continue;
    }
    if (kind === 'ui_view') {
      const id = row.view_id ?? row.viewId ?? row.id;
      const revision = finiteRevision(row.revision);
      if (typeof id === 'string' && id.length > 0 && revision > 0) {
        out.push({ kind: 'ui_view', view_id: id, revision });
      }
      continue;
    }
    if (kind === 'attachment' || kind === 'image' || kind === 'file' || kind === 'voice' || kind === 'video') {
      const nested = row.attachment && typeof row.attachment === 'object'
        ? row.attachment as Record<string, unknown>
        : row;
      const [attachment] = normalizeAttachmentRefs([{ ...nested, type: nested.type ?? nested.kind ?? kind }]);
      if (attachment) out.push({ kind: 'attachment', attachment });
    }
  }
  if (out.length > 0) return out;
  if (fallbackText) out.push({ kind: 'text', text: fallbackText });
  for (const attachment of fallbackAttachments) {
    out.push({ kind: 'attachment', attachment });
  }
  return out;
}

/** `parts` is ordered and authoritative. The short-lived `artifacts` beta
 * field was additive beside legacy text/attachments, so fill those carriers
 * only when the artifact list did not already include their equivalent. */
export function normalizeMessageContent(
  rawParts: unknown,
  rawArtifacts: unknown,
  fallbackText = '',
  fallbackAttachments: AttachmentRef[] = [],
): MessagePart[] | undefined {
  if (Array.isArray(rawParts)) {
    return normalizeMessageParts(rawParts, fallbackText, fallbackAttachments);
  }
  if (!Array.isArray(rawArtifacts)) return undefined;
  const artifacts = normalizeMessageParts(rawArtifacts);
  const out: MessagePart[] = [];
  if (fallbackText && !artifacts.some((part) => part.kind === 'text')) {
    out.push({ kind: 'text', text: fallbackText });
  }
  out.push(...artifacts);
  if (!artifacts.some((part) => part.kind === 'attachment')) {
    for (const attachment of fallbackAttachments) out.push({ kind: 'attachment', attachment });
  }
  return out;
}
