export type Evidence = {
  id: string;
  url: string;
  sourceUrl: string;
  title: string;
  fact: string;
  checkedAt: string;
  confidence: number;
};

export type CompanySearchQuery = {
  batch?: string;
  industry?: string;
  status?: string;
  location?: string;
  keyword?: string;
  hiring?: boolean;
};

export type CompanyResult = {
  id: string;
  ycId: string;
  name: string;
  batch?: string;
  status?: string;
  location?: string;
  industry?: string;
  description?: string;
  hiring?: boolean;
  websiteUrl?: string;
  checkedAt: string;
  sources: Evidence[];
  warnings: SourceWarning[];
};

export type PersonWithEvidence = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  publicProfileUrl?: string;
  checkedAt: string;
  confidence: number;
  evidence: Evidence[];
};

export type DiscoveryCoverage = "authoritative-pages-only" | "search-extended";

export type SourceWarning = {
  code?: "source-failed" | "source-changed" | "budget-exhausted" | "invalid-data" | "stale-source";
  sourceUrl: string;
  message: string;
};

export type DiscoveryResult = {
  people: PersonWithEvidence[];
  evidence: Evidence[];
  checkedAt: string;
  coverage: DiscoveryCoverage;
  warnings: SourceWarning[];
};

export type Opportunity = {
  id: string;
  companyId: string;
  title: string;
  location?: string;
  sourceUrl: string;
  checkedAt: string;
  active: boolean;
};

export type OpportunitySearchResult = {
  opportunities: Opportunity[];
  warnings: SourceWarning[];
  checkedAt: string;
};

export type CareerPreferences = {
  roleKeywords: string[];
  preferredLocations: string[];
  industries: string[];
};

export type DiscoveryBudgets = {
  maxOfficialPagesPerCompany: number;
  maxSearchResultsPerCompany: number;
  maxTotalRequestsPerCompany: number;
  maxElapsedMsPerCompany: number;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  checkedAt: string;
};
