export interface PublicAccountTarget {
  network: string;
  handle: string;
  agentHandle: string;
}

export interface AccountAgentPresentation {
  /** The coordinator-verified target when available, otherwise the legacy label. */
  primary: string;
  /** A distinct user-facing alias retained without letting it masquerade as the target. */
  alias: string | null;
  verified: boolean;
}

export interface AccountLoopbackTarget {
  accountId: string;
  handle: string;
  network: string;
  agent?: string;
}

function legacyAgentLabel(account: { name: string; handle: string }): string {
  const parts = String(account.name || '').split(' — ');
  return (parts.length > 1 ? parts[parts.length - 1] : account.name).trim()
    || account.handle.trim()
    || 'Agent';
}

/** Keep a friendly saved label, but never use it as the routing identity.
 *
 * Legacy account rows predate ``agentHandle`` and may say “Friday” while a
 * coordinator-authenticated repair has pinned the row to another agent.  The
 * verified handle is therefore always primary; a differing saved name is
 * shown only as an explicit alias.
 */
export function accountAgentPresentation(account: {
  name: string;
  handle: string;
  agentHandle?: string;
}): AccountAgentPresentation {
  const legacy = legacyAgentLabel(account);
  const verified = String(account.agentHandle || '').trim();
  if (!verified) {
    return { primary: legacy, alias: null, verified: false };
  }
  return {
    primary: verified,
    alias: legacy.localeCompare(verified, undefined, { sensitivity: 'accent' }) === 0
      ? null
      : legacy,
    verified: true,
  };
}

/** Build the non-secret routing fields sent to Electron main.
 *
 * An explicit selection from the legacy-account repair form wins over the
 * saved target. This helper is shared by normal login and the separate-window
 * flow so the latter cannot silently discard the user's choice.
 */
export function accountLoopbackTarget(
  account: {
    id: string;
    handle: string;
    network: string;
    agentHandle?: string;
  },
  selectedAgentHandle?: string,
): AccountLoopbackTarget {
  const selected = selectedAgentHandle?.trim();
  return {
    accountId: account.id,
    handle: account.handle,
    network: account.network,
    agent: selected || account.agentHandle,
  };
}

/** Apply non-secret metadata verified by Electron main after coordinator auth. */
export function withVerifiedAccountTarget<
  TAccount extends { network: string; handle: string; agentHandle?: string },
>(account: TAccount, target: PublicAccountTarget): TAccount {
  return {
    ...account,
    network: target.network,
    handle: target.handle,
    agentHandle: target.agentHandle,
  };
}

export function hasExplicitLoopbackTarget(
  account: { network: string; handle: string },
): boolean {
  return account.network.trim().length > 0 && account.handle.trim().length > 0;
}
