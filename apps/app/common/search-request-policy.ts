import type { RunStatus, SearchGrouping, SearchScope, SearchSort } from './unified-history';

export type SearchScopeSelection = 'all' | SearchScope;
export type SearchPeriod = 'any' | '24h' | '7d' | '30d';

/** The operational feed does not contain definition-only corpora such as
 * Views (nor individual tool matches). Consequently even empty/unfiltered
 * global search must use the independently paged search endpoint. */
export function canUseUnifiedHistoryCache(
  query: string,
  scope: SearchScopeSelection,
  statuses: RunStatus[],
  errorsOnly: boolean,
  period: SearchPeriod,
): boolean {
  // Keep the full signature while this beta still shares request-policy code
  // with older clients; none of these combinations is cache-equivalent now.
  void query; void scope; void statuses; void errorsOnly; void period;
  return false;
}

/** Match grouping keeps every internal occurrence independently pageable.
 * Root grouping may return match_count > matches.length with no resolver for
 * the omitted occurrences in this beta client. */
export function searchPresentation(query: string): {
  sort: SearchSort;
  grouping: SearchGrouping;
} {
  return {
    sort: query.trim() ? 'relevance' : 'recent',
    grouping: 'match',
  };
}
