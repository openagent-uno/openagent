export interface DiscoverableAgent {
  handle?: string;
  nodeId?: string;
}

export interface AgentSelectionOptions {
  /** Onboarding may intentionally choose the coordinator's preferred agent.
   * Returning legacy accounts must set this false: if several agents exist,
   * silently choosing the first one binds a saved label to the wrong target. */
  allowDefault?: boolean;
}

/** Select the requested agent exactly. Falling back to the first registered
 * agent is valid only during onboarding, when no target was requested. */
export function selectAgentForConnection<T extends DiscoverableAgent>(
  agents: T[],
  requestedHandle?: string,
  options: AgentSelectionOptions = {},
): T | undefined {
  if (!requestedHandle) {
    if (agents.length === 1 || options.allowDefault !== false) return agents[0];
    return undefined;
  }
  const normalized = requestedHandle.trim().toLowerCase();
  return agents.find(
    (agent) => (agent.handle ?? '').trim().toLowerCase() === normalized,
  );
}
