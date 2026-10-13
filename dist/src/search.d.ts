import type { PathFilter } from './pathfilter.js';
import type { SearchParams, SearchResult } from './types.js';
export declare class SearchService {
    private pathFilter;
    private vaultPath;
    private readonly cacheTtlMs;
    private readonly cacheCapBytes;
    private contentCache;
    private walkCache;
    constructor(vaultPath: string, pathFilter: PathFilter, { cacheTtlMs, cacheCapBytes }?: {
        cacheTtlMs?: number;
        cacheCapBytes?: number;
    });
    /**
     * Drop stale cache entries after a write. Always clears the walk cache so
     * new/deleted files appear on the next search. With a path, evicts only that
     * content entry; without, wipes the entire content cache.
     */
    invalidate(relativePath?: string): void;
    search(params: SearchParams): Promise<SearchResult[]>;
    private getFileContent;
    private _readFile;
    private findMarkdownFiles;
    private _walkMarkdownFiles;
    private rerank;
}
//# sourceMappingURL=search.d.ts.map