import { Command } from "commander";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

// ── Named-session store ────────────────────────────────────────────────

const SESSIONS_DIR = nodePath.join(homedir(), ".ocd");
const SESSIONS_FILE = nodePath.join(SESSIONS_DIR, "sessions.json");

type SessionMapping = Record<string, string>;

function readMapping(): SessionMapping {
  try {
    if (!existsSync(SESSIONS_FILE)) return {};
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new SyntaxError("not a JSON object");
    }
    return parsed as SessionMapping;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      console.error("warning: sessions.json is corrupt, reinitializing");
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`warning: cannot read sessions.json (${msg}), reinitializing`);
    }
    return {};
  }
}

function writeMapping(mapping: SessionMapping): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmp = SESSIONS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(mapping, null, 2), "utf-8");
  renameSync(tmp, SESSIONS_FILE);
}

/**
 * Resolve a named session to a session ID.
 * - If name starts with `ses_` → return as-is (direct session ID).
 * - If name exists in mapping and the session still exists → return its ID.
 * - If name is stale or missing → create a new session, save mapping, return new ID.
 */
export async function resolveSession(
  client: OpencodeClient,
  name: string,
): Promise<string> {
  // Direct session ID passthrough — do NOT touch the mapping
  if (name.startsWith("ses_")) {
    return name;
  }

  const mapping = readMapping();

  // Check if name exists in mapping
  if (mapping[name] !== undefined) {
    const result = await client.session.get({
      path: { id: mapping[name] },
    });
    if (!result.error) {
      return mapping[name]; // session still exists
    }
    // Stale entry — remove and fall through to create
    delete mapping[name];
    writeMapping(mapping);
  }

  // Create a new session
  const result = await client.session.create({
    body: { title: name },
  });
  if (result.error) {
    throw new Error(
      `failed to create session "${name}": ${String(result.error)}`,
    );
  }
  const id = result.data!.id;

  mapping[name] = id;
  writeMapping(mapping);
  return id;
}

/**
 * List all named sessions from the JSON store with their details (title,
 * message count, last-updated time). Prints a table to stdout.
 */
export async function listSessions(client: OpencodeClient): Promise<void> {
  const mapping = readMapping();
  const entries = Object.entries(mapping).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  if (entries.length === 0) {
    console.log("No named sessions.");
    return;
  }

  const rows: Array<{
    NAME: string;
    "SESSION ID": string;
    MESSAGES: string;
    UPDATED: string;
  }> = [];

  for (const [name, id] of entries) {
    let messages = "err";
    let updated = "err";

    try {
      const getResult = await client.session.get({ path: { id } });
      if (!getResult.error && getResult.data) {
        updated = new Date(getResult.data.time.updated).toLocaleString();

        const msgResult = await client.session.messages({ path: { id } });
        if (!msgResult.error && msgResult.data) {
          messages = String(msgResult.data.length);
        }
      }
    } catch {
      // leave as "err"
    }

    rows.push({
      NAME: name,
      "SESSION ID": id,
      MESSAGES: messages,
      UPDATED: updated,
    });
  }

  console.table(rows);
}

// ── Client resolution (task 4) ──────────────────────────────────────────

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

// ── --list-sessions takes precedence over everything else ──────────────

if (opts.listSessions) {
  try {
    const client = await resolveClient();
    await listSessions(client);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("error:", msg);
    process.exit(1);
  } finally {
    closeSpawnedServer();
  }
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

// ── Client resolution (task 4) + session wiring (task 5) ─────────────

try {
  const client = await resolveClient();
  if (opts.session) {
    const sid = await resolveSession(client, opts.session);
    console.log(`session=${sid}`);
  } else {
    console.log("client=ok");
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("error:", msg);
  process.exit(1);
} finally {
  closeSpawnedServer();
}

process.exit(0);
