import type { DiscoveryCoverage, SearchResult } from "./types.js";
import type { DiscoveryAdapterOptions } from "./discovery-deadline.js";

export interface SearchProvider {
  readonly coverage: DiscoveryCoverage;
  search(
    query: string,
    limit: number,
    options: DiscoveryAdapterOptions
  ): Promise<SearchResult[]>;
}

export class DisabledSearchProvider implements SearchProvider {
  readonly coverage = "authoritative-pages-only" as const;

  async search(
    _query: string,
    _limit: number,
    _options: DiscoveryAdapterOptions
  ): Promise<SearchResult[]> {
    return [];
  }
}
