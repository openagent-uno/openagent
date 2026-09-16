import { colors, font, radius } from '../theme';
/**
 * Lightweight markdown renderer — editorial prose style matched to the
 * refined Geist typography and paper-soft code blocks.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * [links](url), # headers, - bullet lists, > blockquotes,
 * ![alt](url) images, | tables |.
 */

import { memo, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Text, View, StyleSheet, Linking, Platform, Image, TouchableOpacity } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

// Side-effect import: the CSS ships KaTeX's font face declarations.
// Metro/Webpack pick this up at bundle time on web; on native it's a
// no-op since the import resolves to an empty module.
if (Platform.OS === 'web') {
  try { require('katex/dist/katex.min.css'); } catch { /* css optional in dev */ }
}

interface Props {
  text: string;
  /**
   * Hint that the text is mid-stream (token deltas still arriving). The
   * parser is O(n²) over total length when re-run on every delta, so
   * while streaming we render a fast plain-text fallback and switch to
   * full markdown once the canonical RESPONSE frame replaces the
   * bubble's text.
   */
  streaming?: boolean;
}

// Above this size, skip the O(n) block/inline parse and render plain
// selectable text — a multi-hundred-KB message would otherwise hitch the
// frame where streaming flips off.
const MAX_MARKDOWN_CHARS = 80000;

function MarkdownBase({ text, streaming: _streaming }: Props) {
  const blocks = useMemo(
    () => (text.length > MAX_MARKDOWN_CHARS ? null : parseBlocks(text)),
    [text],
  );
  if (!blocks) {
    return (
      <View>
        <Text style={styles.paragraph} selectable>
          {text}
        </Text>
      </View>
    );
  }
  return (
    <View>
      {blocks.map((block, i) => renderBlock(block, i))}
    </View>
  );
}

// memo so a parent re-render with the same text doesn't reparse — the
// parser is O(n) in text length and runs on every render otherwise.
export default memo(MarkdownBase);

type ListItem = { text: string; checked?: boolean | null };
type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'hr' }
  | { type: 'math'; tex: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Block math: ``$$...$$`` either inline on a single line, or as a
    // fenced multi-line region terminated by a closing ``$$``.
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('$$')) {
      const stripped = trimmedLine.slice(2);
      // Single-line shorthand: $$...$$ on the same line.
      if (stripped.endsWith('$$') && stripped.length >= 2) {
        const tex = stripped.slice(0, -2);
        if (tex.trim()) {
          blocks.push({ type: 'math', tex });
          i++;
          continue;
        }
      }
      // Multi-line: collect until the next $$ fence.
      const texLines: string[] = [stripped];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextTrim = next.trim();
        if (nextTrim.endsWith('$$')) {
          texLines.push(nextTrim.slice(0, -2));
          i++;
          break;
        }
        texLines.push(next);
        i++;
      }
      blocks.push({ type: 'math', tex: texLines.join('\n').trim() });
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    // Horizontal rule — three or more dashes/asterisks/underscores on
    // their own line (---, ***, ___, with optional spaces).
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Unordered list (`-`, `*`, `•`) with optional task-list checkbox
    // (`- [ ]` / `- [x]`).
    if (/^[\s]*[-*•]\s/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^[\s]*[-*•]\s/.test(lines[i])) {
        const raw = lines[i].replace(/^[\s]*[-*•]\s+/, '');
        const taskMatch = raw.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === 'x' });
        } else {
          items.push({ text: raw, checked: null });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list (`1.`, `2.`, …). Numbering value is ignored — we
    // re-number from 1 for display so messy `1. 1. 1.` outputs from
    // the model still look right.
    if (/^[\s]*\d+\.\s/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        items.push({ text: lines[i].replace(/^[\s]*\d+\.\s+/, ''), checked: null });
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    if (/^\|.+\|$/.test(line.trim()) && i + 1 < lines.length && /^\|([\s:-]+\|)+$/.test(lines[i + 1].trim())) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```')
      && !lines[i].match(/^#{1,6}\s/) && !lines[i].startsWith('> ')
      && !/^[\s]*[-*•]\s/.test(lines[i])
      && !/^[\s]*\d+\.\s/.test(lines[i])
      && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
      && !lines[i].trim().startsWith('$$')) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case 'code':
      return <CodeBlock key={key} lang={block.lang} code={block.text} />;
    case 'heading':
      return (
        <Text key={key} style={[
          styles.heading,
          block.level === 1 && styles.h1,
          block.level === 2 && styles.h2,
          block.level >= 3 && styles.h3,
        ]}>
          {renderInline(block.text)}
        </Text>
      );
    case 'quote':
      return (
        <View key={key} style={styles.blockquote}>
          <Text style={styles.quoteText}>{renderInline(block.text)}</Text>
        </View>
      );
    case 'list':
      return (
        <View key={key} style={styles.list}>
          {block.items.map((item, j) => {
            const isTask = item.checked !== null && item.checked !== undefined;
            const marker = block.ordered ? `${j + 1}.` : '—';
            return (
              <View key={j} style={styles.listItem}>
                {isTask ? (
                  <View
                    style={[
                      styles.taskBox,
                      item.checked ? styles.taskBoxChecked : null,
                    ]}
                  >
                    {item.checked && (
                      <Feather name="check" size={9} color={colors.textInverse} />
                    )}
                  </View>
                ) : (
                  <Text
                    style={[
                      styles.bullet,
                      block.ordered && styles.bulletOrdered,
                    ]}
                  >
                    {marker}
                  </Text>
                )}
                <Text
                  style={[
                    styles.listText,
                    isTask && item.checked && styles.taskTextDone,
                  ]}
                >
                  {renderInline(item.text)}
                </Text>
              </View>
            );
          })}
        </View>
      );
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'math':
      return <MathBlock key={key} tex={block.tex} />;
    case 'table':
      return (
        <View key={key} style={styles.table}>
          <View style={styles.tableRow}>
            {block.headers.map((h, j) => (
              <View key={j} style={[styles.tableCell, styles.tableHeaderCell]}>
                <Text style={styles.tableHeaderText}>{renderInline(h)}</Text>
              </View>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={styles.tableRow}>
              {row.map((cell, c) => (
                <View key={c} style={styles.tableCell}>
                  <Text style={styles.tableCellText}>{renderInline(cell)}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    case 'paragraph':
      return (
        <Text key={key} style={styles.paragraph}>
          {renderInline(block.text)}
        </Text>
      );
  }
}

// ── Math (KaTeX) — lazy-loaded so the ~270KB module isn't pulled into
//    the first paint of a chat that has no math in sight. The renderer
//    is sync (KaTeX itself is sync), so once the module resolves we
//    just call ``renderToString`` and drop it into innerHTML. Native
//    falls back to plain selectable text — the symbols still convey
//    the meaning, just unstyled.
let katexPromise: Promise<any> | null = null;
function loadKatex(): Promise<any> {
  if (katexPromise) return katexPromise;
  katexPromise = (async () => {
    try {
      const mod: any = await import('katex');
      return mod.default ?? mod;
    } catch (e) {
      console.warn('[markdown] KaTeX failed to load; math will render as plain text:', e);
      return null;
    }
  })();
  return katexPromise;
}

function MathBlock({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    (async () => {
      const k = await loadKatex();
      if (cancelled || !k) return;
      try {
        const rendered = k.renderToString(tex, {
          displayMode: true,
          throwOnError: false,
          errorColor: '#FF6B7A',
        });
        if (!cancelled) setHtml(rendered);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [tex]);
  if (Platform.OS === 'web' && html) {
    // @ts-ignore — innerHTML on a web div via RN-Web
    return <div className="oa-katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <View style={styles.mathFallback}>
      <Text style={styles.mathFallbackText} selectable>{tex}</Text>
    </View>
  );
}

function MathInline({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    (async () => {
      const k = await loadKatex();
      if (cancelled || !k) return;
      try {
        const rendered = k.renderToString(tex, {
          displayMode: false,
          throwOnError: false,
          errorColor: '#FF6B7A',
        });
        if (!cancelled) setHtml(rendered);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [tex]);
  if (Platform.OS === 'web' && html) {
    // @ts-ignore — inline span via RN-Web
    return <span className="oa-katex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <Text style={styles.mathFallbackInline} selectable>{tex}</Text>;
}

// ── Code block with copy button + lazy-loaded Shiki syntax highlight ──

// Languages Shiki can resolve at runtime. The bundle ships only these
// to keep first-paint small; anything else falls back to plain text.
const SHIKI_LANGS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'sh', 'zsh',
  'python', 'py', 'rust', 'go', 'c', 'cpp', 'java', 'kotlin', 'swift',
  'sql', 'yaml', 'yml', 'toml', 'md', 'markdown', 'html', 'css', 'scss',
  'http', 'dockerfile', 'diff', 'graphql', 'lua', 'ruby', 'php',
]);

// Lazy-loaded Shiki highlighter singleton — first code block in the
// app pays the load cost (~200KB), subsequent blocks reuse the cached
// promise. We import only the bundle we need (`shiki/bundle/web`) so
// node-only loaders don't bloat the renderer.
let highlighterPromise: Promise<any> | null = null;
function loadHighlighter(): Promise<any> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    try {
      const shiki: any = await import('shiki');
      return await shiki.createHighlighter({
        themes: ['github-dark'],
        langs: Array.from(SHIKI_LANGS),
      });
    } catch (e) {
      console.warn('[markdown] Shiki failed to load, falling back to plain code blocks:', e);
      return null;
    }
  })();
  return highlighterPromise;
}

function normaliseLang(raw: string): string | null {
  const l = (raw || '').toLowerCase().trim();
  if (!l) return null;
  if (SHIKI_LANGS.has(l)) return l;
  // Common aliases the model emits.
  if (l === 'typescript') return 'ts';
  if (l === 'javascript') return 'js';
  if (l === 'python3') return 'python';
  if (l === 'rs') return 'rust';
  return null;
}

// Cache highlighted HTML keyed on lang+code so re-mounts (MessageList
// re-renders, reconcileSession swaps) and repeated identical blocks don't
// re-run the (synchronous, non-trivial) Shiki highlight. Bounded to avoid
// unbounded growth in a very long session.
const highlightCache = new Map<string, string>();
const HIGHLIGHT_CACHE_MAX = 300;
// Skip syntax highlighting above this size — a pathological multi-thousand
// line block would otherwise block the main thread when it lands.
const MAX_HIGHLIGHT_CHARS = 20000;

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const resolvedLang = normaliseLang(lang);

  // Lazily highlight when the language is supported. On web only —
  // Shiki uses WASM/text loaders that don't exist on native RN.
  useEffect(() => {
    if (Platform.OS !== 'web' || !resolvedLang || code.length > MAX_HIGHLIGHT_CHARS) {
      setHighlightedHtml(null);
      return;
    }
    const key = `${resolvedLang} ${code}`;
    const cached = highlightCache.get(key);
    if (cached !== undefined) {
      setHighlightedHtml(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      const hi = await loadHighlighter();
      if (cancelled || !hi) return;
      try {
        const html = hi.codeToHtml(code, {
          lang: resolvedLang,
          theme: 'github-dark',
        });
        if (highlightCache.size > HIGHLIGHT_CACHE_MAX) highlightCache.clear();
        highlightCache.set(key, html);
        if (!cancelled) setHighlightedHtml(html);
      } catch (e) {
        // Unknown language → just leave plain text.
        if (!cancelled) setHighlightedHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedLang, code]);

  const doCopy = async () => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error('Copy code failed:', e);
    }
  };
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{lang || 'code'}</Text>
        <TouchableOpacity
          style={styles.codeCopyBtn}
          // @ts-ignore — web hover/press affordance
          {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
          onPress={doCopy}
          accessibilityLabel={copied ? 'Copied' : 'Copy code'}
        >
          <Feather
            name={copied ? 'check' : 'copy'}
            size={10}
            color={copied ? colors.success : colors.textMuted}
          />
          <Text
            style={[
              styles.codeCopyText,
              copied && { color: colors.success },
            ]}
          >
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </TouchableOpacity>
      </View>
      {Platform.OS === 'web' && highlightedHtml ? (
        // Shiki emits semantic <pre><code> with inline color styles.
        // We render it via dangerouslySetInnerHTML and scope the
        // typography with a CSS override so it matches our font stack.
        // @ts-ignore — div is a valid web element via RN-Web.
        <div
          className="oa-shiki"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <Text style={styles.codeText} selectable>{code}</Text>
      )}
    </View>
  );
}

function renderInline(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  // Capture groups (order matters — `match[N]` indices feed the
  // switch below; bold-italic must precede bold and italic so the
  // longer token wins):
  //   1-2  bold-italic ***x***
  //   3-4  bold        **x**
  //   5-6  italic      *x*
  //   7-8  inline      `x`
  //   9-10-11 image    ![alt](url)
  //   12-13-14 link    [t](url)
  //   15-16 strike     ~~x~~
  //   17-18 math       $x$    (inline KaTeX; ``$x x x$`` with non-newline body)
  const re = /(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(~~(.+?)~~)|(\$([^$\n]+?)\$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    if (match[2]) {
      // bold-italic ***x***
      parts.push(<Text key={`bi${idx++}`} style={[styles.bold, styles.italic]}>{match[2]}</Text>);
    } else if (match[4]) {
      parts.push(<Text key={`b${idx++}`} style={styles.bold}>{match[4]}</Text>);
    } else if (match[6]) {
      parts.push(<Text key={`i${idx++}`} style={styles.italic}>{match[6]}</Text>);
    } else if (match[8]) {
      parts.push(<Text key={`c${idx++}`} style={styles.inlineCode}>{match[8]}</Text>);
    } else if (match[10] !== undefined && match[11]) {
      const imgUrl = match[11];
      if (/^https?:\/\//i.test(imgUrl)) {
        parts.push(
          <Image
            key={`img${idx++}`}
            source={{ uri: imgUrl }}
            style={styles.inlineImage}
            resizeMode="contain"
          />
        );
      } else {
        parts.push(match[0]);
      }
    } else if (match[13] && match[14]) {
      parts.push(
        <Text
          key={`l${idx++}`}
          style={styles.link}
          onPress={() => { void openSafeMarkdownLink(match![14]); }}
        >
          {match[13]}
        </Text>
      );
    } else if (match[16]) {
      parts.push(
        <Text key={`s${idx++}`} style={styles.strike}>{match[16]}</Text>,
      );
    } else if (match[18]) {
      parts.push(<MathInline key={`m${idx++}`} tex={match[18]} />);
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts.length ? parts : [text];
}

async function openSafeMarkdownLink(raw: string): Promise<void> {
  if (!raw || raw.length > 8192 || Array.from(raw).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) return;
  try {
    const parsed = new URL(raw);
    const safe = parsed.protocol === 'mailto:'
      ? !parsed.username && !parsed.password
      : (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && !!parsed.hostname && !parsed.username && !parsed.password;
    if (safe) await Linking.openURL(parsed.toString());
  } catch {
    // Invalid and relative URLs are inert in model-authored markdown.
  }
}

const styles = StyleSheet.create({
  paragraph: {
    fontSize: 14, lineHeight: 23, color: colors.text,
    marginBottom: 10, fontFamily: font.sans,
  },
  heading: {
    fontWeight: '600', color: colors.text,
    marginBottom: 8, marginTop: 8,
    fontFamily: font.display,
    letterSpacing: -0.3,
  },
  h1: { fontSize: 22, fontWeight: '600' },
  h2: { fontSize: 18, fontWeight: '600' },
  h3: { fontSize: 15, fontWeight: '600' },
  bold: { fontWeight: '600' },
  italic: { fontStyle: 'italic' },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: 12.5,
    backgroundColor: colors.codeBg,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.xs,
    color: colors.primary,
  },
  link: {
    color: colors.primary,
    textDecorationLine: 'underline',
    // @ts-ignore
    textDecorationStyle: 'dotted',
  },
  codeBlock: {
    backgroundColor: colors.codeBg,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.codeBorder,
    marginVertical: 8,
    overflow: 'hidden',
  },
  codeHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 5,
    borderBottomWidth: 1, borderBottomColor: colors.codeBorder,
    backgroundColor: Platform.OS === 'web' ? 'transparent' : colors.codeBg,
  },
  codeLang: {
    flex: 1,
    fontSize: 10, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    fontFamily: font.mono, fontWeight: '500',
  },
  codeCopyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.xs,
  },
  codeCopyText: {
    fontSize: 10, color: colors.textMuted, fontFamily: font.mono,
    textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '500',
  },
  codeText: {
    fontFamily: font.mono,
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.codeText,
    padding: 12,
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.primary,
    paddingLeft: 14,
    marginVertical: 8,
    opacity: 0.9,
  },
  quoteText: {
    fontSize: 14, lineHeight: 22, color: colors.textSecondary,
    fontStyle: 'italic',
    fontFamily: font.sans,
  },
  list: { marginVertical: 6 },
  listItem: {
    flexDirection: 'row', marginBottom: 4, paddingLeft: 2,
  },
  bullet: {
    color: colors.primary, marginRight: 10, fontSize: 14,
    fontWeight: '600',
    minWidth: 16, textAlign: 'right',
  },
  bulletOrdered: {
    color: colors.textSecondary, fontFamily: font.mono,
    fontSize: 12.5, marginTop: 3, minWidth: 22,
  },
  listText: {
    flex: 1, fontSize: 14, lineHeight: 22, color: colors.text,
    fontFamily: font.sans,
  },
  taskBox: {
    width: 14, height: 14, borderRadius: 3,
    borderWidth: 1.5, borderColor: colors.textMuted,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 8, marginTop: 4,
  },
  taskBoxChecked: {
    backgroundColor: colors.primary, borderColor: colors.primary,
  },
  taskTextDone: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  strike: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  hr: {
    height: 1, backgroundColor: colors.border,
    marginVertical: 14, marginHorizontal: 4,
  },
  mathFallback: {
    paddingVertical: 6, paddingHorizontal: 10,
    marginVertical: 8, borderRadius: radius.sm,
    backgroundColor: colors.codeBg,
  },
  mathFallbackText: {
    color: colors.text, fontFamily: font.mono, fontSize: 13,
  },
  mathFallbackInline: {
    color: colors.text, fontFamily: font.mono, fontSize: 13,
  },
  inlineImage: {
    width: '100%',
    maxWidth: 480,
    height: 280,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginVertical: 8,
    backgroundColor: colors.codeBg,
  },
  table: {
    marginVertical: 8,
    borderWidth: 1,
    borderColor: colors.codeBorder,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.codeBorder,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  tableHeaderCell: {
    backgroundColor: colors.codeBg,
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableCellText: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.text,
    fontFamily: font.sans,
  },
});
