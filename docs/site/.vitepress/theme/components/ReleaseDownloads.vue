<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { assetLabel, latestMatch, platform, releaseUrl, RELEASES_URL, type Target } from "../release-catalog";
import { useReleaseCatalogue } from "../use-release-catalog";

const props = defineProps<{ target?: Target }>();
const target = computed(() => props.target ?? "server");
const { releases, loading, error, load } = useReleaseCatalogue();
const activeMatch = computed(() => latestMatch(releases.value, target.value));
const missingPlatforms = computed(() => target.value === "desktop" && activeMatch.value
  ? ["macOS", "Windows", "Linux"].filter(os => !activeMatch.value!.assets.some(asset => platform(asset.name) === os)) : []);
function formatSize(size: number) {
  if (size >= 1024 ** 3) return `${(size / (1024 ** 3)).toFixed(2)} GB`;
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}
const refresh = () => { if (!document.hidden) void load(); };
onMounted(() => {
  void load();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
});
onUnmounted(() => {
  window.removeEventListener("focus", refresh);
  document.removeEventListener("visibilitychange", refresh);
});
</script>

<template>
  <div class="downloads-inline" :data-download-target="target" aria-live="polite">
    <noscript><a :href="RELEASES_URL">Browse published downloads on GitHub</a></noscript>
    <div v-if="loading" class="downloads-inline-state">
      <span class="oa-loading-dot"></span>
      Loading latest release…
    </div>

    <div v-else-if="error" class="downloads-inline-state">
      {{ error }}
      <button type="button" @click="load(true)">Try again</button>
      <a :href="RELEASES_URL">Browse all releases</a>
    </div>

    <template v-else-if="activeMatch">
      <div class="downloads-inline-release">
        <a :href="releaseUrl(activeMatch.release)">{{ activeMatch.release.tag_name }}</a>
        <span v-if="activeMatch.release.prerelease" class="downloads-inline-badge">Beta</span>
      </div>
      <a
        v-for="asset in activeMatch.assets"
        :key="asset.browser_download_url"
        class="download-chip"
        :href="asset.browser_download_url"
      >
        <span class="download-chip-label">{{ assetLabel(asset, target) }}</span>
        <span class="download-chip-size">{{ formatSize(asset.size) }}</span>
      </a>
      <p v-if="!activeMatch.assets.length" class="downloads-inline-state">No downloads have been published for this release yet.</p>
      <p v-if="missingPlatforms.length" class="downloads-inline-state">Not published for this release: {{ missingPlatforms.join(", ") }}.</p>
    </template>

    <div v-else class="downloads-inline-state">
      No published release found. <a :href="RELEASES_URL">Browse all releases</a>.
    </div>
  </div>
</template>

<style scoped>
.oa-loading-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  margin-right: 8px;
  animation: oa-pulse 1.4s ease-in-out infinite;
  vertical-align: middle;
}

.downloads-inline-release {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 8px;
  font-size: 13px;
}

.downloads-inline-badge {
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 999px;
  color: var(--vp-c-brand-1);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1;
  padding: 4px 7px;
  text-transform: uppercase;
}

@keyframes oa-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}
</style>
