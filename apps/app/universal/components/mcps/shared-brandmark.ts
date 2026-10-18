// The shared SDK distributes one finite vector profile. Remote references,
// scripts, style, extra attributes and arbitrary SVG trees are never rendered.
export function safeSharedBrandmark(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32768) return undefined;
  const matched = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"><path fill="#[0-9A-F]{6}" d="[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE.,+ -]*"\/><\/svg>$/.exec(value);
  return matched && matched[0].length === value.length ? value : undefined;
}

export function safeConnectorSetupUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search) return undefined;
    return url.href;
  } catch { return undefined; }
}
