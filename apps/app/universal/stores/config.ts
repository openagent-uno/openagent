/**
 * Config state: agent configuration loaded from the server.
 */

import { create } from 'zustand';
import type { AgentConfig, AgentIdentity } from '../../common/types';
import * as api from '../services/api';

// A refresh may be requested by both navigation and identity broadcasts. Share
// reads only within the same agent scope and local mutation generation.
let mutationGeneration = 0;
let configLoad: { scope: number; generation: number; promise: Promise<void> } | null = null;

interface ConfigState {
  config: AgentConfig | null;
  /** REST selection generation that owns config, identity and load status. */
  sourceScope: number | null;
  loading: boolean;
  error: string | null;
  identityLoading: boolean;
  identityError: string | null;
  identityReadOnly: boolean;
  identityRevision: string | null;
  thumbnail: string | null | undefined;
  channelPresentation: Record<string, string>;
  refreshChannelPresentation: () => Promise<void>;
  dirty: boolean;

  loadConfig: () => Promise<void>;
  updateSection: (section: string, data: any) => Promise<boolean>;
  updateIdentity: (name: string, systemPrompt: string, thumbnail?: string | null) => Promise<AgentIdentity | null>;
  setConfig: (config: AgentConfig) => void;
}

function resetForeignConfig(state: ConfigState, scope: number): Partial<ConfigState> {
  return state.sourceScope === scope ? {} : {
    config: null, sourceScope: scope, loading: false, error: null, identityRevision: null, identityReadOnly: false,
    identityLoading: false, identityError: null, dirty: false,
    thumbnail: undefined, channelPresentation: {},
  };
}

export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  sourceScope: null,
  loading: false,
  error: null,
  identityLoading: false,
  identityError: null,
  identityReadOnly: false,
  identityRevision: null,
  thumbnail: undefined,
  channelPresentation: {},
  dirty: false,

  loadConfig: () => {
    const scope = api.currentAgentScope();
    const generation = mutationGeneration;
    if (configLoad?.scope === scope && configLoad.generation === generation) return configLoad.promise;
    const current = () => scope === api.currentAgentScope() && generation === mutationGeneration;
    // Defer work until its singleflight entry is installed, including when a
    // synchronous store subscriber requests another refresh while loading flips.
    const load = { scope, generation, promise: Promise.resolve() };
    load.promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return;
        const configRequest = api.getConfig();
        // Observe identity rejection immediately: config may fail first, or the
        // scope may change before this result is consumed.
        const identityRequest = api.getAgentIdentity().then(
          value => ({ status: 'fulfilled' as const, value }),
          reason => ({ status: 'rejected' as const, reason }),
        );
        let config = await configRequest;
        if (!current()) return;
        let thumbnail: string | null | undefined;
        let channelPresentation: Record<string, string> = {};
        let identityRevision: string | null = null;
        let identityError: string | null = null;
        let identityReadOnly = false;
        try {
          const result = await identityRequest;
          if (result.status === 'rejected') throw result.reason;
          const identity = result.value;
          config = {
            ...config,
            name: identity.name,
            system_prompt: identity.system_prompt,
          };
          identityReadOnly = identity.can_manage === false;
          identityRevision = identity.revision ?? null;
          thumbnail = identity.thumbnail;
          channelPresentation = identity.channel_presentation ?? {};
        } catch (identityFailure) {
          // Old gateways have no owner-scoped identity endpoint; their generic
          // config surface remains the compatibility source during the rollout.
          if (!api.isUnsupportedByAgent(identityFailure)) {
            identityReadOnly = identityFailure instanceof api.ApiError && identityFailure.status === 403;
            if (identityReadOnly) config = { ...config, system_prompt: undefined };
            identityError = identityFailure instanceof Error
              ? identityFailure.message
              : String(identityFailure);
          }
        }
        if (current()) set({ config, sourceScope: scope, identityRevision, identityError, identityReadOnly, thumbnail, channelPresentation });
      } catch (e: any) {
        if (current()) set({ error: e.message });
      } finally {
        if (configLoad === load) {
          configLoad = null;
          if (scope === api.currentAgentScope()) set({ loading: false });
        }
      }
    });
    configLoad = load;
    // Keep the confirmed revision available to optimistic identity writes.
    set({ ...resetForeignConfig(get(), scope), loading: true, error: null, identityError: null });
    return load.promise;
  },

  refreshChannelPresentation: async () => {
    const scope = api.currentAgentScope();
    try {
      const identity = await api.getAgentIdentity();
      if (scope === api.currentAgentScope()) set({ channelPresentation: identity.channel_presentation ?? {} });
    } catch { /* Preserve the last confirmed status while offline. */ }
  },

  updateSection: async (section, data) => {
    mutationGeneration++;
    const scope = api.currentAgentScope();
    const current = () => scope === api.currentAgentScope();
    try {
      set({ ...resetForeignConfig(get(), scope), error: null });
      await api.updateConfigSection(section, data);
      if (!current()) return false;
      // Reload full config after update
      const config = await api.getConfig();
      if (!current()) return false;
      mutationGeneration++;
      set({ config, sourceScope: scope, dirty: false });
      return true;
    } catch (e: any) {
      if (current()) set({ error: e.message });
      return false;
    }
  },

  updateIdentity: async (name, systemPrompt, thumbnail) => {
    mutationGeneration++;
    const scope = api.currentAgentScope();
    const current = () => scope === api.currentAgentScope();
    try {
      set({ ...resetForeignConfig(get(), scope), identityLoading: true, identityError: null });
      let identity: AgentIdentity;
      try {
        identity = await api.updateAgentIdentity({
          name,
          system_prompt: systemPrompt,
          ...(thumbnail !== undefined ? { thumbnail } : {}),
          ...(get().sourceScope === scope && get().identityRevision
            ? { expected_revision: get().identityRevision as string }
            : {}),
        });
      } catch (error) {
        // Released gateways before agent-manager only expose the two generic
        // config PATCHes. Preserve compatibility, but never use that fallback
        // for a real authorization/validation failure on the new endpoint.
        if (!(error instanceof api.ApiError) || ![404, 405].includes(error.status)) {
          throw error;
        }
        if (!current() || thumbnail !== undefined) return null;
        await api.updateConfigSection('name', name);
        if (!current()) return null;
        await api.updateConfigSection('system_prompt', systemPrompt);
        identity = {
          name,
          system_prompt: systemPrompt,
          revision: '',
          framework_prompt_mutable: false as const,
        };
      }
      if (!current()) return null;
      mutationGeneration++;
      set((state) => ({
        config: {
          ...(state.sourceScope === scope ? state.config || {} : {}),
          name: identity.name,
          system_prompt: identity.system_prompt,
        },
        sourceScope: scope,
        identityRevision: identity.revision || null,
        thumbnail: identity.thumbnail,
        channelPresentation: identity.channel_presentation ?? {},
        identityLoading: false,
        dirty: false,
      }));
      return identity;
    } catch (e: any) {
      if (!current()) return null;
      if (e instanceof api.ApiError && e.status === 409) {
        try {
          const latest = await api.getAgentIdentity();
          if (!current()) return null;
          mutationGeneration++;
          set((state) => ({
            config: {
              ...(state.sourceScope === scope ? state.config || {} : {}),
              name: latest.name,
              system_prompt: latest.system_prompt,
            },
            sourceScope: scope,
            identityRevision: latest.revision,
            thumbnail: latest.thumbnail,
            channelPresentation: latest.channel_presentation ?? {},
            identityLoading: false,
            identityError: 'Identity changed elsewhere. Latest values loaded; review and save again.',
          }));
          return null;
        } catch {
          // Preserve the original conflict below if reconciliation also fails.
        }
      }
      if (current()) set({ identityError: e.message, identityLoading: false });
      return null;
    }
  },

  setConfig: (config) => {
    mutationGeneration++;
    const scope = api.currentAgentScope();
    set({ ...resetForeignConfig(get(), scope), config, sourceScope: scope, dirty: true });
  },
}));
