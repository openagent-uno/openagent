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

export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  error: null,
  identityLoading: false,
  identityError: null,
  identityReadOnly: false,
  identityRevision: null,
  thumbnail: undefined,
  channelPresentation: {},
  dirty: false,

  loadConfig: async () => {
    const scope = api.currentAgentScope();
    const current = () => scope === api.currentAgentScope();
    set({ loading: true, error: null, identityError: null, identityRevision: null });
    try {
      let config = await api.getConfig();
      if (!current()) return;
      let thumbnail: string | null | undefined;
      let channelPresentation: Record<string, string> = {};
      let identityRevision: string | null = null;
      let identityError: string | null = null;
      let identityReadOnly = false;
      try {
        const identity = await api.getAgentIdentity();
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
      if (current()) set({ config, loading: false, identityRevision, identityError, identityReadOnly, thumbnail, channelPresentation });
    } catch (e: any) {
      if (current()) set({ error: e.message, loading: false });
    }
  },

  refreshChannelPresentation: async () => {
    const scope = api.currentAgentScope();
    try {
      const identity = await api.getAgentIdentity();
      if (scope === api.currentAgentScope()) set({ channelPresentation: identity.channel_presentation ?? {} });
    } catch { /* Preserve the last confirmed status while offline. */ }
  },

  updateSection: async (section, data) => {
    const scope = api.currentAgentScope();
    const current = () => scope === api.currentAgentScope();
    try {
      set({ error: null });
      await api.updateConfigSection(section, data);
      if (!current()) return false;
      // Reload full config after update
      const config = await api.getConfig();
      if (!current()) return false;
      set({ config, dirty: false });
      return true;
    } catch (e: any) {
      if (current()) set({ error: e.message });
      return false;
    }
  },

  updateIdentity: async (name, systemPrompt, thumbnail) => {
    const scope = api.currentAgentScope();
    const current = () => scope === api.currentAgentScope();
    try {
      set({ identityLoading: true, identityError: null });
      let identity: AgentIdentity;
      try {
        identity = await api.updateAgentIdentity({
          name,
          system_prompt: systemPrompt,
          ...(thumbnail !== undefined ? { thumbnail } : {}),
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
      set((state) => ({
        config: {
          ...(state.config || {}),
          name: identity.name,
          system_prompt: identity.system_prompt,
        },
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
          set((state) => ({
            config: {
              ...(state.config || {}),
              name: latest.name,
              system_prompt: latest.system_prompt,
            },
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

  setConfig: (config) => set({ config, dirty: true }),
}));
