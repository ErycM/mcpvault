import { test, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "./createServer.js";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let testVaultPath: string;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-test-"));
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

test("createServer returns a Server instance", () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  expect(server).toBeDefined();
  expect(typeof server.connect).toBe("function");
});

test("server registers 17 tools", async () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const result = await client.listTools();
  expect(result.tools).toHaveLength(17);

  const toolNames = result.tools.map((t) => t.name).sort();
  expect(toolNames).toEqual([
    "delete_note",
    "get_frontmatter",
    "get_notes_info",
    "get_vault_stats",
    "list_all_tags",
    "list_directory",
    "manage_tags",
    "move_file",
    "move_note",
    "patch_note",
    "read_multiple_notes",
    "read_note",
    "search_notes",
    "semantic_search",
    "update_frontmatter",
    "wiki_link",
    "write_note",
  ]);

  await client.close();
  await server.close();
});

test("server can read and write notes via tools", async () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // Write a note
  await client.callTool({ name: "write_note", arguments: { path: "test.md", content: "# Hello World" } });

  // Read it back
  const result = await client.callTool({ name: "read_note", arguments: { path: "test.md" } });
  const parsed = JSON.parse((result.content as any)[0].text);
  expect(parsed.content).toContain("Hello World");

  await client.close();
  await server.close();
});

test("custom options are applied", () => {
  const server = createServer(testVaultPath, {
    name: "custom-name",
    version: "2.0.0",
  });
  expect(server).toBeDefined();
});

async function connectClient() {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { server, client };
}

test("wiki_link returns isError on invalid syntax (backslash in parsed)", async () => {
  const { server, client } = await connectClient();
  try {
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[Foo\\\\|Bar]]" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as any)[0].text as string;
    expect(text).toMatch(/Invalid wiki-link syntax/);
    expect((result.structuredContent as any).rawInput).toBe("[[Foo\\\\|Bar]]");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link returns isError on zero match with document echo", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Other.md"), "# Other");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "Missing" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as any)[0].text as string;
    expect(text).toContain("Missing");
    expect(text).toContain("search_notes");
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("Missing");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link single match omits alternatives", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Note\n\nbody");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "Note" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("Note");
    expect(sc.path).toBe("Note.md");
    expect("alternatives" in sc).toBe(false);
    expect(sc.ambiguous).toBeUndefined();
    expect(sc.matches).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link multi match resolves first sorted path and lists alternatives", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Root Note");
    await mkdir(join(testVaultPath, "deep"), { recursive: true });
    await writeFile(join(testVaultPath, "deep/Note.md"), "# Deep Note");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[Note]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.path).toBe("Note.md");
    expect(sc.alternatives).toEqual(["deep/Note.md"]);
    expect(sc.ambiguous).toBeUndefined();
    expect(sc.matches).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link unescapes table-authored \\| inside brackets", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "My Document.md"), "# My Document\n\ncontent");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[My Document\\|Displayed]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("My Document");
    expect(sc.path).toBe("My Document.md");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link resolves path-qualified link to the exact file", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Root Note");
    await mkdir(join(testVaultPath, "deep"), { recursive: true });
    await writeFile(join(testVaultPath, "deep/Note.md"), "# Deep Note");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[deep/Note]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("deep/Note");
    expect(sc.path).toBe("deep/Note.md");
    expect("alternatives" in sc).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});

// ============================================================================
// ZBRAG_URL / semantic_search_private tool visibility
// ============================================================================

test('semantic_search_private absent when ZBRAG_URL is not set', async () => {
  const savedZbragUrl = process.env['ZBRAG_URL'];
  delete process.env['ZBRAG_URL'];

  try {
    const server = createServer(testVaultPath, { version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('semantic_search_private');
    await client.close();
    await server.close();
  } finally {
    if (savedZbragUrl !== undefined) process.env['ZBRAG_URL'] = savedZbragUrl;
    else delete process.env['ZBRAG_URL'];
  }
});

test('semantic_search_private present when ZBRAG_URL is set', async () => {
  const savedZbragUrl = process.env['ZBRAG_URL'];
  process.env['ZBRAG_URL'] = 'http://127.0.0.1:9123';

  try {
    const server = createServer(testVaultPath, { version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('semantic_search_private');
    await client.close();
    await server.close();
  } finally {
    if (savedZbragUrl !== undefined) process.env['ZBRAG_URL'] = savedZbragUrl;
    else delete process.env['ZBRAG_URL'];
  }
});

// ============================================================================
// SEARCH CACHE INVALIDATION
// ============================================================================

test("write_note then search_notes finds the new content immediately (TTL=60s)", async () => {
  const { server, client } = await connectClient();
  try {
    // Prime the walk cache with an initial search (no results yet)
    const empty = await client.callTool({ name: "search_notes", arguments: { query: "uniquetoken" } });
    expect(JSON.parse((empty.content as any)[0].text)).toHaveLength(0);

    // Write a note that contains the token
    await client.callTool({
      name: "write_note",
      arguments: { path: "capture.md", content: "# Capture\n\nuniqetoken uniquetoken here." },
    });

    // Search immediately — must find it despite 60 s TTL
    const found = await client.callTool({ name: "search_notes", arguments: { query: "uniquetoken", limit: 5 } });
    const results = JSON.parse((found.content as any)[0].text);
    expect(results.map((r: any) => r.p)).toContain("capture.md");
  } finally {
    await client.close();
    await server.close();
  }
});

test("delete_note then search_notes no longer returns the file", async () => {
  const { server, client } = await connectClient();
  try {
    await client.callTool({
      name: "write_note",
      arguments: { path: "gone.md", content: "# Gone\n\ndeletetoken here." },
    });

    // Confirm it's findable
    const before = await client.callTool({ name: "search_notes", arguments: { query: "deletetoken", limit: 5 } });
    expect(JSON.parse((before.content as any)[0].text).map((r: any) => r.p)).toContain("gone.md");

    // Delete it
    await client.callTool({
      name: "delete_note",
      arguments: { path: "gone.md", confirmPath: "gone.md" },
    });

    // Must not appear in search anymore
    const after = await client.callTool({ name: "search_notes", arguments: { query: "deletetoken", limit: 5 } });
    expect(JSON.parse((after.content as any)[0].text).map((r: any) => r.p)).not.toContain("gone.md");
  } finally {
    await client.close();
    await server.close();
  }
});

test("move_note then search_notes returns the new path", async () => {
  const { server, client } = await connectClient();
  try {
    await client.callTool({
      name: "write_note",
      arguments: { path: "before.md", content: "# Before\n\nmovetoken here." },
    });

    // Prime cache
    await client.callTool({ name: "search_notes", arguments: { query: "movetoken", limit: 5 } });

    // Move it
    await client.callTool({
      name: "move_note",
      arguments: { oldPath: "before.md", newPath: "after.md" },
    });

    // Old path gone, new path visible
    const results = await client.callTool({ name: "search_notes", arguments: { query: "movetoken", limit: 5 } });
    const paths = JSON.parse((results.content as any)[0].text).map((r: any) => r.p);
    expect(paths).not.toContain("before.md");
    expect(paths).toContain("after.md");
  } finally {
    await client.close();
    await server.close();
  }
});
