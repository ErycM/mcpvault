import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
async function resolveKey(opts) {
    if (opts?.apiKey)
        return opts.apiKey;
    const envKey = process.env['SUPERMEMORY_API_KEY'];
    if (envKey)
        return envKey;
    const keyFile = process.env['SUPERMEMORY_KEY_FILE'] ??
        join(homedir(), '.config', 'supermemory', 'key');
    try {
        const k = (await readFile(keyFile, 'utf-8')).trim();
        if (k)
            return k;
    }
    catch {
        // fall through to error below
    }
    throw new Error('semantic search unavailable: no API key');
}
const DATE_PATTERN = /\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/;
function hasDate(q) {
    return DATE_PATTERN.test(q);
}
function stripDates(q) {
    let s = q;
    // Remove connector word immediately preceding a date
    s = s.replace(/(^|\s)(entre|between|de|from|desde|since|até|ate|until|to|e|and|a)\s+(?=\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/gi, '$1');
    // Remove remaining date patterns
    s = s.replace(/\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}
async function post(query, container, apiKey, fetchImpl, retryDelayMs, timeoutMs) {
    const useRerank = process.env['SUPERMEMORY_RERANK'] === '1';
    for (let attempt = 0; attempt <= 1; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
        let response;
        try {
            response = await fetchImpl('https://api.supermemory.ai/v4/search', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    q: query,
                    containerTag: container,
                    limit: 50,
                    threshold: 0,
                    searchMode: 'documents',
                    ...(useRerank && { rerank: true }),
                }),
                signal: controller.signal,
            });
        }
        catch (err) {
            clearTimeout(timer);
            const isAbort = err instanceof Error && err.name === 'AbortError';
            if (attempt === 0)
                continue;
            throw new Error(isAbort
                ? 'semantic search unavailable: timeout'
                : 'semantic search unavailable: network error');
        }
        clearTimeout(timer);
        if (!response.ok) {
            if (response.status < 500) {
                throw new Error(`semantic search unavailable: HTTP ${response.status}`);
            }
            if (attempt === 0)
                continue;
            throw new Error(`semantic search unavailable: HTTP ${response.status}`);
        }
        const data = await response.json();
        return data.results ?? [];
    }
    throw new Error('semantic search unavailable: unexpected state');
}
export async function semanticSearch(query, limit = 10, opts) {
    const apiKey = await resolveKey(opts);
    const container = opts?.container ?? process.env['SUPERMEMORY_CONTAINER'] ?? 'vault-wiki';
    const clampedLimit = Math.max(1, Math.min(20, limit));
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const retryDelayMs = opts?.retryDelayMs ?? 500;
    const timeoutMs = opts?.timeoutMs ?? 8_000;
    const t0 = Date.now();
    let hits = await post(query, container, apiKey, fetchImpl, retryDelayMs, timeoutMs);
    let fallback = false;
    if (hits.length === 0 && hasDate(query)) {
        const clean = stripDates(query);
        if (clean.length > 0) {
            hits = await post(clean, container, apiKey, fetchImpl, retryDelayMs, timeoutMs);
            fallback = true;
        }
    }
    const seen = new Set();
    const results = [];
    for (const hit of hits) {
        const path = hit.metadata?.path ?? '';
        if (!path || seen.has(path))
            continue;
        seen.add(path);
        results.push({
            path,
            slug: hit.metadata?.slug ?? '',
            score: hit.similarity ?? 0,
        });
        if (results.length >= clampedLimit)
            break;
    }
    return { results, fallback, latencyMs: Date.now() - t0 };
}
