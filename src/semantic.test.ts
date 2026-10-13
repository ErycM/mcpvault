import { test, expect, beforeEach, afterEach } from 'vitest';
import { semanticSearch } from './semantic.js';

function makeHit(path: string, score = 0.8) {
  return {
    metadata: { path, slug: path.split('/').pop()?.replace('.md', '') ?? '' },
    similarity: score,
  };
}

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function makeFetch(hits: unknown[], status = 200) {
  return async (_url: string, _init?: RequestInit): Promise<FakeResponse> => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ results: hits, total: hits.length }),
  });
}

let savedApiKey: string | undefined;
let savedKeyFile: string | undefined;
let savedRerank: string | undefined;

beforeEach(() => {
  savedApiKey = process.env['SUPERMEMORY_API_KEY'];
  savedKeyFile = process.env['SUPERMEMORY_KEY_FILE'];
  savedRerank = process.env['SUPERMEMORY_RERANK'];
  delete process.env['SUPERMEMORY_API_KEY'];
  delete process.env['SUPERMEMORY_RERANK'];
  process.env['SUPERMEMORY_KEY_FILE'] = '/tmp/nonexistent-sm-key-for-tests';
});

afterEach(() => {
  if (savedApiKey !== undefined) {
    process.env['SUPERMEMORY_API_KEY'] = savedApiKey;
  } else {
    delete process.env['SUPERMEMORY_API_KEY'];
  }
  if (savedKeyFile !== undefined) {
    process.env['SUPERMEMORY_KEY_FILE'] = savedKeyFile;
  } else {
    delete process.env['SUPERMEMORY_KEY_FILE'];
  }
  if (savedRerank !== undefined) {
    process.env['SUPERMEMORY_RERANK'] = savedRerank;
  } else {
    delete process.env['SUPERMEMORY_RERANK'];
  }
});

test('deduplicates results by path and respects limit', async () => {
  const fetchImpl = makeFetch([
    makeHit('wiki/a.md', 0.9),
    makeHit('wiki/a.md', 0.8), // duplicate
    makeHit('wiki/b.md', 0.7),
    makeHit('wiki/c.md', 0.6),
  ]);

  const result = await semanticSearch('test query', 2, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
  });

  expect(result.results).toHaveLength(2);
  expect(result.results[0]?.path).toBe('wiki/a.md');
  expect(result.results[1]?.path).toBe('wiki/b.md');
  expect(result.fallback).toBe(false);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});

test('date fallback makes exactly two calls and sets fallback: true', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    if (callCount === 1) {
      return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [makeHit('wiki/a.md')], total: 1 }),
    };
  };

  const result = await semanticSearch('notícias entre 2026-09-01 e 2026-09-30', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
  });

  expect(callCount).toBe(2);
  expect(result.fallback).toBe(true);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/a.md');
});

test('no fallback when first call returns results even if query has date', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [makeHit('wiki/a.md')], total: 1 }),
    };
  };

  const result = await semanticSearch('notes from 2026-01-01', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
  });

  expect(callCount).toBe(1);
  expect(result.fallback).toBe(false);
  expect(result.results).toHaveLength(1);
});

test('missing key throws error starting with "semantic search unavailable:" not containing the fake key', async () => {
  const FAKE_KEY = 'should-not-appear-in-error-messages-xyz987';

  let caughtError: Error | undefined;
  try {
    await semanticSearch('test', 5);
  } catch (err) {
    caughtError = err as Error;
  }

  expect(caughtError).toBeDefined();
  expect(caughtError?.message).toMatch(/^semantic search unavailable:/);
  expect(caughtError?.message).not.toContain(FAKE_KEY);
});

test('HTTP 500 throws error starting with "semantic search unavailable:" not containing the key', async () => {
  const FAKE_KEY = 'super-secret-api-key-value-must-not-leak';

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });

  let caughtError: Error | undefined;
  try {
    await semanticSearch('test', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: FAKE_KEY,
      retryDelayMs: 0,
    });
  } catch (err) {
    caughtError = err as Error;
  }

  expect(caughtError).toBeDefined();
  expect(caughtError?.message).toMatch(/^semantic search unavailable:/);
  expect(caughtError?.message).not.toContain(FAKE_KEY);
});

test('body has no rerank field by default', async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const fetchImpl = async (_url: string, init?: RequestInit): Promise<FakeResponse> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
  };

  await semanticSearch('test query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    retryDelayMs: 0,
  });

  expect(capturedBody).toBeDefined();
  expect(capturedBody?.['rerank']).toBeUndefined();
});

test('body includes rerank: true when SUPERMEMORY_RERANK=1', async () => {
  process.env['SUPERMEMORY_RERANK'] = '1';
  let capturedBody: Record<string, unknown> | undefined;

  const fetchImpl = async (_url: string, init?: RequestInit): Promise<FakeResponse> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
  };

  await semanticSearch('test query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    retryDelayMs: 0,
  });

  expect(capturedBody?.['rerank']).toBe(true);
});

test('500 then 200 -> success with exactly 2 fetch calls', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    if (callCount === 1) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [makeHit('wiki/a.md')], total: 1 }) };
  };

  const result = await semanticSearch('test query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    retryDelayMs: 0,
  });

  expect(callCount).toBe(2);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/a.md');
});

test('402 -> throws with exactly 1 fetch call', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    return { ok: false, status: 402, json: async () => ({}) };
  };

  let caughtError: Error | undefined;
  try {
    await semanticSearch('test query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      retryDelayMs: 0,
    });
  } catch (err) {
    caughtError = err as Error;
  }

  expect(callCount).toBe(1);
  expect(caughtError?.message).toBe('semantic search unavailable: HTTP 402');
});

test('AbortError then 200 -> success with exactly 2 fetch calls', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    if (callCount === 1) {
      const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      throw err;
    }
    return { ok: true, status: 200, json: async () => ({ results: [makeHit('wiki/b.md')], total: 1 }) };
  };

  const result = await semanticSearch('test query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    retryDelayMs: 0,
  });

  expect(callCount).toBe(2);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/b.md');
});

test('two 500s -> throws after exactly 2 fetch calls', async () => {
  let callCount = 0;

  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    return { ok: false, status: 500, json: async () => ({}) };
  };

  let caughtError: Error | undefined;
  try {
    await semanticSearch('test query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      retryDelayMs: 0,
    });
  } catch (err) {
    caughtError = err as Error;
  }

  expect(callCount).toBe(2);
  expect(caughtError?.message).toMatch(/^semantic search unavailable:/);
});
