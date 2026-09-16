/**
 * Attachments — renders the files an agent (or a user) attaches to a message.
 *
 * Vision §2/§16: files are first-class in the stream and restored with the
 * transcript. New responses carry a durable ``AttachmentRef`` with an opaque
 * ``artifact_id`` and authenticated ``url``; path-only rows remain readable
 * during beta compatibility. This layer turns that into UI:
 *
 *   • image / video → shown FULL-WIDTH inline in the session column.
 *   • voice          → a full-width inline audio player.
 *   • everything else → a compact, downloadable file badge.
 *
 * Every attachment is downloadable and openable in a full-screen PREVIEW
 * (lightbox) — image zoom, video/audio playback, PDF, or text — regardless of
 * type. Rich playback/preview is web-first: the desktop app (Electron) and web
 * build run under React Native Web, where a real ``<video>`` / ``<audio>`` /
 * ``<iframe>`` is available and free, so we don't pull in a native media
 * dependency. On pure-native mobile the media gracefully falls back to a
 * downloadable badge (matching the existing web-only ``downloadFile`` helper).
 */

import { createElement, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Image, Modal, Pressable,
  ActivityIndicator, ScrollView, useWindowDimensions,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { Attachment } from '../../common/types';
import { attachmentKey } from '../../common/attachments';
import { attachmentUrl, downloadAttachment } from '../services/api';
import { colors, font, radius } from '../theme';

const isWeb = Platform.OS === 'web';

// ── Type helpers ─────────────────────────────────────────────────────

/** Lower-case extension (no dot) of a filename, or ''. */
function extOf(filename: string): string {
  const base = filename.split('/').pop() || filename;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go',
  'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini',
  'env', 'diff', 'patch', 'svg',
]);

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

/** Which viewer the preview lightbox should use for an attachment. */
function previewKindFor(att: Attachment): PreviewKind {
  if (att.type === 'image') return 'image';
  if (att.type === 'video') return 'video';
  if (att.type === 'voice') return 'audio';
  const ext = extOf(att.filename);
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'none';
}

/** Feather icon for a file badge, by type/extension. */
function iconFor(att: Attachment): string {
  if (att.type === 'image') return 'image';
  if (att.type === 'video') return 'film';
  if (att.type === 'voice') return 'mic';
  const ext = extOf(att.filename);
  if (ext === 'pdf') return 'file-text';
  if (TEXT_EXTS.has(ext)) return 'file-text';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return 'archive';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'grid';
  return 'file';
}

/** Trigger a browser download (web/Electron only — no native FS dep today). */
async function doDownload(att: Attachment) {
  if (!isWeb) return;
  try {
    await downloadAttachment(att);
  } catch (e) {
    console.error('Download failed:', e);
  }
}

// ── Public entry ─────────────────────────────────────────────────────

export interface AttachmentBlockProps {
  attachments?: Attachment[];
  /** Show download affordances (assistant messages). User echoes omit them. */
  downloadable?: boolean;
}

/**
 * Render a message's attachments: full-width media (image/video/voice) stacked
 * first, then a wrap-row of file badges. Owns the single shared preview modal.
 */
export default function AttachmentBlock({ attachments, downloadable = false }: AttachmentBlockProps) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!attachments || attachments.length === 0) return null;

  const isMedia = (a: Attachment) => a.type === 'image' || a.type === 'video' || a.type === 'voice';
  const media = attachments.filter(isMedia);
  const files = attachments.filter((a) => !isMedia(a));

  return (
    <View style={styles.block}>
      {media.map((att, i) => (
        <MediaItem
          key={`m-${attachmentKey(att)}-${i}`}
          attachment={att}
          downloadable={downloadable}
          onPreview={() => setPreview(att)}
        />
      ))}
      {files.length > 0 && (
        <View style={styles.fileRow}>
          {files.map((att, i) => (
            <FileBadge
              key={`f-${attachmentKey(att)}-${i}`}
              attachment={att}
              downloadable={downloadable}
              onPreview={() => setPreview(att)}
            />
          ))}
        </View>
      )}
      {preview && <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />}
    </View>
  );
}

// ── Inline media ─────────────────────────────────────────────────────

function MediaItem({ attachment, downloadable, onPreview }: {
  attachment: Attachment; downloadable: boolean; onPreview: () => void;
}) {
  if (attachment.type === 'image') {
    return <MediaImage attachment={attachment} downloadable={downloadable} onPreview={onPreview} />;
  }
  if (attachment.type === 'video' && isWeb) {
    return <MediaVideo attachment={attachment} downloadable={downloadable} />;
  }
  if (attachment.type === 'voice' && isWeb) {
    return <MediaAudio attachment={attachment} downloadable={downloadable} />;
  }
  // Native (no player) → downloadable badge that still opens the preview.
  return (
    <View style={styles.fileRow}>
      <FileBadge attachment={attachment} downloadable={downloadable} onPreview={onPreview} />
    </View>
  );
}

/** A caption row shown under inline media: filename + optional download. */
function MediaFooter({ attachment, downloadable }: { attachment: Attachment; downloadable: boolean }) {
  return (
    <View style={styles.mediaFooter}>
      <Text style={styles.mediaName} numberOfLines={1}>{attachment.filename}</Text>
      {downloadable && isWeb && (
        <TouchableOpacity
          onPress={() => doDownload(attachment)}
          accessibilityLabel={`Download ${attachment.filename}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="download" size={13} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function MediaImage({ attachment, downloadable, onPreview }: {
  attachment: Attachment; downloadable: boolean; onPreview: () => void;
}) {
  const uri = attachmentUrl(attachment);
  // Full-width, aspect-correct. Image.getSize resolves natural dimensions on
  // both native and RNW (via a DOM Image); until then a placeholder height
  // holds the layout. maxHeight caps very tall images so one attachment can't
  // dominate the whole viewport.
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    Image.getSize(uri, (w, h) => { if (live && w && h) setRatio(w / h); }, () => {});
    return () => { live = false; };
  }, [uri]);

  return (
    <View style={styles.mediaWrap}>
      <TouchableOpacity activeOpacity={0.9} onPress={onPreview} accessibilityLabel={`Preview ${attachment.filename}`}>
        <Image
          source={{ uri }}
          style={[styles.media, ratio ? { aspectRatio: ratio } : { height: 240 }]}
          resizeMode="contain"
        />
      </TouchableOpacity>
      <MediaFooter attachment={attachment} downloadable={downloadable} />
    </View>
  );
}

function MediaVideo({ attachment, downloadable }: { attachment: Attachment; downloadable: boolean }) {
  // Real <video> via React DOM (RNW/Electron). Content-Disposition:attachment
  // on the content endpoint is ignored for a media subresource, so it streams inline.
  const el = createElement('video', {
    src: attachmentUrl(attachment),
    controls: true,
    preload: 'metadata',
    playsInline: true,
    style: {
      width: '100%', maxHeight: 480, borderRadius: radius.md,
      background: '#000', display: 'block',
    },
  });
  return (
    <View style={styles.mediaWrap}>
      {el}
      <MediaFooter attachment={attachment} downloadable={downloadable} />
    </View>
  );
}

function MediaAudio({ attachment, downloadable }: { attachment: Attachment; downloadable: boolean }) {
  const el = createElement('audio', {
    src: attachmentUrl(attachment),
    controls: true,
    preload: 'metadata',
    style: { width: '100%', display: 'block' },
  });
  return (
    <View style={styles.audioWrap}>
      <View style={styles.audioHead}>
        <Feather name="mic" size={12} color={colors.textSecondary} />
        <Text style={styles.mediaName} numberOfLines={1}>{attachment.filename}</Text>
        {downloadable && isWeb && (
          <TouchableOpacity onPress={() => doDownload(attachment)} accessibilityLabel="Download voice note">
            <Feather name="download" size={13} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>
      {el}
    </View>
  );
}

// ── File badge ───────────────────────────────────────────────────────

function FileBadge({ attachment, downloadable, onPreview }: {
  attachment: Attachment; downloadable: boolean; onPreview: () => void;
}) {
  const ext = extOf(attachment.filename);
  return (
    <View style={styles.badge}>
      <TouchableOpacity
        style={styles.badgeMain}
        onPress={onPreview}
        accessibilityLabel={`Preview ${attachment.filename}`}
      >
        <Feather name={iconFor(attachment) as any} size={13} color={colors.textSecondary} />
        <Text style={styles.badgeText} numberOfLines={1}>{attachment.filename}</Text>
        {ext ? <Text style={styles.badgeExt}>{ext.toUpperCase()}</Text> : null}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.badgeAction}
        onPress={onPreview}
        accessibilityLabel="Open preview"
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      >
        <Feather name="eye" size={13} color={colors.textMuted} />
      </TouchableOpacity>
      {downloadable && isWeb && (
        <TouchableOpacity
          style={styles.badgeAction}
          onPress={() => doDownload(attachment)}
          accessibilityLabel={`Download ${attachment.filename}`}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
        >
          <Feather name="download" size={13} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Preview lightbox ─────────────────────────────────────────────────

function AttachmentPreview({ attachment, onClose }: {
  attachment: Attachment | null; onClose: () => void;
}) {
  // Concrete panel height from the live viewport (px on RNW + native) — avoids
  // relying on percentage/viewport-unit heights, which RNW's StyleSheet does
  // not resolve reliably. The body then flexes to fill and viewers use 100%.
  const { height: winH } = useWindowDimensions();
  const panelH = Math.max(280, Math.min(Math.round(winH * 0.86), winH - 64));
  return (
    <Modal
      animationType="fade"
      transparent
      visible={!!attachment}
      onRequestClose={onClose}
    >
      <View style={styles.previewOverlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close preview"
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        />
        {attachment && (
          <View style={[styles.previewPanel, { height: panelH }]}>
            <View style={styles.previewHead}>
              <Feather name={iconFor(attachment) as any} size={14} color={colors.textSecondary} />
              <Text style={styles.previewName} numberOfLines={1}>{attachment.filename}</Text>
              {isWeb && (
                <TouchableOpacity
                  style={styles.previewHeadBtn}
                  onPress={() => doDownload(attachment)}
                  accessibilityLabel="Download"
                >
                  <Feather name="download" size={15} color={colors.text} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.previewHeadBtn}
                onPress={onClose}
                accessibilityLabel="Close"
              >
                <Feather name="x" size={17} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={styles.previewBody}>
              <PreviewViewer attachment={attachment} />
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function PreviewViewer({ attachment }: { attachment: Attachment }) {
  const kind = previewKindFor(attachment);
  const uri = attachmentUrl(attachment);

  // Image — RN Image on every platform (contain to fit the panel).
  if (kind === 'image') {
    return <Image source={{ uri }} style={styles.previewImage} resizeMode="contain" />;
  }

  // Rich media / documents are web-only; native shows a download prompt.
  if (!isWeb) return <PreviewFallback attachment={attachment} note="Preview isn't available on this platform yet." />;

  if (kind === 'video') {
    return createElement('video', {
      src: uri, controls: true, autoPlay: true, playsInline: true,
      style: { width: '100%', height: '100%', maxHeight: '100%', background: '#000', objectFit: 'contain' },
    });
  }
  if (kind === 'audio') {
    return (
      <View style={styles.previewAudioWrap}>
        {createElement('audio', { src: uri, controls: true, autoPlay: true, style: { width: '100%' } })}
      </View>
    );
  }
  if (kind === 'pdf') return <PdfPreview uri={uri} filename={attachment.filename} />;
  if (kind === 'text') return <TextPreview uri={uri} />;
  return <PreviewFallback attachment={attachment} note="No inline preview for this file type." />;
}

/** PDF via a blob URL so ``Content-Disposition: attachment`` doesn't force a
 *  download inside the <iframe> (a direct src to /api/files would). */
function PdfPreview({ uri, filename }: { uri: string; filename: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    let created: string | null = null;
    fetch(uri)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (!live) return; created = URL.createObjectURL(b); setBlobUrl(created); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [uri]);
  if (err) return <PreviewMessage text="Couldn't load this PDF." />;
  if (!blobUrl) return <Loading />;
  return createElement('iframe', {
    src: blobUrl, title: filename,
    style: { width: '100%', height: '100%', border: 'none', borderRadius: radius.sm, background: '#fff' },
  });
}

/** Plain-text / code preview — fetched and shown in a scrollable mono block. */
function TextPreview({ uri }: { uri: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(uri)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((t) => { if (live) setText(t.length > 200_000 ? t.slice(0, 200_000) + '\n…(truncated)' : t); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [uri]);
  if (err) return <PreviewMessage text="Couldn't load this file." />;
  if (text === null) return <Loading />;
  return (
    <ScrollView style={styles.textScroll} contentContainerStyle={styles.textContent}>
      <Text style={styles.textBody} selectable>{text}</Text>
    </ScrollView>
  );
}

function PreviewFallback({ attachment, note }: { attachment: Attachment; note: string }) {
  return (
    <View style={styles.previewMsg}>
      <Feather name={iconFor(attachment) as any} size={40} color={colors.textMuted} />
      <Text style={styles.previewMsgText}>{note}</Text>
      {isWeb && (
        <TouchableOpacity style={styles.previewDownloadBtn} onPress={() => doDownload(attachment)}>
          <Feather name="download" size={14} color={colors.text} />
          <Text style={styles.previewDownloadText}>Download</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function PreviewMessage({ text }: { text: string }) {
  return <View style={styles.previewMsg}><Text style={styles.previewMsgText}>{text}</Text></View>;
}

function Loading() {
  return <View style={styles.previewMsg}><ActivityIndicator color={colors.primary} /></View>;
}

// ── Styles ───────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  block: { marginTop: 8, gap: 8 },

  // Inline media
  mediaWrap: { marginTop: 4, marginBottom: 2 },
  media: {
    width: '100%',
    maxHeight: 480,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.codeBg,
  },
  mediaFooter: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 4, paddingHorizontal: 2,
  },
  mediaName: { flex: 1, color: colors.textMuted, fontSize: 11, fontFamily: font.mono },
  audioWrap: {
    marginTop: 4, gap: 6, padding: 8,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  audioHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // File badges
  fileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 5,
    borderWidth: 1, borderColor: colors.border,
    maxWidth: 300,
  },
  badgeMain: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  badgeText: { color: colors.textSecondary, fontSize: 11, fontWeight: '500', flexShrink: 1 },
  badgeExt: {
    color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5,
    fontFamily: font.mono,
  },
  badgeAction: { paddingHorizontal: 2 },

  // Preview lightbox
  previewOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24,
    backgroundColor: 'rgba(2, 4, 10, 0.82)',
  },
  previewPanel: {
    // Height is injected as a concrete px value at render (see AttachmentPreview)
    // so the body/viewers get a definite box to fill on both RNW and native.
    width: '92%', maxWidth: 960,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceElevated ?? colors.surface,
    overflow: 'hidden',
  },
  previewHead: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  previewName: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  previewHeadBtn: { padding: 4 },
  previewBody: {
    // Fills the panel below the header; viewers use flex / 100% to fit.
    flex: 1, padding: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  previewImage: { width: '100%', height: '100%' },
  previewAudioWrap: { width: '100%', paddingHorizontal: 8 },

  textScroll: { width: '100%', height: '100%', alignSelf: 'stretch' },
  textContent: { padding: 12 },
  textBody: { color: colors.codeText ?? colors.text, fontSize: 12, lineHeight: 18, fontFamily: font.mono },

  previewMsg: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  previewMsgText: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  previewDownloadBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  previewDownloadText: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
