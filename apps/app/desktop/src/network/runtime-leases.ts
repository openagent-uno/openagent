/** One native endpoint per device identity, shared by independent tunnels. */
export function createRuntimeLeases<T extends { shutdown: () => Promise<void> }>() {
  interface Entry {
    opening: Promise<T>;
    users: number;
    closing?: Promise<void>;
  }

  const entries = new Map<string, Entry>();

  return {
    async acquire(key: string, open: () => Promise<T>): Promise<{
      runtime: T;
      release: () => Promise<void>;
    }> {
      let entry = entries.get(key);
      while (entry?.closing) {
        await entry.closing;
        entry = entries.get(key);
      }
      if (!entry) {
        entry = { opening: open(), users: 0 };
        entries.set(key, entry);
      }
      const lease = entry;
      lease.users += 1;
      let runtime: T;
      try {
        runtime = await lease.opening;
      } catch (error) {
        if (entries.get(key) === lease) entries.delete(key);
        throw error;
      }

      let released = false;
      return {
        runtime,
        release: async () => {
          if (released) return;
          released = true;
          lease.users -= 1;
          if (lease.users > 0) return;
          // Keep the closing entry in the map until the relay registration
          // is released. A rapid reconnect must wait for native shutdown.
          lease.closing = runtime.shutdown().finally(() => {
            entries.delete(key);
          });
          await lease.closing;
        },
      };
    },
  };
}
