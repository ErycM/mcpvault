export interface SemanticSearchResult {
    path: string;
    slug: string;
    score: number;
}
export interface SemanticSearchResponse {
    results: SemanticSearchResult[];
    fallback: boolean;
    latencyMs: number;
}
export interface SemanticSearchOptions {
    fetchImpl?: typeof fetch;
    apiKey?: string;
    container?: string;
}
export declare function semanticSearch(query: string, limit?: number, opts?: SemanticSearchOptions): Promise<SemanticSearchResponse>;
//# sourceMappingURL=semantic.d.ts.map