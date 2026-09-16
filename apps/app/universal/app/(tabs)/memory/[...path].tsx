/**
 * Memory — note editor. Pushed as ``[...path]`` onto the Memory Stack.
 *
 * The path is a catch-all so folder segments (``docs/ideas.md``) come
 * through intact. The editor reads ``selectedPath`` from the vault
 * store — we call ``selectNote`` on mount (and whenever the route's
 * path changes) to pull the note.
 *
 * Chrome is the react-navigation header (back + note title) from
 * memory/_layout.tsx; the History / Rename / Edit-Preview / Save controls
 * live in ``headerRight``. The vault's last-save feedback (validation
 * errors / warnings / commit hash) shows in a slim status strip above the
 * body. No inner file-tree sidebar — note navigation is the graph screen.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Platform, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import Markdown from '../../../components/Markdown';
import { HeaderRight, HeaderIconButton, HeaderAction, useHeaderInset } from '../../../components/screenHeader';
import { MemorySearchBar } from '../../../components/memory/MemorySearch';
import { useConnection } from '../../../stores/connection';
import { useVault } from '../../../stores/vault';
import { setBaseUrl } from '../../../services/api';
import { colors, font, radius } from '../../../theme';

// ── In-file search helpers ──

/** Escape regex special chars in a plain-text query. */
function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find all occurrences of `query` in `text`. Returns array of {start, end}. */
function findMatches(
  text: string,
  query: string,
  isRegex: boolean,
): Array<{ start: number; end: number }> {
  if (!query) return [];
  const results: Array<{ start: number; end: number }> = [];
  try {
    const pattern = isRegex ? query : escapeRegExp(query);
    const regex = new RegExp(pattern, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      results.push({ start: match.index, end: match.index + match[0].length });
      // Avoid infinite loop on zero-length matches.
      if (match[0].length === 0) regex.lastIndex++;
    }
  } catch {
    // Invalid regex — return empty, caller shows a badge.
  }
  return results;
}

export default function MemoryNoteScreen() {
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const notePath = Array.isArray(params.path)
    ? params.path.join('/')
    : typeof params.path === 'string'
      ? params.path
      : '';

  const config = useConnection((s) => s.config);
  const {
    notes, editorContent, editorDirty,
    lastWarnings, lastCommit, lastErrors,
    loadNotes, loadGraph, selectNote, updateEditor, saveNote, moveNote,
  } = useVault();

  const [rawMode, setRawMode] = useState(false);

  // ── In-file search ──
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);
  const [searchRegexMode, setSearchRegexMode] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const previewContainerRef = useRef<View>(null);

  const searchMatches = useMemo(
    () => findMatches(editorContent ?? '', searchQuery, searchRegexMode),
    [editorContent, searchQuery, searchRegexMode],
  );

  const searchRegexError = useMemo(() => {
    if (!searchQuery || !searchRegexMode) return false;
    try {
      new RegExp(searchQuery, 'gi');
      return false;
    } catch {
      return true;
    }
  }, [searchQuery, searchRegexMode]);

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    setSearchCurrentIdx((prev) => {
      const next = prev + direction;
      if (next < 0) return searchMatches.length - 1;
      if (next >= searchMatches.length) return 0;
      return next;
    });
  }, [searchMatches.length]);

  const openSearch = useCallback(() => {
    setSearchVisible(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    setSearchCurrentIdx(0);
  }, []);

  // Initial data — same set the graph screen loads, in case the user
  // deep-linked straight to a note.
  useEffect(() => {
    if (config) {
      if (config.sidecarPort) setBaseUrl('127.0.0.1', config.sidecarPort);
      loadNotes();
      loadGraph();
    }
  }, [config]);

  // Load the note into the vault store once per distinct route path —
  // ``selectNote`` also sets the store's ``selectedPath`` so ``saveNote``
  // writes to the right path. We gate on a ref keyed by ``notePath`` rather
  // than reading ``selectedPath`` from the store: ``selectNote`` mutates
  // ``selectedPath`` / ``loading`` / content, so depending on store values
  // here created a setState feedback loop ("Maximum update depth exceeded").
  const requestedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (notePath && requestedPathRef.current !== notePath) {
      requestedPathRef.current = notePath;
      selectNote(notePath);
    }
  }, [notePath, selectNote]);

  // Every new note starts in preview mode.
  useEffect(() => { setRawMode(false); }, [notePath]);

  const handleSave = useCallback(() => {
    saveNote().then(() => loadNotes());
  }, [saveNote, loadNotes]);

  // ── Keyboard shortcuts (web) ──
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+S saves.
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      // Ctrl/Cmd+F opens search.
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
        return;
      }
      // Escape closes search.
      if (e.key === 'Escape' && searchVisible) {
        e.preventDefault();
        closeSearch();
        return;
      }
      // Enter/Shift+Enter navigate matches (only when search is visible
      // and the focus is inside the search bar or the document body).
      if (e.key === 'Enter' && searchVisible) {
        e.preventDefault();
        navigateMatch(e.shiftKey ? -1 : 1);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, openSearch, closeSearch, navigateMatch, searchVisible]);

  // Push the per-note git history screen.
  const openHistory = useCallback(() => {
    router.push({
      pathname: '/(tabs)/memory/history/[...path]',
      params: { path: notePath.split('/') },
    });
  }, [router, notePath]);

  // Rename this note. A bare name keeps the current folder; typing a
  // path moves it. ``moveNote`` rewrites inbound wikilinks server-side;
  // we then ``router.replace`` to the new path so the editor follows.
  const handleRename = useCallback(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/') + 1) : '';
    const current = notePath.split('/').pop() ?? notePath;
    const input = window.prompt('Rename note (name or path):', current);
    if (input == null) return;
    const next = input.trim();
    if (!next || next === current) return;
    const withExt = next.endsWith('.md') ? next : `${next}.md`;
    const target = withExt.includes('/') ? withExt : `${dir}${withExt}`;
    if (target === notePath) return;
    moveNote(notePath, target).then(() => {
      router.replace({
        pathname: '/(tabs)/memory/[...path]',
        params: { path: target.split('/') },
      });
    });
  }, [notePath, moveNote, router]);

  const _selectedNote = notes.find((n) => n.path === notePath);
  const _titleFallback = notePath.split('/').pop()?.replace('.md', '') ?? '';

  // Screen-name title in the nav header (homogeneous; not the note's name).
  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Memory file' });
  }, [navigation]);

  // History / Search / Rename / Edit-Preview / Save in the nav header's right slot.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderRight>
          <HeaderIconButton icon="clock" accessibilityLabel="History" onPress={openHistory} />
          <HeaderIconButton
            icon="search"
            active={searchVisible}
            accessibilityLabel="Search"
            onPress={openSearch}
          />
          {Platform.OS === 'web' && (
            <HeaderIconButton icon="type" accessibilityLabel="Rename" onPress={handleRename} />
          )}
          <HeaderIconButton
            icon={rawMode ? 'eye' : 'edit-3'}
            active={rawMode}
            accessibilityLabel={rawMode ? 'Preview' : 'Edit'}
            onPress={() => setRawMode((v) => !v)}
          />
          {rawMode && (
            <HeaderAction icon="check" label="Save" onPress={handleSave} disabled={!editorDirty} />
          )}
        </HeaderRight>
      ),
    });
    // Depend only on the primitives that change the header's appearance.
    // The handlers (openHistory / handleRename / handleSave) close over
    // ``notePath``; including the callbacks themselves would loop, because
    // ``useRouter()`` hands back a fresh reference each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, rawMode, editorDirty, notePath, searchVisible, openSearch]);

  // ── DOM-based search highlighting (web only, preview mode) ──
  // After the React tree commits, walk the rendered preview container's
  // text nodes and wrap each match in a <mark> element so highlights are
  // visible in the rendered Markdown. Runs on every search/query change.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!searchVisible || rawMode || !previewContainerRef.current) return;

    const container = previewContainerRef.current as unknown as HTMLElement;
    if (!container || typeof container.querySelector !== 'function') return;

    // 1. Remove all previously injected marks and restore text nodes.
    const existingMarks = container.querySelectorAll('mark.oa-search-hl');
    existingMarks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    });

    if (!searchQuery || searchMatches.length === 0) return;

    // 2. Build a regex from the query.
    let pattern: string;
    try {
      pattern = searchRegexMode ? searchQuery : escapeRegExp(searchQuery);
    } catch {
      return;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      return;
    }

    // 3. Walk text nodes, split matches into <mark> elements.
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null,
    );

    const textNodes: CharacterData[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as CharacterData);
    }

    let matchIdx = 0;
    const matchElements: HTMLElement[] = [];

    for (const textNode of textNodes) {
      const text = textNode.textContent ?? '';
      // Reset per-node so we get fresh matches.
      regex.lastIndex = 0;
      const segments: Array<{ text: string; isMatch: boolean }> = [];
      let lastIdx = 0;
      let m: RegExpExecArray | null;

      while ((m = regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        if (m.index > lastIdx) {
          segments.push({ text: text.slice(lastIdx, m.index), isMatch: false });
        }
        segments.push({ text: m[0], isMatch: true });
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < text.length) {
        segments.push({ text: text.slice(lastIdx), isMatch: false });
      }

      if (segments.length <= 1) continue;

      const fragment = document.createDocumentFragment();
      for (const seg of segments) {
        if (seg.isMatch) {
          const markEl = document.createElement('mark');
          markEl.className = 'oa-search-hl';
          markEl.setAttribute('data-match-idx', String(matchIdx));
          const isCurrent = matchIdx === searchCurrentIdx;
          markEl.style.cssText = isCurrent
            ? `background-color: ${colors.warning}; color: inherit; border-radius: 2px; padding: 0 1px;`
            : `background-color: rgba(255, 255, 0, 0.3); color: inherit; border-radius: 2px; padding: 0 1px;`;
          markEl.textContent = seg.text;
          fragment.appendChild(markEl);
          matchElements.push(markEl);
          matchIdx++;
        } else {
          fragment.appendChild(document.createTextNode(seg.text));
        }
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    // 4. Scroll the current match into view.
    if (matchElements.length > 0 && searchCurrentIdx < matchElements.length) {
      const current = matchElements[searchCurrentIdx];
      try {
        current.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      } catch {
        // ignore
      }
    }
  }, [
    searchVisible,
    rawMode,
    searchQuery,
    searchMatches,
    searchCurrentIdx,
    searchRegexMode,
    editorContent,
  ]);

  const showStatus = lastErrors.length > 0
    || (!editorDirty && (lastWarnings.length > 0 || !!lastCommit));

  return (
    <View style={[styles.editorContainer, { paddingTop: headerInset }]}>
      {showStatus && (
        <View style={styles.statusStrip}>
          {/* The quality gate rejected the last save — the note was NOT
              written. Show why so the user can fix and re-save. */}
          {lastErrors.length > 0 && (
            <View style={styles.errorPill}>
              <Text style={styles.errorPillText} numberOfLines={1}>
                ✕ blocked: {lastErrors.map((e) => e.message).join('; ')}
              </Text>
            </View>
          )}
          {!editorDirty && lastWarnings.length > 0 && (
            <View style={styles.warnPill}>
              <Text style={styles.warnPillText} numberOfLines={1}>
                ⚠ {lastWarnings.length}: {Array.from(new Set(lastWarnings.map((w) => w.rule))).join(', ')}
              </Text>
            </View>
          )}
          {!editorDirty && lastCommit && (
            <View style={styles.commitChip}>
              <Text style={styles.commitChipText}>committed {lastCommit.slice(0, 7)}</Text>
            </View>
          )}
        </View>
      )}

      {/* In-file search bar */}
      <MemorySearchBar
        visible={searchVisible}
        query={searchQuery}
        placeholder="Find in file..."
        onChangeQuery={(q) => {
          setSearchQuery(q);
          setSearchCurrentIdx(0);
        }}
        countLabel={
          searchQuery.length > 0
            ? searchMatches.length > 0
              ? `${searchCurrentIdx + 1}/${searchMatches.length}`
              : '0/0'
            : undefined
        }
        onPrev={() => navigateMatch(-1)}
        onNext={() => navigateMatch(1)}
        prevNextDisabled={searchMatches.length === 0}
        regexMode={searchRegexMode}
        onToggleRegex={() => setSearchRegexMode((v) => !v)}
        onClose={closeSearch}
        errorLabel={searchRegexError ? 'Invalid regex' : undefined}
      />

      {rawMode ? (
        Platform.OS === 'web' ? (
          <textarea
            value={editorContent}
            onChange={(e: any) => updateEditor(e.target.value)}
            style={{
              flex: 1, width: '100%', height: '100%',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13, lineHeight: '1.7', padding: 24,
              border: 'none', outline: 'none', resize: 'none',
              backgroundColor: colors.surface, color: colors.text,
              boxSizing: 'border-box',
            } as any}
            spellCheck={false}
          />
        ) : (
          <ScrollView style={{ flex: 1, backgroundColor: colors.surface }}>
            <TextInput
              style={styles.editorInput}
              value={editorContent} onChangeText={updateEditor}
              multiline textAlignVertical="top"
            />
          </ScrollView>
        )
      ) : (
        <ScrollView
          ref={scrollViewRef}
          style={styles.previewScroll}
          contentContainerStyle={styles.previewContent}
        >
          <View ref={previewContainerRef}>
            <Markdown text={editorContent} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  editorContainer: { flex: 1, flexDirection: 'column', backgroundColor: colors.surface },
  statusStrip: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 24, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  warnPill: {
    maxWidth: 320, paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.xs, backgroundColor: colors.errorSoft,
  },
  warnPillText: { fontSize: 10, color: colors.warning, fontFamily: font.mono, fontWeight: '600' },
  errorPill: {
    maxWidth: 480, paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.xs, backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorPillText: { fontSize: 10, color: colors.error, fontFamily: font.mono, fontWeight: '700' },
  commitChip: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.xs, backgroundColor: colors.mutedSoft,
  },
  commitChipText: { fontSize: 10, color: colors.textSecondary, fontFamily: font.mono },
  editorInput: { padding: 24, fontFamily: font.mono, fontSize: 13, color: colors.text, lineHeight: 22 },
  previewScroll: { flex: 1, backgroundColor: colors.surface },
  previewContent: { padding: 24, maxWidth: 720, width: '100%', alignSelf: 'center' },
});
