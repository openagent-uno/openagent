/**
 * Vault state: notes list, graph data, selected note, editor content.
 */

import { create } from 'zustand';
import type {
  VaultNote, GraphData, VaultWarning,
  InFileMatch, } from '../../common/types';
import * as api from '../services/api';

interface VaultState {
  notes: VaultNote[];
  graph: GraphData | null;
  selectedPath: string | null;
  editorContent: string;
  editorDirty: boolean;
  searchQuery: string;
  searchResults: VaultNote[];
  /** Set of matching note paths from the most recent search — used by the
   *  graph view to highlight matching nodes. */
  highlightNodeIds: Set<string>;
  loading: boolean;
  error: string | null;
  // Result of the most recent ``saveNote`` — the editor header surfaces
  // these (validation warnings + the git commit hash for the write).
  lastWarnings: VaultWarning[];
  lastCommit: string | null;
  // Set when the last save was REJECTED by the quality gate (nothing
  // written). The editor shows these and keeps the text so the user can fix.
  lastErrors: VaultWarning[];
  // ── In-file search state ──
  inFileSearchQuery: string;
  inFileSearchRegex: boolean;
  inFileSearchResults: InFileMatch[];
  inFileSearchActive: boolean;
  inFileSearchCurrentIdx: number;

  loadNotes: () => Promise<void>;
  loadGraph: () => Promise<void>;
  selectNote: (path: string) => Promise<void>;
  updateEditor: (content: string) => void;
  saveNote: () => Promise<void>;
  moveNote: (from: string, to: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  // ── New search capabilities ──
  searchFileNames: (query: string) => Promise<void>;
  searchInFile: (path: string, query: string, regex?: boolean) => Promise<void>;
  openInFileSearch: () => void;
  closeInFileSearch: () => void;
  nextInFileMatch: () => void;
  prevInFileMatch: () => void;
}

export const useVault = create<VaultState>((set, get) => ({
  notes: [],
  graph: null,
  selectedPath: null,
  editorContent: '',
  editorDirty: false,
  searchQuery: '',
  searchResults: [],
  highlightNodeIds: new Set<string>(),
  loading: false,
  error: null,
  lastWarnings: [],
  lastCommit: null,
  lastErrors: [],
  inFileSearchQuery: '',
  inFileSearchRegex: false,
  inFileSearchResults: [],
  inFileSearchActive: false,
  inFileSearchCurrentIdx: -1,

  loadNotes: async () => {
    set({ loading: true, error: null });
    try {
      const notes = await api.listNotes();
      set({ notes, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  loadGraph: async () => {
    try {
      const graph = await api.getGraph();
      set({ graph });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  selectNote: async (path) => {
    set({ selectedPath: path, loading: true });
    try {
      const note = await api.readNote(path);
      set({ editorContent: note.content, editorDirty: false, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  updateEditor: (content) => set({ editorContent: content, editorDirty: true }),

  saveNote: async () => {
    const { selectedPath, editorContent } = get();
    if (!selectedPath) return;
    try {
      const res = await api.writeNote(selectedPath, editorContent);
      if (res.ok === false) {
        // Rejected by the quality gate — nothing was saved. Keep the text
        // dirty and surface the errors so the user can fix and re-save.
        set({
          editorDirty: true,
          lastErrors: res.errors ?? [],
          lastWarnings: res.warnings ?? [],
        });
        return;
      }
      set({
        editorDirty: false,
        lastErrors: [],
        lastWarnings: res.warnings ?? [],
        lastCommit: res.commit ?? null,
      });
      // Reload graph after save (links may have changed)
      get().loadGraph();
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  // Rename a note or folder. The gateway rewrites inbound wikilinks, so
  // we reload both the note list and the graph afterwards. If the note
  // currently open in the editor was the one renamed, follow the move so
  // a subsequent save targets the new path.
  moveNote: async (from, to) => {
    try {
      const res = await api.moveNote(from, to);
      const { selectedPath } = get();
      if (selectedPath === from) {
        set({ selectedPath: res.moved.to });
      }
      await get().loadNotes();
      await get().loadGraph();
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  search: async (query) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: [], highlightNodeIds: new Set() });
      return;
    }
    try {
      const results = await api.searchNotes(query);
      const highlightNodeIds = new Set(results.map((n) => n.path));
      set({ searchResults: results, highlightNodeIds });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [], highlightNodeIds: new Set() }),

  searchFileNames: async (query) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: [], highlightNodeIds: new Set() });
      return;
    }
    try {
      const results = await api.searchNotesByFileName(query);
      const highlightNodeIds = new Set(results.map((n) => n.path));
      set({ searchResults: results, highlightNodeIds });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  searchInFile: async (path, query, regex = false) => {
    set({ inFileSearchQuery: query, inFileSearchRegex: regex });
    if (!query.trim()) {
      set({ inFileSearchResults: [], inFileSearchCurrentIdx: -1 });
      return;
    }
    try {
      const result = await api.searchInFile(path, query, regex);
      set({
        inFileSearchResults: result.matches,
        inFileSearchCurrentIdx: result.matches.length > 0 ? 0 : -1,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  openInFileSearch: () => set({ inFileSearchActive: true }),

  closeInFileSearch: () => set({
    inFileSearchActive: false,
    inFileSearchQuery: '',
    inFileSearchRegex: false,
    inFileSearchResults: [],
    inFileSearchCurrentIdx: -1,
  }),

  nextInFileMatch: () => {
    const { inFileSearchResults, inFileSearchCurrentIdx } = get();
    if (inFileSearchResults.length === 0) return;
    const next = (inFileSearchCurrentIdx + 1) % inFileSearchResults.length;
    set({ inFileSearchCurrentIdx: next });
  },

  prevInFileMatch: () => {
    const { inFileSearchResults, inFileSearchCurrentIdx } = get();
    if (inFileSearchResults.length === 0) return;
    const prev = (inFileSearchCurrentIdx - 1 + inFileSearchResults.length) % inFileSearchResults.length;
    set({ inFileSearchCurrentIdx: prev });
  },
}));
