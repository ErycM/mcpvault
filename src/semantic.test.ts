import { test, expect, beforeEach, afterEach } from 'vitest';
import { semanticSearch, semanticSearchPrivate } from './semantic.js';

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
let savedZbragUrl: string | undefined;

beforeEach(() => {
  savedApiKey = process.env['SUPERMEMORY_API_KEY'];
  savedKeyFile = process.env['SUPERMEMORY_KEY_FILE'];
  savedRerank = process.env['SUPERMEMORY_RERANK'];
  savedZbragUrl = process.env['ZBRAG_URL'];
  delete process.env['SUPERMEMORY_API_KEY'];
  delete process.env['SUPERMEMORY_RERANK'];
  delete process.env['ZBRAG_URL'];
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
  if (savedZbragUrl !== undefined) {
    process.env['ZBRAG_URL'] = savedZbragUrl;
  } else {
    delete process.env['ZBRAG_URL'];
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

test('body has raw search limit of 100', async () => {
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

  expect(capturedBody?.['limit']).toBe(100);
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

test('both attempts hang until aborted -> rejects with timeout after exactly 2 attempts', async () => {
  let callCount = 0;

  const fetchImpl = (_url: string, init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });
  };

  let caughtError: Error | undefined;
  try {
    await semanticSearch('test query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      retryDelayMs: 0,
      timeoutMs: 50,
    });
  } catch (err) {
    caughtError = err as Error;
  }

  expect(callCount).toBe(2);
  expect(caughtError?.message).toBe('semantic search unavailable: timeout');
});

test('first attempt hangs until aborted then fast 200 -> success', async () => {
  let callCount = 0;

  const fetchImpl = (_url: string, init?: RequestInit): Promise<FakeResponse> => {
    callCount++;
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ results: [makeHit('wiki/a.md')], total: 1 }),
    });
  };

  const result = await semanticSearch('test query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    retryDelayMs: 0,
    timeoutMs: 50,
  });

  expect(callCount).toBe(2);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/a.md');
  expect(result.source).toBe('supermemory');
});

// ============================================================================
// Local zbrag index tests
// ============================================================================

function makeZbragHit(path: string, score = 0.5, slug?: string) {
  return { slug: slug ?? path.split('/').pop()?.replace('.md', '') ?? '', path, src: 'wiki', score };
}

function makeZbragFetch(hits: unknown[], status = 200) {
  return async (_url: string, _init?: RequestInit): Promise<FakeResponse> => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ results: hits, timing: {}, source: 'local', index: '2026-10-01T00:00:00Z' }),
  });
}

test('local success: returns source=local, fallback=false, no localError', async () => {
  const fetchImpl = makeZbragFetch([makeZbragHit('wiki/a.md', 0.9)]);

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'primary',
  });

  expect(result.source).toBe('local');
  expect(result.fallback).toBe(false);
  expect(result.localError).toBeUndefined();
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/a.md');
});

test('local failure -> Supermemory fallback with localError', async () => {
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    if (url.includes('127.0.0.1')) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [makeHit('wiki/b.md')], total: 1 }) };
  };

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
    apiKey: 'test-key',
    zbragWiki: 'primary',
  });

  expect(result.source).toBe('supermemory');
  expect(typeof result.localError).toBe('string');
  expect(result.localError).toMatch(/HTTP 503/);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/b.md');
});

test('no ZBRAG_URL: uses Supermemory, source=supermemory, no localError', async () => {
  const fetchImpl = makeFetch([makeHit('wiki/c.md', 0.7)]);

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
  });

  expect(result.source).toBe('supermemory');
  expect(result.localError).toBeUndefined();
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe('wiki/c.md');
});

test('local success with no Supermemory key: succeeds without key lookup', async () => {
  const fetchImpl = makeZbragFetch([makeZbragHit('wiki/d.md', 0.8)]);

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'primary',
  });

  expect(result.source).toBe('local');
  expect(result.results).toHaveLength(1);
});

// ============================================================================
// ZBRAG_WIKI mode tests
// ============================================================================

test('zbragWiki=primary: zbrag succeeds -> source=local, no supermemoryError', async () => {
  const fetchImpl = makeZbragFetch([makeZbragHit('wiki/p.md', 0.9)]);

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'primary',
  });

  expect(result.source).toBe('local');
  expect(result.supermemoryError).toBeUndefined();
  expect(result.results[0]?.path).toBe('wiki/p.md');
});

test('zbragWiki=fallback: SM succeeds -> source=supermemory, no supermemoryError', async () => {
  const fetchImpl = makeFetch([makeHit('wiki/sm.md', 0.8)]);

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'fallback',
  });

  expect(result.source).toBe('supermemory');
  expect(result.supermemoryError).toBeUndefined();
  expect(result.results[0]?.path).toBe('wiki/sm.md');
});

test('zbragWiki=fallback: SM error -> zbrag fallback with supermemoryError', async () => {
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    if (url.includes('supermemory.ai')) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [makeZbragHit('wiki/local.md', 0.7)], timing: {}, source: 'local', index: 'idx' }),
    };
  };

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'fallback',
    retryDelayMs: 0,
  });

  expect(result.source).toBe('local');
  expect(typeof result.supermemoryError).toBe('string');
  expect(result.supermemoryError).toMatch(/HTTP 503/);
  expect(result.results[0]?.path).toBe('wiki/local.md');
});

test('zbragWiki=fallback: both fail -> rethrows SM error', async () => {
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    if (url.includes('supermemory.ai')) {
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };

  let caughtError: Error | undefined;
  try {
    await semanticSearch('query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      zbragUrl: 'http://127.0.0.1:9123',
      zbragWiki: 'fallback',
      retryDelayMs: 0,
    });
  } catch (err) {
    caughtError = err as Error;
  }

  expect(caughtError).toBeDefined();
  expect(caughtError?.message).toMatch(/HTTP 502/);
});

test('zbragWiki=fallback: SM returns zero results -> no zbrag fallback', async () => {
  let zbragCalled = false;
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    if (url.includes('127.0.0.1')) {
      zbragCalled = true;
    }
    return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
  };

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'fallback',
  });

  expect(zbragCalled).toBe(false);
  expect(result.source).toBe('supermemory');
  expect(result.results).toHaveLength(0);
  expect(result.supermemoryError).toBeUndefined();
});

test('zbragWiki=off: never calls zbrag even when zbragUrl set', async () => {
  let zbragCalled = false;
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    if (url.includes('127.0.0.1')) {
      zbragCalled = true;
    }
    return { ok: true, status: 200, json: async () => ({ results: [makeHit('wiki/off.md')], total: 1 }) };
  };

  const result = await semanticSearch('query', 5, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: 'test-key',
    zbragUrl: 'http://127.0.0.1:9123',
    zbragWiki: 'off',
  });

  expect(zbragCalled).toBe(false);
  expect(result.source).toBe('supermemory');
  expect(result.results[0]?.path).toBe('wiki/off.md');
});

// ============================================================================
// semanticSearchPrivate tests
// ============================================================================

function makePrivateFetch(hits: unknown[], status = 200, capturedUrls?: string[]) {
  return async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    capturedUrls?.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ results: hits, timing: {}, source: 'local', index: '2026-10-01T00:00:00Z' }),
    };
  };
}

test('private without ZBRAG_URL throws', async () => {
  delete process.env['ZBRAG_URL'];
  await expect(semanticSearchPrivate('query')).rejects.toThrow(
    'private search unavailable: no local index on this host',
  );
});

test('private sends private=only&snippets=1', async () => {
  const capturedUrls: string[] = [];
  const hit = { ...makeZbragHit('wiki/work/meeting.md', 0.7), snippet: 'redacted text', redacted: 1 };
  const fetchImpl = makePrivateFetch([hit], 200, capturedUrls);

  const result = await semanticSearchPrivate('query', 3, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
  });

  expect(capturedUrls).toHaveLength(1);
  const url = new URL(capturedUrls[0]!);
  expect(url.searchParams.get('private')).toBe('only');
  expect(url.searchParams.get('snippets')).toBe('1');
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.snippet).toBe('redacted text');
  expect(result.results[0]?.redacted).toBe(1);
  expect(result.index).toBe('2026-10-01T00:00:00Z');
});

test('private clamps limit to 10', async () => {
  const capturedUrls: string[] = [];
  const fetchImpl = makePrivateFetch([], 200, capturedUrls);

  await semanticSearchPrivate('query', 99, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    zbragUrl: 'http://127.0.0.1:9123',
  });

  const url = new URL(capturedUrls[0]!);
  expect(Number(url.searchParams.get('k'))).toBe(10);
});

test('private never calls api.supermemory.ai even when zbrag fails', async () => {
  const calledUrls: string[] = [];
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<FakeResponse> => {
    calledUrls.push(url);
    throw new Error('network error');
  };

  await expect(
    semanticSearchPrivate('query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      zbragUrl: 'http://127.0.0.1:9123',
    }),
  ).rejects.toThrow();

  expect(calledUrls.every((u) => !u.includes('supermemory.ai'))).toBe(true);
});

test('private reads ZBRAG_PRIVATE_TIMEOUT_MS, not ZBRAG_TIMEOUT_MS', async () => {
  const prev = { priv: process.env['ZBRAG_PRIVATE_TIMEOUT_MS'], pub: process.env['ZBRAG_TIMEOUT_MS'] };
  process.env['ZBRAG_PRIVATE_TIMEOUT_MS'] = '1';
  process.env['ZBRAG_TIMEOUT_MS'] = '60000';

  let aborted = false;
  const fetchImpl = (_url: string, init?: RequestInit): Promise<FakeResponse> =>
    new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });

  const t0 = Date.now();
  await expect(
    semanticSearchPrivate('query', 5, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      zbragUrl: 'http://127.0.0.1:9123',
    }),
  ).rejects.toThrow();
  const elapsed = Date.now() - t0;

  if (prev.priv === undefined) delete process.env['ZBRAG_PRIVATE_TIMEOUT_MS'];
  else process.env['ZBRAG_PRIVATE_TIMEOUT_MS'] = prev.priv;
  if (prev.pub === undefined) delete process.env['ZBRAG_TIMEOUT_MS'];
  else process.env['ZBRAG_TIMEOUT_MS'] = prev.pub;

  expect(aborted).toBe(true);
  expect(elapsed).toBeLessThan(500);
});
