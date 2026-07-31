import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { FileSystemService } from "./filesystem.js";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let vault: string;
let fs: FileSystemService;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "mcpvault-appendonly-"));
  fs = new FileSystemService(vault);
});

afterEach(async () => {
  try { await rm(vault, { recursive: true }); } catch { /* ignore */ }
});

describe("log.md append-only guard", () => {
  test("refuses whole-file overwrite of log.md", async () => {
    await writeFile(join(vault, "log.md"), "existing entry\n");
    await expect(
      fs.writeNote({ path: "log.md", content: "clobber", mode: "overwrite" })
    ).rejects.toThrow(/Refused overwrite of append-only file/);
    // original content is untouched
    expect(await readFile(join(vault, "log.md"), "utf-8")).toBe("existing entry\n");
  });

  test("append to log.md is allowed and additive", async () => {
    await writeFile(join(vault, "log.md"), "line1\n");
    await fs.writeNote({ path: "log.md", content: "line2\n", mode: "append" });
    const out = await readFile(join(vault, "log.md"), "utf-8");
    expect(out).toContain("line1");
    expect(out).toContain("line2");
  });

  test("a normal note is still overwritable", async () => {
    await writeFile(join(vault, "note.md"), "old\n");
    await fs.writeNote({ path: "note.md", content: "new", mode: "overwrite" });
    expect(await readFile(join(vault, "note.md"), "utf-8")).toContain("new");
  });

  test("concurrent appends to the same file do not clobber (per-path lock)", async () => {
    await writeFile(join(vault, "log.md"), "");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fs.writeNote({ path: "log.md", content: `entry-${i}\n`, mode: "append" })
      )
    );
    const out = await readFile(join(vault, "log.md"), "utf-8");
    for (let i = 0; i < 8; i++) expect(out).toContain(`entry-${i}`);
  });
});
