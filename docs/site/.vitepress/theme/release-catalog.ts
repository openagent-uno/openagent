/** Public release discovery; components share one catalogue, never a fixed tag. */
export const REPOSITORY = "openagent-uno/openagent";
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export type Target = "desktop" | "server" | "cli";
export type Asset = { name: string; browser_download_url: string; size: number };
export type Release = { tag_name: string; published_at: string; prerelease: boolean; draft: boolean; assets: Asset[] };
export type Match = { release: Release; assets: Asset[] };

function version(tag: string, target: Target) {
  const prefix = target === "desktop" ? "app-v" : "v";
  if (!tag.startsWith(prefix)) return null;
  const value = tag.slice(prefix.length);
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return parsed ? { value, numbers: parsed.slice(1, 4).map(Number), pre: parsed[4]?.split(".") ?? [] } : null;
}

function compareTags(left: Release, right: Release, target: Target): number {
  const a = version(left.tag_name, target)!, b = version(right.tag_name, target)!;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) return Number(a.pre[i]) - Number(b.pre[i]);
    if (an !== bn) return an ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return Date.parse(left.published_at) - Date.parse(right.published_at);
}

export function platform(name: string): string | null {
  if (/(?:^|[-_.])(macos|darwin|mac)(?:[-_.]|$)/i.test(name)) return "macOS";
  if (/(?:^|[-_.])(windows|win32|win)(?:[-_.]|$)/i.test(name)) return "Windows";
  if (/(?:^|[-_.])linux(?:[-_.]|$)/i.test(name)) return "Linux";
  return null;
}

function releaseAssets(release: Release, target: Target): Asset[] {
  const value = version(release.tag_name, target)!.value;
  const wheel = value.replace(/-alpha\./, "a").replace(/-beta\./, "b").replace(/-rc\./, "rc");
  const prefix = target === "desktop" ? `openagent-app-${value}-`
    : `${target === "server" ? "openagent_framework" : "openagent_cli"}-${wheel}-`;
  return release.assets.filter(asset => asset.name.startsWith(prefix)
    && asset.browser_download_url.startsWith(`https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/`)
    && (target === "desktop" ? platform(asset.name) && /\.(dmg|pkg|exe|msi|AppImage|deb|rpm|zip|tar\.gz)$/i.test(asset.name)
      : asset.name.endsWith("-py3-none-any.whl")));
}

export function latestMatch(releases: Release[], target: Target): Match | null {
  const candidates = releases.filter(r => !r.draft && version(r.tag_name, target) && releaseAssets(r, target).length);
  candidates.sort((a, b) => compareTags(b, a, target));
  const release = candidates[0];
  if (!release) return null;
  // Never fill a partial release with platform binaries from older versions.
  const assets = releaseAssets(release, target);
  assets.sort((a, b) => (platform(a.name) ?? "").localeCompare(platform(b.name) ?? "") || a.name.localeCompare(b.name));
  return { release, assets };
}

export function releaseUrl(release: Release) {
  return `${RELEASES_URL}/tag/${release.tag_name}`;
}

export function assetLabel(asset: Asset, target: Target) {
  if (target !== "desktop") return `${target === "server" ? "Server" : "CLI"} · Python wheel (all platforms)`;
  const os = platform(asset.name);
  const arm = /arm64|aarch64/i.test(asset.name), intel = /x64|amd64|x86_64/i.test(asset.name);
  const arch = arm ? os === "macOS" ? "Apple Silicon" : "ARM64" : intel ? os === "macOS" ? "Intel" : "x64" : "Universal";
  const format = /\.tar\.gz$/i.test(asset.name) ? "tar.gz" : asset.name.split(".").at(-1);
  return `${os} · ${arch} · ${format}`;
}

export async function fetchCatalogue(request: typeof fetch = fetch): Promise<Release[]> {
  const releases: Release[] = [];
  // Follow pagination through the complete catalogue: publication order can
  // differ from version order and unrelated components share this repository.
  for (let page = 1; page <= 20; page++) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await request(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("Invalid release catalogue");
      for (const item of body) {
        if (typeof item?.tag_name !== "string" || !Array.isArray(item.assets) || item.draft !== false) continue;
        releases.push({ ...item, assets: item.assets.filter((a: Asset) => typeof a?.name === "string"
          && typeof a.browser_download_url === "string" && Number.isFinite(a.size) && a.size >= 0) });
      }
      if (!/<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "")) return releases;
    } finally { clearTimeout(deadline); }
  }
  throw new Error("Release catalogue pagination limit reached");
}
