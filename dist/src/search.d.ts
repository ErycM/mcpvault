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
    search(params: SearchParams): Promise<SearchResult[]>;
    private getFileContent;
    private _readFile;
    private findMarkdownFiles;
    private _walkMarkdownFiles;
    private rerank;
}
//# sourceMappingURL=search.d.ts.map