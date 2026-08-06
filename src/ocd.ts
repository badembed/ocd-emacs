import { Command } from "commander";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import nodePath from "node:path";

// Module-level handle for auto-spawned server — closed on exit.
let spawnedServer: { close(): void } | undefined;

/** Close the auto-spawned OpenCode server if one was started. */
export function closeSpawnedServer(): void {
  if (spawnedServer) {
    spawnedServer.close();
    spawnedServer = undefined;
  }
}

/**
 * Resolve an OpenCode client following env-based discovery:
 * 1. OCD_SERVER_URL  → connect to existing server
 * 2. OPENCODE_BIN_PATH → prepend dir to PATH, auto-spawn
 * 3. Neither set     → auto-spawn via PATH
 */
export async function resolveClient(): Promise<OpencodeClient> {
  // 1. OCD_SERVER_URL — connect to an existing server
  const serverUrl = process.env.OCD_SERVER_URL;
  if (serverUrl) {
    const client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: process.cwd(),
    });
    try {
      await client.session.list();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cannot connect to OpenCode server at ${serverUrl}: ${msg}`,
      );
    }
    return client;
  }

  // 2. OPENCODE_BIN_PATH — use a specific binary
  const binPath = process.env.OPENCODE_BIN_PATH;
  if (binPath) {
    if (!existsSync(binPath)) {
      throw new Error(
        `OPENCODE_BIN_PATH points to a non-existent binary: ${binPath}`,
      );
    }
    const binDir = nodePath.dirname(binPath);
    process.env.PATH =
      binDir + nodePath.delimiter + (process.env.PATH ?? "");
  }

  // 3. Auto-spawn (default)
  try {
    const result = await createOpencode();
    spawnedServer = result.server;
    await result.client.session.list();
    return result.client;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot auto-spawn OpenCode server: ${msg}`);
  }
}

// ── CLI skeleton (task 3 — preserved exactly) ─────────────────────────

const program = new Command();

program
  .name("ocd")
  .description("CLI wrapper for OpenCode Agent SDK")
  .argument("[path]", "file or folder to include as context")
  .argument("[question]", "question to ask")
  .option("-p, --paste", "include clipboard content")
  .option("-s, --session <name>", "named session to use or create")
  .option("--list-sessions", "list named sessions");

program.parse();

const opts = program.opts();
const args: string[] = program.args;

// --list-sessions takes precedence over everything else
if (opts.listSessions) {
  console.log("list=true");
  process.exit(0);
}

// Disambiguation: commander assigns positional args in order,
// but when only one is present it is the question, not the path.
let path: string | undefined;
let question: string | undefined;

if (args.length >= 2) {
  path = args[0];
  question = args[1];
} else if (args.length === 1) {
  question = args[0];
} else {
  // No positional arguments — show help
  program.help();
}

// path / question bound for future tasks (task 6 context assembly).
void path;
void question;

// ── Client resolution (task 4) ────────────────────────────────────────

try {
  await resolveClient();
  console.log("client=ok");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("error:", msg);
  process.exit(1);
} finally {
  closeSpawnedServer();
}

process.exit(0);
