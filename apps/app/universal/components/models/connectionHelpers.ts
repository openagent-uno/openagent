/** Pure connection identity and account grouping. No endpoint/name inference for new connections. */
import type { ModelEntry, ProviderAccounts, ProviderConfig, ServingAccount } from '../../../common/types';
import { accountsFor, accessFor, type Access } from './modelHelpers';

export interface ConnectionCard {
  key: string;
  provider: ProviderConfig;
  vendor: string;
  access: Access;
  label: string;
  account: ServingAccount | null;
  accounts: ProviderAccounts | null;
  models: ModelEntry[];
  providers: ProviderConfig[];
}

export function connectionInfo(provider: ProviderConfig) {
  const meta = provider.metadata ?? {};
  return {
    vendor: provider.vendor || String(meta.vendor || provider.name),
    label: provider.label || String(meta.label || provider.name),
    access: provider.access || meta.access as Access | undefined,
    accountId: provider.account_id || meta.account_id as string | undefined,
  };
}

export function connectionCards(providers: ProviderConfig[], models: ModelEntry[], accounts: ProviderAccounts[] | null): ConnectionCard[] {
  const cards = providers.flatMap((provider) => {
    const info = connectionInfo(provider);
    const entry = accountsFor(provider, accounts);
    const access = info.access || accessFor(provider, entry);
    const list = entry?.accounts ?? [];
    const selected = info.accountId ? list.filter((a) => a.id === info.accountId) : list;
    // Every subscription account gets a card. A missing/expired account stays visible.
    const children = access === 'subscription' && selected.length ? selected : [null];
    return children.map((account) => ({
      key: `${provider.id}:${account?.id ?? info.accountId ?? 'connection'}`,
      provider, vendor: info.vendor, access,
      label: account?.name || info.label,
      account, accounts: entry ? { ...entry, accounts: account ? [account] : [] } : null,
      models: models.filter((m) => m.provider_id === provider.id), providers: [provider],
    }));
  });
  const merged = new Map<string, ConnectionCard>();
  // Prefer the credential-owning row as the account card's primary connection.
  cards.sort((a, b) => Number(b.provider.id === b.provider.metadata?.credential_store_id)
    - Number(a.provider.id === a.provider.metadata?.credential_store_id));
  for (const card of cards) {
    const meta = card.provider.metadata || {};
    const shared = card.access === 'subscription' && meta.credential_store_id != null
      ? `${card.vendor}:${meta.credential_store_id}:${meta.account_id || card.account?.id || ''}` : card.key;
    const previous = merged.get(shared);
    if (previous) {
      previous.models.push(...card.models);
      previous.providers.push(card.provider);
    } else merged.set(shared, { ...card, models: [...card.models], providers: [...card.providers] });
  }
  return [...merged.values()];
}

export function vendorLabel(vendor: string) {
  return ({ anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', local: 'Local',
    elevenlabs: 'ElevenLabs', deepgram: 'Deepgram', openrouter: 'OpenRouter', custom: 'Custom / compatible', azure: 'Azure',
    groq: 'Groq', mistral: 'Mistral', xai: 'xAI', deepseek: 'DeepSeek', cerebras: 'Cerebras', zai: 'Z.ai', moonshot: 'Moonshot', qwen: 'Qwen' } as Record<string, string>)[vendor] || vendor;
}
