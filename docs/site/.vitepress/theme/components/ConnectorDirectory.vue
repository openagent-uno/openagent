<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { data as official } from './connector-catalog.data';

const scopes = [
  { value: 'all', label: 'All' },
  { value: 'official', label: 'Official connectors' },
  { value: 'marketplace', label: 'MCP marketplace' },
] as const;
type Scope = typeof scopes[number]['value'];

type RegistryServer = {
  name: string;
  title?: string;
  description?: string;
  version?: string;
};
type RegistryPage = {
  servers: { server: RegistryServer }[];
  metadata: { nextCursor?: string };
};

const bundledLogos = import.meta.glob<string>(
  '../../../../../apps/app/universal/assets/connectors/*.{png,svg}',
  { eager: true, query: '?url', import: 'default' },
);
const logos = new Map(Object.entries(bundledLogos).map(([path, url]) => [
  path.split('/').pop()!.replace(/\.(png|svg)$/, ''), url,
]));

const scope = ref<Scope>('all');
const query = ref('');
const search = computed(() => query.value.trim());
const showMarketplace = computed(() => scope.value !== 'official');
const marketplace = ref<RegistryServer[]>([]);
const cursor = ref('');
const loading = ref(true);
const error = ref('');
let request: AbortController | undefined;

const officialResults = computed(() => {
  if (scope.value === 'marketplace') return [];
  const term = search.value.toLowerCase();
  return official.filter(item =>
    `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(term),
  );
});

const cards = computed(() => [
  ...officialResults.value.map(item => ({
    key: `official:${item.id}`, title: item.name, description: item.description,
    source: 'Official', detail: item.category, logo: logos.get(item.id), subtitle: '',
  })),
  ...marketplace.value.map(item => ({
    key: `mcp:${item.name}`, title: item.title || item.name, description: item.description,
    source: 'MCP registry', detail: item.version || '', logo: undefined,
    subtitle: item.title && item.title !== item.name ? item.name : '',
  })),
].sort((a, b) => a.title.localeCompare(b.title)));

async function loadMarketplace(next = '') {
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = '';
  const params = new URLSearchParams({ version: 'latest', limit: '24' });
  if (search.value) params.set('search', search.value);
  if (next) params.set('cursor', next);
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`, {
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('Registry request failed');
    const page = await response.json() as RegistryPage;
    if (request !== controller) return;
    const rows = new Map((next ? marketplace.value : []).map(item => [item.name, item]));
    for (const { server } of page.servers) {
      if (server?.name) rows.set(server.name, server);
    }
    marketplace.value = [...rows.values()];
    const following = page.metadata.nextCursor || '';
    cursor.value = following === next ? '' : following;
  } catch {
    if (request === controller) error.value = 'The MCP registry is temporarily unavailable.';
  } finally {
    window.clearTimeout(timeout);
    if (request === controller) loading.value = false;
  }
}

onMounted(() => {
  watch([search, showMarketplace], ([, enabled], _, onCleanup) => {
    marketplace.value = [];
    cursor.value = '';
    error.value = '';
    loading.value = enabled;
    if (!enabled) return;
    const debounce = window.setTimeout(() => void loadMarketplace(), 250);
    onCleanup(() => {
      window.clearTimeout(debounce);
      request?.abort();
      request = undefined;
    });
  }, { immediate: true });
});
</script>

<template>
  <main class="connector-directory" aria-labelledby="directory-heading">
    <header>
      <h1 id="directory-heading">Connectors</h1>
      <p>Browse official OpenAgent connectors and community servers from the MCP Registry.</p>
    </header>

    <div class="directory-controls">
      <div class="directory-filters" role="group" aria-label="Catalog source">
        <button
          v-for="item in scopes"
          :key="item.value"
          type="button"
          :aria-pressed="scope === item.value"
          @click="scope = item.value"
        >{{ item.label }}</button>
      </div>
      <input v-model="query" type="search" aria-label="Search connectors" placeholder="Search connectors…" maxlength="150">
    </div>

    <p class="directory-status" role="status">
      <span v-if="scope !== 'marketplace'">{{ officialResults.length }} official</span>
      <span v-if="scope === 'all'"> · </span>
      <span v-if="showMarketplace">{{ loading ? 'Loading MCP servers…' : `${marketplace.length} MCP servers` }}</span>
    </p>
    <ul v-if="cards.length" class="directory-grid" aria-label="Connector results">
      <li v-for="card in cards" :key="card.key" class="directory-card">
        <div class="card-heading">
          <img v-if="card.logo" :src="card.logo" alt="" width="40" height="40" loading="lazy">
          <span v-else class="card-initial" aria-hidden="true">{{ card.title.slice(0, 1).toUpperCase() }}</span>
          <div class="card-title">
            <h2>{{ card.title }}</h2>
            <span v-if="card.subtitle" class="card-namespace">{{ card.subtitle }}</span>
          </div>
        </div>
        <p v-if="card.description">{{ card.description }}</p>
        <div class="card-meta">
          <span class="source-label" :class="{ 'source-official': card.source === 'Official' }">{{ card.source }}</span>
          <span v-if="card.detail">{{ card.detail }}</span>
        </div>
      </li>
    </ul>
    <p v-else-if="!loading && !error" class="directory-message">No connectors match this search.</p>
    <div v-if="showMarketplace && (error || cursor)" class="directory-pagination">
      <p v-if="error" role="alert">{{ error }}</p>
      <button type="button" :disabled="loading" @click="loadMarketplace(cursor)">
        {{ error ? 'Retry marketplace search' : 'Load more MCP servers' }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.connector-directory { max-width: 1192px; margin: 0 auto; padding: 64px 32px 80px; }
.connector-directory header { max-width: 700px; margin-bottom: 30px; }
.connector-directory h1 { font-family: 'Orbitron', sans-serif; font-size: clamp(32px, 6vw, 52px); font-weight: 700; line-height: 1.14; }
.connector-directory header p { margin-top: 14px; color: var(--vp-c-text-2); font-size: 20px; }
.directory-controls { display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between; }
.directory-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.directory-controls button, .directory-pagination button, .directory-controls input {
  border: 1px solid var(--vp-c-border); border-radius: 8px; min-height: 42px; padding: 8px 14px;
  background: var(--vp-c-bg-alt); font-size: 16px;
}
.directory-controls button[aria-pressed="true"] { background: var(--vp-c-brand-soft); border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-2); }
.directory-controls input { width: min(100%, 320px); color: var(--vp-c-text-1); }
.directory-controls :focus-visible, .directory-pagination button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
.directory-status { color: var(--vp-c-text-2); margin: 16px 0 12px; min-height: 24px; }
.directory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 270px), 1fr)); gap: 14px; padding: 0; margin: 0; list-style: none; }
.directory-card { display: flex; flex-direction: column; min-width: 0; gap: 12px; padding: 18px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg-elv); }
.card-heading { display: flex; gap: 11px; align-items: center; }
.card-heading img, .card-initial { flex: 0 0 40px; width: 40px; height: 40px; object-fit: contain; border-radius: 8px; }
.card-initial { display: grid; place-items: center; background: var(--vp-c-brand-soft); color: var(--vp-c-brand-2); font-family: var(--vp-font-family-mono); }
.card-title { min-width: 0; overflow-wrap: anywhere; }
.card-title h2 { font-size: 20px; font-weight: 700; line-height: 1.2; }
.card-namespace { font-size: 12px; color: var(--vp-c-text-2); font-family: var(--vp-font-family-mono); }
.directory-card p { flex: 1; color: var(--vp-c-text-2); line-height: 1.45; overflow-wrap: anywhere; }
.card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: auto; font-size: 14px; color: var(--vp-c-text-2); }
.source-label { padding: 1px 8px; border: 1px solid var(--vp-c-border); border-radius: 6px; }
.source-official { color: var(--vp-c-brand-2); background: var(--vp-c-brand-soft); }
.directory-message, .directory-pagination { padding: 24px 0; text-align: center; color: var(--vp-c-text-2); }
.directory-pagination p { margin-bottom: 10px; }
.directory-pagination button:disabled { opacity: .5; }
@media (max-width: 640px) {
  .connector-directory { padding: 36px 20px 54px; }
  .directory-controls input { width: 100%; }
}
</style>
