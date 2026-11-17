/**
 * Pure helpers behind the Models grid: how a model is reached (access),
 * what one line says about it right now (status), and the small catalogues
 * the edit dialog and the add wizard share.
 *
 * Kept free of React Native imports so the rules can be unit-tested in node
 * (see ``components/__tests__/model-helpers.test.cjs``).
 */

import type {
  InputModality, InputModalitiesSource, ModelEntry, ModelKind,
  ProviderAccounts, ProviderConfig, ProviderKind,
} from '../../../common/types';

export const KIND_LABELS: Record<ModelKind, string> = {
  llm: 'Text / multimodal',
  tts: 'Speech (TTS)',
  stt: 'Transcription (STT)',
  image: 'Images',
};

export const KIND_ORDER: ModelKind[] = ['llm', 'image', 'tts', 'stt'];

/** Image models are served by language-model providers. */
export function providerKindFor(kind: ModelKind): ProviderKind {
  return kind === 'image' ? 'llm' : kind;
}

export const MODALITIES: { key: InputModality; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'image', label: 'Images' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'file', label: 'Files' },
];

const MODALITY_KEYS = new Set<string>(MODALITIES.map((m) => m.key));

/** Known order, text first and always present. */
export function normalizeModalities(list: readonly string[] | null | undefined): InputModality[] {
  const set = new Set<string>(['text', ...(list ?? []).filter((m) => MODALITY_KEYS.has(m))]);
  return MODALITIES.map((m) => m.key).filter((k) => set.has(k));
}

export function sameModalities(a: readonly string[], b: readonly string[]): boolean {
  const x = normalizeModalities(a);
  const y = normalizeModalities(b);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

export interface ModelModalities {
  list: InputModality[];
  /** ``auto`` = the provider (or the family default) decides; refreshable. */
  mode: 'auto' | 'manual';
}

export function modelModalities(m: Pick<ModelEntry, 'metadata'>): ModelModalities {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.input_modalities;
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null;
  const source = meta.input_modalities_source as InputModalitiesSource | 'auto' | undefined;
  // A list stored without a source was chosen by a person (the server drops
  // the source when one is sent without it).
  const mode = source === 'manual' || (!source && list !== null) ? 'manual' : 'auto';
  return { list: normalizeModalities(list), mode };
}

// ── Access ───────────────────────────────────────────────────────────

export type Access = 'subscription' | 'local' | 'api';

export const ACCESS_LABELS: Record<Access, string> = {
  subscription: 'Subscription',
  local: 'Local',
  api: 'API',
};

/** Plain-http endpoints on this machine or a private network. */
export function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const match = /^http:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(url.trim());
  if (!match) return false;
  const host = match[1].toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  if (host.endsWith('.local') || host.endsWith('.svc.cluster.local')) return true;
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** /api/accounts entry for a provider row: by id, else by name. */
export function accountsFor(
  provider: Pick<ProviderConfig, 'id' | 'name'> | null | undefined,
  accounts: ProviderAccounts[] | null | undefined,
): ProviderAccounts | null {
  if (!provider || !accounts) return null;
  return accounts.find((a) => a.provider_id === provider.id)
    ?? accounts.find((a) => a.provider_id == null && a.provider === provider.name)
    ?? null;
}

export function isSubscription(entry: ProviderAccounts | null | undefined): boolean {
  return !!entry && entry.accounts.length > 0;
}

/** ``knownSubscription``: the provider reported accounts earlier. An
 *  unreachable proxy reports none, and must not turn into "API" meanwhile. */
export function accessFor(
  provider: Pick<ProviderConfig, 'base_url'> | null | undefined,
  entry: ProviderAccounts | null | undefined,
  knownSubscription = false,
): Access {
  if (isSubscription(entry) || knownSubscription) return 'subscription';
  if (isLocalUrl(provider?.base_url)) return 'local';
  return 'api';
}

// ── Status line ──────────────────────────────────────────────────────

export type StatusTone = 'danger' | 'warning' | 'muted' | 'primary' | 'normal';

export interface ModelStatus { label: string; tone: StatusTone }

function trimNumber(n: number): string {
  return String(Number(n.toFixed(4)));
}

export function priceLabel(m: Pick<ModelEntry, 'input_cost_per_million' | 'output_cost_per_million'>): string | null {
  const i = m.input_cost_per_million;
  const o = m.output_cost_per_million;
  if (!i && !o) return null;
  return `$${i ? trimNumber(i) : '0'}/$${o ? trimNumber(o) : '0'} per M`;
}

export function fallbackPriority(m: Pick<ModelEntry, 'metadata'>): number | null {
  const v = (m.metadata as Record<string, unknown> | undefined)?.fallback_priority;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** First free backup slot after every priority already in use. */
export function nextFallbackPriority(models: Pick<ModelEntry, 'metadata'>[]): number {
  let max = -1;
  for (const m of models) {
    const p = fallbackPriority(m);
    if (p !== null && p > max) max = p;
  }
  return max + 1;
}

export function voiceOf(m: Pick<ModelEntry, 'metadata'>): string | null {
  const v = (m.metadata as Record<string, unknown> | undefined)?.voice_id;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** What /api/accounts says about the provider, when it is worth a line. */
export function connectionStatus(
  entry: ProviderAccounts | null | undefined,
  access: Access,
): ModelStatus | null {
  const status = entry?.status;
  if (status === 'auth_expired') return { label: 'Sign-in expired', tone: 'danger' };
  if (status === 'rate_limited') return { label: 'Rate limited', tone: 'warning' };
  // A plain API vendor is "unreachable" to the accounts probe by design.
  if (status === 'unreachable' && access !== 'api') return { label: 'Not reachable', tone: 'warning' };
  return null;
}

/** One line per tile, most urgent fact first. Price has its own line. */
export function modelStatus(
  m: Pick<ModelEntry, 'kind' | 'enabled' | 'provider_enabled' | 'is_classifier' | 'metadata'
    | 'input_cost_per_million' | 'output_cost_per_million'>,
  provider: Pick<ProviderConfig, 'enabled'> | null | undefined,
  entry: ProviderAccounts | null | undefined,
  access: Access,
): ModelStatus | null {
  const connection = connectionStatus(entry, access);
  if (connection) return connection;
  const providerOff = m.provider_enabled === false || provider?.enabled === false;
  if (!m.enabled || providerOff) return { label: 'Off', tone: 'muted' };
  const kind = m.kind ?? 'llm';
  if (kind === 'llm') {
    if (m.is_classifier) return { label: 'Default', tone: 'primary' };
    const backup = fallbackPriority(m);
    if (backup !== null) return { label: `Backup ${backup}`, tone: 'normal' };
  }
  if (kind === 'tts') {
    const voice = voiceOf(m);
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    if (voice) {
      const fallback = meta.voice_id_source === 'default' ? ' (default)' : '';
      return { label: `Voice: ${voice}${fallback}`, tone: 'normal' };
    }
    return { label: 'Voice: provider default', tone: 'normal' };
  }
  return null;
}

// ── Vendors ──────────────────────────────────────────────────────────

/** Known API vendors per model type (the base URL is optional for these). */
export const VENDORS: Record<ModelKind, string[]> = {
  llm: [
    'anthropic', 'openai', 'google', 'zai', 'groq', 'mistral',
    'xai', 'deepseek', 'cerebras', 'openrouter',
  ],
  image: ['openai', 'google', 'xai', 'openrouter'],
  tts: ['openai', 'elevenlabs', 'azure', 'google'],
  stt: ['openai', 'deepgram', 'groq', 'azure'],
};

export const ALL_VENDORS = new Set(Object.values(VENDORS).flat());

// ── Sampling ─────────────────────────────────────────────────────────

// Sampling params the server reads off a model row. The whitelist is the
// server's, deliberately narrow: sampling only, never credentials or
// endpoints — a model row must not be able to redirect traffic.
//
// This matters beyond tuning. `extra_kwargs` is keyed by PROVIDER, so two
// models on one provider could never differ, and a provider that sends no
// temperature inherits the backend's own default in silence — llama.cpp's
// is 0.8, which is exactly the setting that turns "I can't verify that"
// into an invented answer. Leave a field empty to inherit; set it to pin.
export const SAMPLING_FIELDS: {
  key: string; label: string; placeholder: string; integer?: boolean;
}[] = [
  { key: 'temperature', label: 'Temperature', placeholder: 'e.g. 0.2' },
  { key: 'top_p', label: 'Top P', placeholder: 'e.g. 0.9' },
  { key: 'top_k', label: 'Top K', placeholder: 'e.g. 40', integer: true },
  { key: 'min_p', label: 'Min P', placeholder: 'e.g. 0.05' },
  { key: 'max_tokens', label: 'Max tokens', placeholder: 'e.g. 4096', integer: true },
  { key: 'presence_penalty', label: 'Presence penalty', placeholder: 'e.g. 0' },
  { key: 'frequency_penalty', label: 'Frequency penalty', placeholder: 'e.g. 0' },
  { key: 'repeat_penalty', label: 'Repeat penalty', placeholder: 'e.g. 1.1' },
  { key: 'seed', label: 'Seed', placeholder: 'e.g. 42', integer: true },
];

/** Raw strings so an empty field (inherit) differs from zero (pin). */
export function samplingDraft(metadata: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SAMPLING_FIELDS) {
    const v = metadata?.[f.key];
    out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Merge the draft into ``metadata``; returns an error message on bad input. */
export function applySampling(
  metadata: Record<string, unknown>,
  draft: Record<string, string>,
): string | null {
  for (const f of SAMPLING_FIELDS) {
    const raw = (draft[f.key] ?? '').trim();
    if (!raw) {
      delete metadata[f.key];
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return `${f.label} must be a number.`;
    metadata[f.key] = f.integer ? Math.round(parsed) : parsed;
  }
  return null;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(value.trim());
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
