import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Results are chunks, not pages. One large page fills many slots. Since 2026-10-13,
// the vault uploads pages over 60k chars as one document per section, which crowded
// the top 50. The API maximum is 100 (200 returns HTTP 400).
const RAW_SEARCH_LIMIT = 100;

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

interface SupermemoryHit {
  metadata: {
    path?: string;
    slug?: string;
    [key: string]: unknown;
  };
  similarity?: number;
  [key: string]: unknown;
}

interface SupermemoryApiResponse {
  results?: SupermemoryHit[];
  total?: number;
  timing?: number;
}

interface ZbragHit {
  slug: string;
  path: string;
  src: string;
  score: number;
  snippet?: string;
  redacted?: number;
}

interface ZbragResponse {
  results: ZbragHit[];
  timing: unknown;
  source: string;
  index: string;
}

async function resolveKey(opts?: SemanticSearchOptions): Promise<string> {
  if (opts?.apiKey) return opts.apiKey;

  const envKey = process.env['SUPERMEMORY_API_KEY'];
  if (envKey) return envKey;

  const keyFile =
    process.env['SUPERMEMORY_KEY_FILE'] ??
    join(homedir(), '.config', 'supermemory', 'key');

  try {
    const k = (await readFile(keyFile, 'utf-8')).trim();
    if (k) return k;
  } catch {
    // fall through to error below
  }

  throw new Error('semantic search unavailable: no API key');
}

const DATE_PATTERN = /\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/;

function hasDate(q: string): boolean {
  return DATE_PATTERN.test(q);
}

function stripDates(q: string): string {
  let s = q;
  // Remove connector word immediately preceding a date
  s = s.replace(
    /(^|\s)(entre|between|de|from|desde|since|até|ate|until|to|e|and|a)\s+(?=\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/gi,
    '$1',
  );
  // Remove remaining date patterns
  s = s.replace(/\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

async function post(
  query: string,
  container: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  retryDelayMs: number,
  timeoutMs: number,
): Promise<SupermemoryHit[]> {
  const useRerank = process.env['SUPERMEMORY_RERANK'] === '1';

  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

    let response: Response;
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
          limit: RAW_SEARCH_LIMIT,
          threshold: 0,
          searchMode: 'documents',
          ...(useRerank && { rerank: true }),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (attempt === 0) continue;
      throw new Error(isAbort
        ? 'semantic search unavailable: timeout'
        : 'semantic search unavailable: network error');
    }

    clearTimeout(timer);

    if (!response.ok) {
      if (response.status < 500) {
        throw new Error(`semantic search unavailable: HTTP ${response.status}`);
      }
      if (attempt === 0) continue;
      throw new Error(`semantic search unavailable: HTTP ${response.status}`);
    }

    const data = await response.json() as SupermemoryApiResponse;
    return data.results ?? [];
  }

  throw new Error('semantic search unavailable: unexpected state');
}

async function queryZbrag(
  zbragUrl: string,
  query: string,
  k: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  extraParams?: Record<string, string>,
): Promise<ZbragResponse> {
  const url = new URL(`${zbragUrl}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('k', String(k));
  if (extraParams) {
    for (const [key, val] of Object.entries(extraParams)) {
      url.searchParams.set(key, val);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new Error(isAbort ? 'timeout' : 'network error');
  }

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as ZbragResponse;
  if (!Array.isArray(data.results)) {
    throw new Error('bad response: missing results array');
  }
  return data;
}

export async function semanticSearch(
  query: string,
  limit = 10,
  opts?: SemanticSearchOptions,
): Promise<SemanticSearchResponse> {
  const clampedLimit = Math.max(1, Math.min(20, limit));
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const zbragUrl = opts?.zbragUrl ?? process.env['ZBRAG_URL'];
  const timeoutMs = opts?.timeoutMs ?? Number(process.env['ZBRAG_TIMEOUT_MS'] ?? 4_000);

  const t0 = Date.now();

  if (zbragUrl) {
    try {
      const data = await queryZbrag(zbragUrl, query, clampedLimit, fetchImpl, timeoutMs);
      const seen = new Set<string>();
      const results: SemanticSearchResult[] = [];
      for (const hit of data.results) {
        if (!hit.path || seen.has(hit.path)) continue;
        seen.add(hit.path);
        results.push({ path: hit.path, slug: hit.slug, score: hit.score });
        if (results.length >= clampedLimit) break;
      }
      return { results, fallback: false, latencyMs: Date.now() - t0, source: 'local' };
    } catch (err) {
      const localError = err instanceof Error ? err.message : String(err);
      // Fall through to Supermemory
      const smResult = await supermemorySearch(query, clampedLimit, opts, fetchImpl);
      return { ...smResult, source: 'supermemory', localError };
    }
  }

  const smResult = await supermemorySearch(query, clampedLimit, opts, fetchImpl);
  return { ...smResult, source: 'supermemory' };
}

async function supermemorySearch(
  query: string,
  clampedLimit: number,
  opts: SemanticSearchOptions | undefined,
  fetchImpl: typeof fetch,
): Promise<Omit<SemanticSearchResponse, 'source' | 'localError'>> {
  const apiKey = await resolveKey(opts);
  const container =
    opts?.container ?? process.env['SUPERMEMORY_CONTAINER'] ?? 'vault-wiki';
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

  const seen = new Set<string>();
  const results: SemanticSearchResult[] = [];

  for (const hit of hits) {
    const path = hit.metadata?.path ?? '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    results.push({
      path,
      slug: hit.metadata?.slug ?? '',
      score: hit.similarity ?? 0,
    });
    if (results.length >= clampedLimit) break;
  }

  return { results, fallback, latencyMs: Date.now() - t0 };
}

export async function semanticSearchPrivate(
  query: string,
  limit = 5,
  opts?: Pick<SemanticSearchOptions, 'fetchImpl' | 'timeoutMs' | 'zbragUrl'>,
): Promise<PrivateSearchResponse> {
  const zbragUrl = opts?.zbragUrl ?? process.env['ZBRAG_URL'];
  if (!zbragUrl) {
    throw new Error('private search unavailable: no local index on this host');
  }

  const clampedLimit = Math.max(1, Math.min(10, limit));
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? Number(process.env['ZBRAG_PRIVATE_TIMEOUT_MS'] ?? 8_000);

  const t0 = Date.now();

  const data = await queryZbrag(zbragUrl, query, clampedLimit, fetchImpl, timeoutMs, {
    private: 'only',
    snippets: '1',
  });

  const results: PrivateSearchResult[] = data.results
    .slice(0, clampedLimit)
    .map((hit) => {
      const r: PrivateSearchResult = {
        path: hit.path,
        slug: hit.slug,
        score: hit.score,
        snippet: hit.snippet ?? '',
      };
      if (hit.redacted !== undefined) r.redacted = hit.redacted;
      return r;
    });

  return { results, latencyMs: Date.now() - t0, index: data.index };
}
