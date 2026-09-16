/**
 * Memory — graph dashboard (stack root).
 *
 * The graph fills the content area. Tapping a graph node pushes
 * ``[...path]`` onto the Memory Stack, which hosts the editor.
 * ``router.push`` keeps ``index`` on the stack so the editor's back
 * chevron (the shared ``HeaderBack`` → ``goBack`` → ``router.back()``)
 * returns here cleanly.
 *
 * The nav header carries History/Search icon buttons like the file viewer.
 * Search opens below the header, filters the graph (matching nodes glow,
 * others dim), and shows a shared Memory results panel.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import GraphView from '../../../components/GraphView';
import { HeaderIconButton, HeaderRight, useHeaderInset } from '../../../components/screenHeader';
import { MemorySearchBar, MemorySearchResults } from '../../../components/memory/MemorySearch';
import { useConnection } from '../../../stores/connection';
import { useEvents } from '../../../stores/events';
import { useVault } from '../../../stores/vault';
import { setBaseUrl } from '../../../services/api';
import { colors } from '../../../theme';

// ── Main screen ──

export default function MemoryGraphScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const config = useConnection((s) => s.config);
  const {
    graph,
    highlightNodeIds,
    loading,
    searchQuery,
    searchResults,
    search,
    clearSearch,
    loadNotes,
    loadGraph,
  } = useVault();
  const [searchVisible, setSearchVisible] = useState(false);

  useEffect(() => {
    if (config) {
      if (config.sidecarPort) setBaseUrl('127.0.0.1', config.sidecarPort);
      loadNotes();
      loadGraph();
    }
  }, [config]);

  // Refetch on every screen focus so re-opening the tab always shows
  // fresh data (same as Connectors). The store keeps the existing notes
  // and graph visible while the refetch is in flight, so the graph never
  // blanks out to a loading state after the first load.
  useFocusEffect(
    useCallback(() => {
      void loadNotes();
      void loadGraph();
    }, [loadNotes, loadGraph]),
  );

  // Refetch when the agent (or another tab) writes/deletes a vault note.
  useEffect(() => {
    return useEvents.getState().subscribe('vault', () => {
      void loadNotes();
      void loadGraph();
    });
  }, [loadNotes, loadGraph]);

  const openNote = (path: string) => {
    // Split on ``/`` so folder segments become individual route segments
    // — the ``[...path]`` catch-all receives them as an array.
    router.push({
      pathname: '/(tabs)/memory/[...path]',
      params: { path: path.split('/') },
    });
  };

  const openHistory = useCallback(() => router.push('/(tabs)/memory/history'), [router]);
  const openHealth = useCallback(() => router.push('/(tabs)/memory/health'), [router]);
  const openSearch = useCallback(() => setSearchVisible(true), []);
  const closeSearch = useCallback(() => {
    clearSearch();
    setSearchVisible(false);
  }, [clearSearch]);

  // Match the file viewer header: History and Search sit together as
  // icon-only actions in the right slot, while search itself opens below.
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Memory',
      headerRight: () => (
        <HeaderRight>
          <HeaderIconButton icon="activity" accessibilityLabel="Vault health" onPress={openHealth} />
          <HeaderIconButton icon="clock" accessibilityLabel="History" onPress={openHistory} />
          <HeaderIconButton
            icon="search"
            active={searchVisible}
            accessibilityLabel="Search"
            onPress={openSearch}
          />
        </HeaderRight>
      ),
    });
  }, [navigation, openHistory, openHealth, openSearch, searchVisible]);

  return (
    <View style={styles.mainArea}>
      {graph && graph.nodes.length > 0 ? (
        <GraphView
          data={graph}
          highlightNodeIds={highlightNodeIds}
          onSelectNode={openNote}
        />
      ) : (
        <View style={styles.graphEmpty}>
          <Text style={styles.emptyText}>
            {loading ? 'Loading graph...' : 'No notes to visualize'}
          </Text>
        </View>
      )}
      <View style={[styles.searchOverlay, { top: headerInset + 10 }]}>
        <MemorySearchBar
          visible={searchVisible}
          query={searchQuery}
          placeholder="Search notes..."
          countLabel={searchQuery ? String(searchResults.length) : undefined}
          onChangeQuery={(q) => {
            if (q) void search(q);
            else clearSearch();
          }}
          onClose={closeSearch}
        />
        {searchVisible ? (
          <MemorySearchResults
            query={searchQuery}
            results={searchResults}
            onSelect={openNote}
            onClear={closeSearch}
          />
        ) : null}
      </View>
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  mainArea: { flex: 1 },
  searchOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 50,
  },
  graphEmpty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 12, padding: 14 },
});
