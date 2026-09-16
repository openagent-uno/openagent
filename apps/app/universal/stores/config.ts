/**
 * Config state: agent configuration loaded from the server.
 */

import { create } from 'zustand';
import type { AgentConfig, AgentIdentity } from '../../common/types';
import * as api from '../services/api';

interface ConfigState {
  config: AgentConfig | null;
  loading: boolean;
  error: string | null;
  identityLoading: boolean;
  identityError: string | null;
  identityRevision: string | null;
  dirty: boolean;

  loadConfig: () => Promise<void>;
  updateSection: (section: string, data: any) => Promise<boolean>;
  updateIdentity: (name: string, systemPrompt: string) => Promise<AgentIdentity | null>;
  setConfig: (config: AgentConfig) => void;
}

export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  error: null,
  identityLoading: false,
  identityError: null,
  identityRevision: null,
  dirty: false,

  loadConfig: async () => {
    set({ loading: true, error: null, identityError: null, identityRevision: null });
    try {
      let config = await api.getConfig();
      let identityRevision: string | null = null;
      let identityError: string | null = null;
      try {
        const identity = await api.getAgentIdentity();
        config = {
          ...config,
          name: identity.name,
          system_prompt: identity.system_prompt,
        };
        identityRevision = identity.revision;
      } catch (identityFailure) {
        // Old gateways have no owner-scoped identity endpoint; their generic
        // config surface remains the compatibility source during the rollout.
        if (!api.isUnsupportedByAgent(identityFailure)) {
          identityError = identityFailure instanceof Error
            ? identityFailure.message
            : String(identityFailure);
        }
      }
      set({ config, loading: false, identityRevision, identityError });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  updateSection: async (section, data) => {
    try {
      set({ error: null });
      await api.updateConfigSection(section, data);
      // Reload full config after update
      const config = await api.getConfig();
      set({ config, dirty: false });
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  updateIdentity: async (name, systemPrompt) => {
    try {
      set({ identityLoading: true, identityError: null });
      let identity: AgentIdentity;
      try {
        identity = await api.updateAgentIdentity({
          name,
          system_prompt: systemPrompt,
          ...(get().identityRevision
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
        await api.updateConfigSection('name', name);
        await api.updateConfigSection('system_prompt', systemPrompt);
        identity = {
          name,
          system_prompt: systemPrompt,
          revision: '',
          framework_prompt_mutable: false as const,
        };
      }
      set((state) => ({
        config: {
          ...(state.config || {}),
          name: identity.name,
          system_prompt: identity.system_prompt,
        },
        identityRevision: identity.revision || null,
        identityLoading: false,
        dirty: false,
      }));
      return identity;
    } catch (e: any) {
      if (e instanceof api.ApiError && e.status === 409) {
        try {
          const latest = await api.getAgentIdentity();
          set((state) => ({
            config: {
              ...(state.config || {}),
              name: latest.name,
              system_prompt: latest.system_prompt,
            },
            identityRevision: latest.revision,
            identityLoading: false,
            identityError: 'Identity changed elsewhere. Latest values loaded; review and save again.',
          }));
          return null;
        } catch {
          // Preserve the original conflict below if reconciliation also fails.
        }
      }
      set({ identityError: e.message, identityLoading: false });
      return null;
    }
  },

  setConfig: (config) => set({ config, dirty: true }),
}));
