export interface StorageBackend {
  get(key: string, defaultValue: null): unknown;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface StorageCallbacks {
  get(event: unknown, key: string): string | null;
  set(event: unknown, key: string, value: string): void;
  remove(event: unknown, key: string): void;
}

/**
 * Build IPC callbacks without constructing the backing store. This is what
 * lets main.ts call app.setPath('userData', ...) before electron-store asks
 * Electron for its config directory.
 */
export function createStorageCallbacks(
  createStore: () => StorageBackend,
): StorageCallbacks {
  let store: StorageBackend | null = null;
  const getStore = (): StorageBackend => {
    if (store == null) store = createStore();
    return store;
  };

  return {
    get: (_event, key) => getStore().get(key, null) as string | null,
    set: (_event, key, value) => {
      getStore().set(key, value);
    },
    remove: (_event, key) => {
      getStore().delete(key);
    },
  };
}
