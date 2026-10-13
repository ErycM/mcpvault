import { join, resolve } from 'path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { generateObsidianUri } from './uri.js';
/** Normalize a subtree path: forward slashes, no leading/trailing slashes. */
function normalizeSubtree(p) {
    return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
/** True if a vault-relative path is the subtree itself or sits under it. */
function isUnderSubtree(relativePath, subtree) {
    if (!subtree)
        return false;
    return relativePath === subtree || relativePath.startsWith(subtree + '/');
}
export class SearchService {
    pathFilter;
    vaultPath;
    cacheTtlMs;
    cacheCapBytes;
    contentCache = new Map();
    walkCache = null;
    constructor(vaultPath, pathFilter, { cacheTtlMs = 60_000, cacheCapBytes = 64 * 1024 * 1024 } = {}) {
        this.pathFilter = pathFilter;
        this.vaultPath = resolve(vaultPath);
        this.cacheTtlMs = cacheTtlMs;
        this.cacheCapBytes = cacheCapBytes;
    }
    /**
     * Drop stale cache entries after a write. Always clears the walk cache so
     * new/deleted files appear on the next search. With a path, evicts only that
     * content entry; without, wipes the entire content cache.
     */
    invalidate(relativePath) {
        this.walkCache = null;
        if (relativePath === undefined) {
            this.contentCache.clear();
        }
        else {
            this.contentCache.delete(relativePath);
        }
    }
    async search(params) {
        const { query, limit = 5, searchContent = true, searchFrontmatter = false, caseSensitive = false, pathPrefix, excludePaths } = params;
        if (!query || query.trim().length === 0) {
            throw new Error('Search query cannot be empty');
        }
        const normalizedPrefix = pathPrefix ? normalizeSubtree(pathPrefix) : '';
        const normalizedExcludes = (excludePaths || []).map(normalizeSubtree).filter(Boolean);
        const maxLimit = Math.min(limit, 20);
        // Corpus stats for reranking
        let totalDocLength = 0;
        let docCount = 0;
        const termDocFreq = new Map();
        const candidates = [];
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        const terms = searchQuery.split(/\s+/).filter(t => t.length > 0);
        const scoringTerms = terms.length > 1 ? [...terms, searchQuery] : terms;
        // Directory walk (cached for cacheTtlMs)
        const markdownFiles = await this.findMarkdownFiles(this.vaultPath);
        // Prune content cache entries for files no longer on disk
        const prefixLen = this.vaultPath.length + 1;
        const walkSet = new Set();
        for (const fp of markdownFiles) {
            walkSet.add(fp.substring(prefixLen).replace(/\\/g, '/'));
        }
        for (const key of this.contentCache.keys()) {
            if (!walkSet.has(key))
                this.contentCache.delete(key);
        }
        // Pre-filter by pathFilter before I/O
        const allowedFiles = [];
        for (const fullPath of markdownFiles) {
            const relativePath = fullPath.substring(prefixLen).replace(/\\/g, '/');
            if (!this.pathFilter.isAllowed(relativePath))
                continue;
            if (normalizedPrefix && !isUnderSubtree(relativePath, normalizedPrefix))
                continue;
            if (normalizedExcludes.some(ex => isUnderSubtree(relativePath, ex)))
                continue;
            allowedFiles.push({ fullPath, relativePath });
        }
        // Process files with bounded concurrency (3 I/O ops at once keeps ≥1 libuv thread free)
        let fileIdx = 0;
        const worker = async () => {
            while (fileIdx < allowedFiles.length) {
                const i = fileIdx++;
                const { fullPath, relativePath } = allowedFiles[i];
                const content = await this.getFileContent(fullPath, relativePath);
                if (content === null)
                    continue;
                let searchableText = '';
                if (searchContent && searchFrontmatter) {
                    searchableText = content;
                }
                else if (searchContent) {
                    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
                    searchableText = fm ? content.slice(fm[0].length) : content;
                }
                else if (searchFrontmatter) {
                    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
                    searchableText = fm ? fm[1] || '' : '';
                }
                const searchIn = caseSensitive ? searchableText : searchableText.toLowerCase();
                const docLength = searchIn.split(/\s+/).filter(w => w.length > 0).length;
                totalDocLength += docLength;
                docCount++;
                for (const term of scoringTerms) {
                    if (searchIn.includes(term)) {
                        termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
                    }
                }
                const title = relativePath.split('/').pop()?.replace(/\.md$/, '') || relativePath;
                const filenameToSearch = caseSensitive ? title : title.toLowerCase();
                const filenameMatch = terms.some(term => filenameToSearch.includes(term));
                const termIndices = terms.map(term => searchIn.indexOf(term));
                const anyTermFound = termIndices.some(idx => idx !== -1);
                const firstIndex = anyTermFound
                    ? Math.min(...termIndices.filter(idx => idx !== -1))
                    : -1;
                if (firstIndex !== -1 || filenameMatch) {
                    let excerpt;
                    let matchCount = 0;
                    let lineNumber = 0;
                    const termFreqs = new Map();
                    if (firstIndex !== -1) {
                        const firstTermIdx = termIndices.indexOf(firstIndex);
                        const firstTerm = terms[firstTermIdx];
                        const excerptStart = Math.max(0, firstIndex - 21);
                        const excerptEnd = Math.min(searchableText.length, firstIndex + firstTerm.length + 21);
                        excerpt = searchableText.slice(excerptStart, excerptEnd).trim();
                        if (excerptStart > 0)
                            excerpt = '...' + excerpt;
                        if (excerptEnd < searchableText.length)
                            excerpt = excerpt + '...';
                        for (const term of scoringTerms) {
                            let count = 0;
                            let idx = 0;
                            while ((idx = searchIn.indexOf(term, idx)) !== -1) {
                                count++;
                                idx += term.length;
                            }
                            termFreqs.set(term, count);
                            matchCount += count;
                        }
                        const lines = searchableText.slice(0, firstIndex).split('\n');
                        lineNumber = lines.length;
                    }
                    else {
                        excerpt = searchableText.slice(0, 50).trim();
                        if (searchableText.length > 50)
                            excerpt = excerpt + '...';
                        matchCount = 0;
                        lineNumber = 0;
                    }
                    if (filenameMatch)
                        matchCount++;
                    candidates.push({
                        result: {
                            p: relativePath,
                            t: title,
                            ex: excerpt,
                            mc: matchCount,
                            ln: lineNumber,
                            uri: generateObsidianUri(this.vaultPath, relativePath)
                        },
                        termFreqs,
                        docLength
                    });
                }
            }
        };
        const workerCount = Math.min(3, allowedFiles.length);
        if (workerCount > 0) {
            await Promise.all(Array.from({ length: workerCount }, () => worker()));
        }
        return this.rerank(candidates, scoringTerms, termDocFreq, docCount, totalDocLength, maxLimit);
    }
    async getFileContent(fullPath, relativePath) {
        const now = Date.now();
        const cached = this.contentCache.get(relativePath);
        // Within TTL: return cached content with no I/O at all
        if (cached && now - cached.checkedAt < this.cacheTtlMs) {
            return cached.content;
        }
        // Stat to check freshness
        let fileStat;
        try {
            fileStat = await stat(fullPath);
        }
        catch {
            return null;
        }
        const { mtimeMs, size } = fileStat;
        // Unchanged: refresh checkedAt only, no read
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
            this.contentCache.set(relativePath, { ...cached, checkedAt: now });
            return cached.content;
        }
        // File is new or changed: read it
        let content;
        try {
            content = await this._readFile(fullPath);
        }
        catch {
            return null;
        }
        // Cache if within cap (sum of string lengths)
        let currentSize = 0;
        for (const entry of this.contentCache.values()) {
            currentSize += entry.content.length;
        }
        if (currentSize + content.length <= this.cacheCapBytes) {
            this.contentCache.set(relativePath, { mtimeMs, size, content, checkedAt: now });
        }
        return content;
    }
    // Thin wrapper so tests can spy on actual disk reads without intercepting ESM named imports
    async _readFile(path) {
        return readFile(path, 'utf-8');
    }
    async findMarkdownFiles(dirPath) {
        const now = Date.now();
        if (this.walkCache && now - this.walkCache.cachedAt < this.cacheTtlMs) {
            return this.walkCache.files;
        }
        const files = await this._walkMarkdownFiles(dirPath);
        this.walkCache = { files, cachedAt: now };
        return files;
    }
    async _walkMarkdownFiles(dirPath) {
        const markdownFiles = [];
        try {
            const entries = await readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    const subFiles = await this._walkMarkdownFiles(fullPath);
                    markdownFiles.push(...subFiles);
                }
                else if (entry.isFile() && entry.name.endsWith('.md')) {
                    markdownFiles.push(fullPath);
                }
            }
        }
        catch {
            // Skip unreadable directories
        }
        return markdownFiles;
    }
    rerank(candidates, terms, termDocFreq, docCount, totalDocLength, maxLimit) {
        const avgdl = docCount > 0 ? totalDocLength / docCount : 1;
        const k1 = 1.2;
        const b = 0.75;
        const scored = candidates.map(c => {
            let score = 0;
            for (const term of terms) {
                const tf = c.termFreqs.get(term) || 0;
                const df = termDocFreq.get(term) || 0;
                const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
                score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * c.docLength / avgdl));
            }
            return { score, result: c.result };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxLimit).map(s => s.result);
    }
}
