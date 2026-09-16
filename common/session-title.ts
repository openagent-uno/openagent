const DEFAULT_SESSION_TITLES = new Set(['new chat', 'new conversation']);

export function isAutomaticSessionTitle(title: string, sessionId?: string): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  if (sessionId && normalized === sessionId) return true;
  if (DEFAULT_SESSION_TITLES.has(normalized.toLowerCase())) return true;
  return /^\/[a-z][\w-]*(?:\s|$)/i.test(normalized);
}

export function sessionTitleFromPrompt(prompt: string, maxLength = 60): string | undefined {
  let title = prompt.replace(/\s+/g, ' ').trim();
  if (!title || /^\/[a-z][\w-]*(?:\s|$)/i.test(title)) return undefined;
  title = title.replace(/^(?:[-*#>]\s*)+/, '').replace(/[`*_~]/g, '').trim();
  if (!title) return undefined;
  if (title.length > maxLength) {
    const candidate = title.slice(0, maxLength + 1);
    const boundary = candidate.lastIndexOf(' ');
    title = candidate.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength).trimEnd();
  }
  return title.replace(/[.!?,;:]+$/u, '') || undefined;
}
