import type { DiscoveryCoverage, SearchResult } from "./types.js";

export interface SearchProvider {
  readonly coverage: DiscoveryCoverage;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export class DisabledSearchProvider implements SearchProvider {
  readonly coverage = "authoritative-pages-only" as const;

  async search(_query: string, _limit: number): Promise<SearchResult[]> {
    return [];
  }
}
