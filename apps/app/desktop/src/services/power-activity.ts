/** Main-owned activity survives route changes, hidden windows and agent switches.
 * Polls the stateless authorized existence query, not pages or transcripts. */
export class PowerActivity {
  private accounts = new Map<string, {
    baseUrl: string; active: boolean; retainedActive: boolean; release: (() => void) | null;
    timer?: ReturnType<typeof setTimeout>; abort?: AbortController;
  }>();
  private owners = new Map<number, { accountId: string; active: boolean }>();
  private stopped = false;

  constructor(private readonly retain: (id: string, closeWhenUnclaimed?: boolean) => (() => void) | null,
    private readonly changed: (active: boolean) => void,
    private readonly request: typeof fetch = fetch) {}

  add(accountId: string, baseUrl: string): void {
    if (this.stopped) return;
    this.remove(accountId);
    // Hold the tunnel through its first authoritative check, even if the
    // renderer switches away while that read is in flight.
    const entry = { baseUrl, active: false, retainedActive: false, release: this.retain(accountId, false) };
    this.accounts.set(accountId, entry);
    void this.poll(accountId, entry);
  }

  report(owner: number, accountId: string | null, active: boolean): void {
    if (this.stopped) return;
    if (accountId && this.accounts.has(accountId)) this.owners.set(owner, { accountId, active });
    else this.owners.delete(owner);
    this.update();
  }

  releaseOwner(owner: number): void { this.owners.delete(owner); this.update(); }

  remove(accountId: string): void {
    const entry = this.accounts.get(accountId);
    this.accounts.delete(accountId);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.abort?.abort();
    entry?.release?.();
    for (const [owner, claim] of this.owners) if (claim.accountId === accountId) this.owners.delete(owner);
    this.update();
  }

  private update(): void {
    let active = false;
    for (const [id, entry] of this.accounts) {
      const running = entry.active || [...this.owners.values()].some(claim => claim.accountId === id && claim.active);
      if (running) {
        active = true;
        if (!entry.retainedActive) {
          // The initial probe must not reap an account startup reservation.
          // Once real work is observed, its background lease owns idle cleanup.
          entry.release?.(); entry.release = null; entry.retainedActive = true;
        }
        entry.release ??= this.retain(id);
      }
      else if (entry.release && !entry.abort) {
        const release = entry.release; entry.release = null; release();
      }
    }
    this.changed(active);
  }

  private async poll(id: string, entry: NonNullable<ReturnType<typeof this.accounts.get>>): Promise<void> {
    if (this.stopped || this.accounts.get(id) !== entry) return;
    const abort = entry.abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 5_000);
    try {
      const baseUrl = entry.baseUrl.replace(/\/$/, '');
      const response = await this.request(baseUrl + '/api/history/active', { signal: abort.signal });
      let active: boolean;
      if (response.status === 404 || response.status === 405) {
        // Older servers expose a stateless recent-session list. A full page
        // with no live entry is inconclusive, not proof that all work ended.
        const legacy = await this.request(baseUrl + '/api/sessions?limit=200', { signal: abort.signal });
        if (!legacy.ok) throw new Error('Activity unavailable');
        const body = await legacy.json();
        if (!Array.isArray(body.sessions) || body.sessions.length > 200) throw new Error('Invalid activity');
        active = body.sessions.some((session: any) => session._live === true);
        if (!active && body.sessions.length === 200) throw new Error('Incomplete activity');
      } else {
        if (!response.ok) throw new Error('Activity unavailable');
        const body = await response.json();
        if (typeof body.active !== 'boolean') throw new Error('Invalid activity');
        active = body.active;
      }
      if (this.accounts.get(id) === entry) entry.active = active;
    } catch { /* Losing observation does not prove the last active run ended. */ }
    finally {
      clearTimeout(deadline);
      if (this.accounts.get(id) === entry) {
        entry.abort = undefined;
        this.update();
        if (this.accounts.get(id) === entry)
          entry.timer = setTimeout(() => { void this.poll(id, entry); }, 10_000);
      }
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const id of [...this.accounts.keys()]) this.remove(id);
    this.owners.clear();
    this.changed(false);
  }
}
