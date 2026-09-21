<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type Release = {
  tag_name: string;
  html_url: string;
  published_at: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
};

type ReleaseMatch = {
  release: Release;
  assets: ReleaseAsset[];
};

type Target = "server" | "cli" | "desktop";

const props = defineProps<{ target?: Target }>();

const repoPath = "openagent-uno/openagent";
const releasesUrl = computed(
  () => `https://api.github.com/repos/${repoPath}/releases?per_page=30`,
);
const allReleasesUrl = computed(
  () => `https://github.com/${repoPath}/releases`,
);

const loading = ref(true);
const error = ref("");
const releases = ref<Release[]>([]);

function isServerAsset(name: string) {
  return /^openagent_framework-\d+\.\d+\.\d+(?:[a-z]+\d+)?-py3-none-any\.whl$/i.test(name);
}

function isCliAsset(name: string) {
  return /^openagent_cli-\d+\.\d+\.\d+(?:[a-z]+\d+)?-py3-none-any\.whl$/i.test(name);
}

function isMacDesktopAsset(name: string) {
  return /\.dmg$/i.test(name) && !/blockmap/i.test(name);
}

function isWindowsDesktopAsset(name: string) {
  return /\.(exe|msi)$/i.test(name) && !/blockmap/i.test(name);
}

function isLinuxDesktopAsset(name: string) {
  return /\.(AppImage|deb|rpm)$/i.test(name) && !/blockmap/i.test(name);
}

function formatSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function archLabel(name: string): string {
  const isMac = /\b(macos|mac|darwin)\b/i.test(name);
  if (/arm64/i.test(name)) {
    return isMac ? " (Apple Silicon)" : " (ARM64)";
  }
  if (/x64|amd64/i.test(name) && !/arm/i.test(name)) {
    return isMac ? " (Intel)" : " (64-bit)";
  }
  if (/universal/i.test(name)) return " (Universal)";
  return "";
}

function assetLabel(name: string) {
  const arch = archLabel(name);
  if (isServerAsset(name)) return "Server · Python wheel";
  if (isCliAsset(name)) return "CLI · Python wheel";
  if (/\.dmg$/i.test(name)) return `macOS${arch}`;
  if (/\.exe$/i.test(name)) return `Windows${arch}`;
  if (/\.msi$/i.test(name)) return `Windows MSI${arch}`;
  if (/\.AppImage$/i.test(name)) return `Linux AppImage${arch}`;
  if (/\.deb$/i.test(name)) return `Linux .deb${arch}`;
  if (/\.rpm$/i.test(name)) return `Linux .rpm${arch}`;
  return name;
}

function assetPriority(name: string) {
  if (/macos.*\.pkg$/i.test(name)) return -1;
  if (/\.dmg$/i.test(name)) return 0;
  if (/\.exe$/i.test(name)) return 0;
  if (/\.AppImage$/i.test(name)) return 0;
  if (/\.tar\.gz$/i.test(name)) return 1;
  if (/\.zip$/i.test(name)) return 1;
  if (/\.msi$/i.test(name)) return 2;
  if (/\.deb$/i.test(name)) return 2;
  if (/\.rpm$/i.test(name)) return 3;
  return 9;
}

function findLatestMatch(
  matcher: (asset: ReleaseAsset) => boolean,
): ReleaseMatch | null {
  for (const release of publishedReleases.value) {
    const assets = release.assets
      .filter(matcher)
      .sort((left, right) => assetPriority(left.name) - assetPriority(right.name));
    if (assets.length) {
      return { release, assets };
    }
  }
  return null;
}

const publishedReleases = computed(() =>
  releases.value.filter((release) => !release.draft),
);

const serverDownload = computed(() =>
  findLatestMatch((asset) => isServerAsset(asset.name)),
);

const cliDownload = computed(() =>
  findLatestMatch((asset) => isCliAsset(asset.name)),
);

const desktopAssets = computed<ReleaseMatch | null>(() => {
  return findLatestMatch(
    (asset) =>
      isMacDesktopAsset(asset.name) ||
      isWindowsDesktopAsset(asset.name) ||
      isLinuxDesktopAsset(asset.name),
  );
});

onMounted(async () => {
  try {
    const response = await fetch(releasesUrl.value, {
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    releases.value = (await response.json()) as Release[];
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : "Unable to load release metadata.";
  } finally {
    loading.value = false;
  }
});

const activeMatch = computed<ReleaseMatch | null>(() => {
  if (props.target === "server") return serverDownload.value;
  if (props.target === "cli") return cliDownload.value;
  if (props.target === "desktop") return desktopAssets.value;
  return null;
});
</script>

<template>
  <div class="downloads-inline">
    <div v-if="loading" class="downloads-inline-state">
      <span class="oa-loading-dot"></span>
      Loading latest release…
    </div>

    <div v-else-if="error" class="downloads-inline-state">
      Release lookup failed.
      <a :href="allReleasesUrl">Browse all releases</a>
    </div>

    <template v-else-if="activeMatch">
      <div class="downloads-inline-release">
        <a :href="activeMatch.release.html_url">{{ activeMatch.release.tag_name }}</a>
        <span v-if="activeMatch.release.prerelease" class="downloads-inline-badge">Beta</span>
      </div>
      <a
        v-for="asset in activeMatch.assets"
        :key="asset.browser_download_url"
        class="download-chip"
        :href="asset.browser_download_url"
      >
        <span class="download-chip-label">{{ assetLabel(asset.name) }}</span>
        <span class="download-chip-size">{{ formatSize(asset.size) }}</span>
      </a>
    </template>

    <div v-else class="downloads-inline-state">
      No recent build. <a :href="allReleasesUrl">Browse all releases</a>.
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
