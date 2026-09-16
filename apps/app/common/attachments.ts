/**
 * Canonical attachment references shared by history, realtime chat and UI.
 *
 * New messages identify durable bytes with ``artifact_id``.  ``url`` is only
 * the authenticated read endpoint and must never be copied into ``path``:
 * ``path`` is retained solely for old gateways and local legacy responses.
 */

export type AttachmentKind = 'image' | 'file' | 'voice' | 'video';

export interface AttachmentRef {
  type: AttachmentKind;
  filename: string;
  artifact_id?: string;
  artifact_link_id?: string;
  url?: string;
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  caption?: string;
  /** @deprecated Legacy server-side/local path carrier. New CAS refs omit it. */
  path?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteSize(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function attachmentKind(value: unknown): AttachmentKind {
  return value === 'image' || value === 'voice' || value === 'video' ? value : 'file';
}

function safeContentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return undefined;
  // Attachment URLs are capabilities served by the authenticated gateway,
  // not arbitrary fetch targets. Absolute/remote URLs would let a persisted
  // beta payload make the renderer probe localhost or a tracking origin.
  if (/^\/api\/artifacts\/[^/?#]+\/content$/.test(value)) return value;
  if (/^\/api\/files\?(?:[^#]*)$/.test(value)) return value;
  return undefined;
}

/** Normalize final and early-beta field aliases without losing CAS metadata. */
export function normalizeAttachmentRefs(raw: unknown): AttachmentRef[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: AttachmentRef[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const filename = nonEmptyString(row.filename ?? row.name);
    if (!filename) continue;

    const artifactId = nonEmptyString(row.artifact_id ?? row.artifactId);
    const suppliedUrl = safeContentUrl(row.url);
    const legacyPath = nonEmptyString(row.path);
    // A CAS identity always wins over the compatibility path emitted by the
    // upload endpoint. Reconstructing url is safe and keeps rendering useful
    // when an early beta history row omitted that additive field.
    // An opaque CAS identity is authoritative. Never let an additive wire URL
    // override the authenticated endpoint derived from that id: otherwise a
    // stale or hostile payload could redirect an image/download request away
    // from the ACL-checked artifact route.
    const url = artifactId
      ? `/api/artifacts/${encodeURIComponent(artifactId)}/content`
      : suppliedUrl;
    const path = artifactId || url ? undefined : legacyPath;
    if (!artifactId && !url && !path) continue;

    const attachment: AttachmentRef = {
      type: attachmentKind(row.type ?? row.kind),
      filename,
    };
    if (artifactId) attachment.artifact_id = artifactId;
    const linkId = nonEmptyString(row.artifact_link_id ?? row.artifactLinkId);
    if (linkId) attachment.artifact_link_id = linkId;
    if (url) attachment.url = url;
    if (path) attachment.path = path;
    const mime = nonEmptyString(row.mime_type ?? row.mimeType ?? row.mime);
    if (mime) attachment.mime_type = mime;
    const size = finiteSize(row.size_bytes ?? row.sizeBytes ?? row.size);
    if (size !== undefined) attachment.size_bytes = size;
    const sha256 = nonEmptyString(row.sha256);
    if (sha256) attachment.sha256 = sha256;
    const caption = nonEmptyString(row.caption);
    if (caption) attachment.caption = caption;
    out.push(attachment);
  }
  return out;
}

/**
 * Produce the minimal structured refs sent back to the gateway. CAS-backed
 * attachments are sent by opaque id, never by their content URL or internal
 * storage path. Legacy path-only rows remain resendable against old agents.
 */
export function attachmentsForSend(raw: readonly AttachmentRef[] | undefined): AttachmentRef[] | undefined {
  const normalized = normalizeAttachmentRefs(raw);
  const refs = normalized.flatMap((attachment): AttachmentRef[] => {
    const base: AttachmentRef = {
      type: attachment.type,
      filename: attachment.filename,
    };
    if (attachment.mime_type) base.mime_type = attachment.mime_type;
    if (attachment.size_bytes !== undefined) base.size_bytes = attachment.size_bytes;
    if (attachment.sha256) base.sha256 = attachment.sha256;
    if (attachment.caption) base.caption = attachment.caption;
    if (attachment.artifact_id) {
      base.artifact_id = attachment.artifact_id;
      if (attachment.artifact_link_id) base.artifact_link_id = attachment.artifact_link_id;
      return [base];
    }
    if (attachment.path) {
      base.path = attachment.path;
      return [base];
    }
    // A URL without its artifact identity cannot be safely converted back to
    // a local path. Drop it instead of sending an ambiguous filesystem ref.
    return [];
  });
  return refs.length ? refs : undefined;
}

/** Relative/absolute read location consumed by the renderer and downloader. */
export function attachmentContentRef(attachment: AttachmentRef): string | undefined {
  return attachment.artifact_id
    ? `/api/artifacts/${encodeURIComponent(attachment.artifact_id)}/content`
    : attachment.url ?? attachment.path;
}

/** Stable identity for reconciliation and React list keys. */
export function attachmentKey(attachment: AttachmentRef): string {
  return attachment.artifact_link_id
    ?? attachment.artifact_id
    ?? attachment.url
    ?? attachment.path
    ?? `${attachment.type}:${attachment.filename}`;
}
