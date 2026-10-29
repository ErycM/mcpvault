export interface SemanticSearchResult {
    path: string;
    slug: string;
    score: number;
}
export interface SemanticSearchResponse {
    results: SemanticSearchResult[];
    fallback: boolean;
    latencyMs: number;
    source: 'local' | 'supermemory';
    localError?: string;
}
export interface SemanticSearchOptions {
    fetchImpl?: typeof fetch;
    apiKey?: string;
    container?: string;
    retryDelayMs?: number;
    timeoutMs?: number;
    zbragUrl?: string;
}
export interface PrivateSearchResult {
    path: string;
    slug: string;
    score: number;
    snippet: string;
    redacted?: number;
}
export interface PrivateSearchResponse {
    results: PrivateSearchResult[];
    latencyMs: number;
    index: string;
}
export declare function semanticSearch(query: string, limit?: number, opts?: SemanticSearchOptions): Promise<SemanticSearchResponse>;
export declare function semanticSearchPrivate(query: string, limit?: number, opts?: Pick<SemanticSearchOptions, 'fetchImpl' | 'timeoutMs' | 'zbragUrl'>): Promise<PrivateSearchResponse>;
//# sourceMappingURL=semantic.d.ts.map