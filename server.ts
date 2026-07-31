#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/createServer.js";
import { PathFilter } from "./src/pathfilter.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const VERSION = packageJson.version;

// Handle --version and --help flags
const cliArgs = process.argv.slice(2);
const firstArg = cliArgs[0];

if (firstArg === "--version" || firstArg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (firstArg === "--help" || firstArg === "-h") {
  console.log(`
mcpvault v${VERSION}

Universal AI bridge for Obsidian vaults - connect any MCP-compatible assistant

Usage:
  npx @bitbonsai/mcpvault [vault-path] [--allowed-extensions=ext1,ext2,...]

Arguments:
  [vault-path]    Optional path to your Obsidian vault directory
                  Defaults to current working directory when omitted

Options:
  --version, -v             Show version number
  --help, -h                Show this help message
  --allowed-extensions=...  Comma-separated list of additional file extensions to
                            permit on read/write operations (e.g. ".html,.csv,.json").
                            Always additive to the built-in defaults
                            (.md, .markdown, .txt, .base, .canvas). Leading dot is
                            optional. Extensions outside this combined list are
                            rejected by the PathFilter.

Examples:
  npx @bitbonsai/mcpvault
  npx @bitbonsai/mcpvault ~/Documents/MyVault
  npx @bitbonsai/mcpvault ./Vault --allowed-extensions=.html,.csv,.json,.yaml,.yml,.svg,.toml
  npx @bitbonsai/mcpvault "/path/with spaces/Obsidian Vault"
`);
  process.exit(0);
}

// Extract --allowed-extensions=<csv> (single value, may appear at any position).
// Leading dots are optional in user input; we normalize so the PathFilter sees
// canonical `.ext` form. Empty entries from trailing commas are dropped.
const ALLOWED_EXT_PREFIX = "--allowed-extensions=";
const allowedExtRaw = cliArgs.find((a) => a.startsWith(ALLOWED_EXT_PREFIX));
const allowedExtensions = allowedExtRaw
  ? allowedExtRaw
      .slice(ALLOWED_EXT_PREFIX.length)
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
      .map((e) => (e.startsWith(".") ? e : `.${e}`))
  : undefined;

const pathArgs = cliArgs.filter((a) => !a.startsWith(ALLOWED_EXT_PREFIX));

// Join trailing args to support vault paths with spaces.
// When omitted, default to current working directory.
const vaultPathArg = pathArgs.join(" ").trim();
const vaultPath = resolve(vaultPathArg || process.cwd());

// Inject a PathFilter carrying the extra extensions. Upstream's PathFilter merges
// them additively onto its built-in allowlist, so createServer needs no change.
const pathFilter = allowedExtensions
  ? new PathFilter({ allowedExtensions })
  : undefined;

const server = createServer(vaultPath, {
  version: VERSION,
  ...(pathFilter && { pathFilter }),
});
const transport = new StdioServerTransport();
await server.connect(transport);

// Exit when the client disconnects (stdin EOF) or the process is asked to
// terminate. Hosts that don't send an MCP shutdown request otherwise leave
// this process running forever, orphaned once stdin closes (#159).
let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    await server.close();
  } catch {
    // Best-effort: exit regardless of transport close errors.
  }
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
