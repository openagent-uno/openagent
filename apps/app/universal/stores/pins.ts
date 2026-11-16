/**
 * Sidebar pins, per account and kept on this device.
 *
 * A pin is a key from ``historyPinKey``: a conversation (``chat:<id>``) or a
 * routine (``task:<id>``, ``workflow:<id>``, ``event:<id>``) whose newest run
 * the pinned row opens. Pins are presentation only; they never grant access.
 */
import { create } from 'zustand';
import { getItem, setItem } from '../services/storage';

const MAX_PINS = 20;

interface PinsState {
  accountId: string | null;
  pins: string[];
  load: (accountId: string | null) => Promise<void>;
  toggle: (key: string) => void;
}

const storageKey = (accountId: string) => `oa.sidebar.pins.${accountId}`;

function parsePins(raw: string | null): string[] {
  try {
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((pin) => typeof pin === 'string').slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
}

export const usePins = create<PinsState>((set, get) => ({
  accountId: null,
  pins: [],
  load: async (accountId) => {
    if (accountId === get().accountId) return;
    set({ accountId, pins: [] });
    if (!accountId) return;
    const pins = parsePins(await getItem(storageKey(accountId)));
    if (get().accountId === accountId) set({ pins });
  },
  toggle: (key) => {
    const { accountId, pins } = get();
    if (!accountId) return;
    const next = pins.includes(key) ? pins.filter((pin) => pin !== key) : [key, ...pins].slice(0, MAX_PINS);
    set({ pins: next });
    void setItem(storageKey(accountId), JSON.stringify(next));
  },
}));
