import type { AgentConfig } from './types';

/** The editable server settings, expressed in the same units as their inputs. */
export function settingsDraftValues(config: AgentConfig | null) {
  const channels = config?.channels || {};
  return {
    name: config?.name || '',
    systemPrompt: config?.system_prompt || '',
    dreamEnabled: config?.dream_mode?.enabled ?? false,
    dreamTime: config?.dream_mode?.time || '3:00',
    autoUpdateEnabled: config?.auto_update?.enabled ?? false,
    autoUpdateMode: config?.auto_update?.mode || 'auto',
    autoUpdateInterval: config?.auto_update?.check_interval || '17 */6 * * *',
    tgToken: channels.telegram?.token || '',
    tgUsers: (channels.telegram?.allowed_users || []).join(', '),
    tgModel: channels.telegram?.model || '',
    dcToken: channels.discord?.token || '',
    dcUsers: (channels.discord?.allowed_users || []).join(', '),
    dcModel: channels.discord?.model || '',
    waId: channels.whatsapp?.green_api_id || '',
    waToken: channels.whatsapp?.green_api_token || '',
    waUsers: (channels.whatsapp?.allowed_users || []).join(', '),
    waModel: channels.whatsapp?.model || '',
    whEnabled: !!channels.webhook?.enabled,
    whHost: channels.webhook?.host || '0.0.0.0',
    whPort: String(channels.webhook?.port ?? 8899),
    whPublicUrl: channels.webhook?.public_url || '',
  };
}

export type SettingsDraftValues = ReturnType<typeof settingsDraftValues>;
export type SettingsDraftBaseline = { scope: string; values: SettingsDraftValues };

/** Refresh untouched fields; edits belong exclusively to their originating scope. */
export function reconcileSettingsDraft(
  previous: SettingsDraftBaseline | null,
  scope: string,
  current: SettingsDraftValues,
  incoming: SettingsDraftValues,
) {
  const values = { ...incoming };
  if (previous?.scope === scope) {
    for (const key of Object.keys(values) as (keyof SettingsDraftValues)[]) {
      if (!Object.is(current[key], previous.values[key])) {
        // All values are scalar form inputs; retain each edited input verbatim.
        Object.assign(values, { [key]: current[key] });
      }
    }
  }
  return { values, baseline: { scope, values: incoming } };
}

/** A save receipt must not erase typing done while the request was pending. */
export function acceptedSettingsField<T>(current: T, submitted: T, confirmed: T): T {
  return Object.is(current, submitted) ? confirmed : current;
}

/** Hide an account's pending media edit as soon as another scope is rendered. */
export function ownedSettingsValue<T>(ownerScope: string, currentScope: string, value: T): T | undefined {
  return ownerScope === currentScope ? value : undefined;
}
