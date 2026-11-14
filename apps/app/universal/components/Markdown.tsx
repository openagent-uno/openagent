import { colors, font, radius } from '../theme';
/**
 * Lightweight markdown renderer — editorial prose style matched to the
 * refined Geist typography and paper-soft code blocks.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * [links](url), # headers, - bullet lists, > blockquotes,
 * ![alt](url) images, | tables |.
 */

import { memo, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Text, View, StyleSheet, Linking, Platform, Image, TouchableOpacity, ScrollView, Clipboard } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { inlineMarkdownPattern } from '../../common/markdown-inline';

// Side-effect import: the CSS ships KaTeX's font face declarations.
// Metro/Webpack pick this up at bundle time on web; on native it's a
// no-op since the import resolves to an empty module.
if (Platform.OS === 'web') {
  try { require('katex/dist/katex.min.css'); } catch { /* css optional in dev */ }
}

interface Props {
  text: string;
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

type ListItem = { text: string; checked?: boolean; depth: number; number?: number };
type Alignment = 'left' | 'center' | 'right';
const listMarker = /^([ 	]*)([-+*•]|[0-9]{1,9}[.)])[ 	]+(.*)$/;
type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; items: ListItem[] }
  | { type: 'hr' }
  | { type: 'math'; tex: string }
  | { type: 'table'; headers: string[]; rows: string[][]; alignment: Alignment[] };

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

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const lang = fence[2].trim().split(/\s+/)[0] || '';
      const codeLines: string[] = [];
      i++;
      const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      while (i < lines.length && !close.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
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

    if (listMarker.test(line)) {
      const items: ListItem[] = [];
      const depths: number[] = [];
      let entry: RegExpMatchArray | null;
      while (i < lines.length && (entry = lines[i].match(listMarker))) {
        const indent = entry[1].replace(/\t/g, '    ').length;
        while (depths.length && depths[depths.length - 1] > indent) depths.pop();
        if (depths[depths.length - 1] !== indent) depths.push(indent);
        const task = entry[3].match(/^\[([ xX])\](?:\s+(.*)|$)/);
        items.push({
          text: task ? task[2] ?? '' : entry[3],
          checked: task ? task[1].toLowerCase() === 'x' : undefined,
          number: /^\d/.test(entry[2]) ? Number.parseInt(entry[2], 10) : undefined,
          depth: Math.min(5, depths.length - 1),
        });
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    const table = i + 1 < lines.length ? tableStart(line, lines[i + 1]) : null;
    if (table) {
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && rows.length < 512) rows.push(parseTableRow(lines[i++]));
      blocks.push({ type: 'table', ...table, rows });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^ {0,3}(`{3,}|~{3,})/.test(lines[i])
      && !/^#{1,6}\s/.test(lines[i]) && !lines[i].startsWith('> ')
      && !listMarker.test(lines[i])
      && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
      && !lines[i].trim().startsWith('$$')
      && !(i + 1 < lines.length && tableStart(lines[i], lines[i + 1]))) {
      const previous = paraLines.length - 1;
      paraLines[previous] += / {2,}$/.test(paraLines[previous]) ? '\n' : ' ';
      paraLines.push(lines[i++]);
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('') });
  }
  return blocks;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

function tableStart(first: string, second: string) {
  if (!first.includes('|') || !second.includes('-')) return null;
  const headers = parseTableRow(first);
  const divider = parseTableRow(second);
  if (headers.length > 32 || headers.length !== divider.length || !divider.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return { headers, alignment: divider.map((cell): Alignment =>
    cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left') };
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
            const marker = item.number == null ? (item.depth % 2 ? '◦' : '•') : item.number + '.';
            return (
              <View key={j} style={[styles.listItem, { marginLeft: item.depth * 16 }]}>
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
                      item.number != null && styles.bulletOrdered,
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
        <ScrollView horizontal key={key} style={styles.tableScroll}
          contentContainerStyle={{ minWidth: '100%' }} accessibilityLabel="Markdown table">
          <View style={[styles.table, { minWidth: block.headers.length * 104 }]}>
          <View style={styles.tableRow}>
            {block.headers.map((h, j) => (
              <View key={j} style={[styles.tableCell, styles.tableHeaderCell]}>
                <Text style={[styles.tableHeaderText, { textAlign: block.alignment[j] }]} selectable>{renderInline(h)}</Text>
              </View>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={styles.tableRow}>
              {block.headers.map((_, c) => (
                <View key={c} style={styles.tableCell}>
                  <Text style={[styles.tableCellText, { textAlign: block.alignment[c] }]} selectable>{renderInline(row[c] ?? '')}</Text>
                </View>
              ))}
            </View>
          ))}
          </View>
        </ScrollView>
      );
    case 'paragraph':
      return (
        <Text key={key} style={styles.paragraph} selectable>
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

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
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
    try {
      if (Platform.OS === 'web') await navigator.clipboard.writeText(code);
      else Clipboard.setString(code);
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
          accessibilityRole="button"
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
        <ScrollView horizontal><Text style={styles.codeText} selectable>{code}</Text></ScrollView>
      )}
    </View>
  );
}

function safeMarkdownUrl(raw: string, image = false): string | undefined {
  if (!raw || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'mailto:' && !image && url.pathname) return url.toString();
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return url.toString();
  } catch { /* relative and malformed URLs remain plain text */ }
}

const hexColor = /^#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})$/i;
function colorText(value: string, key: string, code = false) {
  return <Text key={key} style={code ? styles.inlineCode : undefined}>
    {hexColor.test(value)
      ? <><Text accessibilityLabel={`Color ${value}`} style={[styles.colorSwatch, { color: value }]}>■</Text>{' '}</>
      : null}
    {value}
  </Text>;
}

function markdownLink(label: string, raw: string, key: string, depth: number): ReactElement | string {
  const url = safeMarkdownUrl(raw);
  if (!url) return label;
  const file = /\.(pdf|zip|txt|csv|docx?|xlsx?|pptx?|json|md)$/i.test(new URL(url).pathname);
  const caption = <>{file ? '▤ ' : ''}{renderInline(label, depth + 1, false)}{file ? '' : ' ↗'}</>;
  if (Platform.OS === 'web') return <a key={key} href={url} target="_blank" rel="noopener noreferrer"
    style={{ color: colors.primary, textDecoration: 'underline', overflowWrap: 'anywhere' }}>{caption}</a>;
  return <Text key={key} style={styles.link} accessibilityRole="link"
    onPress={() => { void Linking.openURL(url).catch(() => undefined); }}>{caption}</Text>;
}

function renderInline(text: string, depth = 0, links = true): (string | ReactElement)[] {
  if (depth > 4) return [text];
  const parts: (string | ReactElement)[] = [];
  // Keep explicit link/image labels and code opaque to the bare URL scanner.
  const re = inlineMarkdownPattern();
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index!;
    if (index > last) parts.push(text.slice(last, index));
    const key = 'inline-' + index;
    if (match[1]) parts.push(match[1]);
    else if (match[3]) parts.push(colorText(match[3], key, true));
    else if (match[4] !== undefined && match[5]) {
      const url = safeMarkdownUrl(match[5], true);
      parts.push(url
        ? <Image key={key} source={{ uri: url }} accessibilityLabel={match[4] || 'Image'}
          style={styles.inlineImage} resizeMode="contain" />
        : match[0]);
    } else if (match[6] && match[7]) {
      parts.push(links ? markdownLink(match[6], match[7], key, depth) : match[6]);
    } else if (match[8]) {
      const raw = match[8];
      let url = raw.startsWith('<') ? raw.slice(1, -1) : raw.replace(/[.,!?;:]+$/, '');
      if (!raw.startsWith('<') && url.endsWith(')')) {
        let balance = 0;
        for (const char of url) balance += char === '(' ? 1 : char === ')' ? -1 : 0;
        while (balance < 0 && url.endsWith(')')) { url = url.slice(0, -1); balance++; }
      }
      parts.push(links ? markdownLink(url, url, key, depth) : raw);
      if (links && !raw.startsWith('<') && raw.startsWith(url) && raw.length > url.length) parts.push(raw.slice(url.length));
    } else if (match[9] && match[10]) {
      const marker = match[9];
      parts.push(<Text key={key} style={[marker !== '~~' && marker.length >= 2 && styles.bold,
        marker.length % 2 === 1 && styles.italic, marker === '~~' && styles.strike]}>
        {renderInline(match[10], depth + 1, links)}
      </Text>);
    } else if (match[11]) parts.push(<MathInline key={key} tex={match[11]} />);
    else if (match[12] && match[13]) {
      const marker = match[12];
      parts.push(<Text key={key} style={[marker.length >= 2 && styles.bold, marker.length % 2 === 1 && styles.italic]}>
        {renderInline(match[13], depth + 1, links)}
      </Text>);
    }
    else parts.push(hexColor.test(match[0]) ? colorText(match[0], key) : match[0]);
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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
  colorSwatch: { fontSize: 13, fontWeight: "600" },
  tableScroll: { marginVertical: 8, flexGrow: 0 },
  table: {
    flexGrow: 1,
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
