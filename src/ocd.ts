import { Command } from "commander";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import clipboardy from "clipboardy";

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
  let exitCode = 0;
  try {
    const client = await resolveClient();
    await listSessions(client);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("error:", msg);
    exitCode = 1;
  } finally {
    closeSpawnedServer();
  }
  process.exit(exitCode);
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

// ── Context assembly (task 6) ──────────────────────────────────────────

/**
 * Build prompt parts (file content / folder listing / clipboard / question)
 * in the exact order: clipboard (if paste=true) → file/folder (if path) → question.
 * Returns `TextPartInput[]` — plain-text context parts for the prompt body.
 */
export function assembleParts(
  path: string | undefined,
  question: string,
  paste: boolean,
): TextPartInput[] {
  if (!question) {
    throw new Error("question is required");
  }

  const parts: TextPartInput[] = [];

  // 1. Clipboard (if paste=true)
  if (paste) {
    try {
      const clipText = clipboardy.readSync();
      if (clipText && clipText.trim().length > 0) {
        parts.push({
          type: "text",
          text: `--- Clipboard ---\n${clipText}`,
        });
      } else {
        console.error("warning: clipboard is empty, skipping");
      }
    } catch {
      console.error("warning: clipboard is empty, skipping");
    }
  }

  // 2. File or folder (if path provided)
  if (path) {
    try {
      const stat = statSync(path);
      if (stat.isFile()) {
        const content = readFileSync(path, "utf-8");
        if (content.includes("\0")) {
          console.error("cannot read binary file: " + path);
          throw new Error("cannot read binary file: " + path);
        }
        parts.push({
          type: "text",
          text: `--- File: ${path} ---\n${content}`,
        });
      } else if (stat.isDirectory()) {
        const entries = readdirSync(path);
        parts.push({
          type: "text",
          text: `--- Folder: ${path} ---\n${entries.join("\n")}`,
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("cannot read binary file")) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error("path not found: " + path + (msg ? ` (${msg})` : ""));
    }
  }

  // 3. Question (always last)
  parts.push({ type: "text", text: question });

  return parts;
}

// ── Streaming output (task 7) ─────────────────────────────────────────

/**
 * Send a prompt via `promptAsync` and stream the answer to stdout in real
 * time via SSE events. Falls back to batch `prompt()` if promptAsync is
 * unavailable.
 */
export async function streamResponse(
  client: OpencodeClient,
  sessionID: string,
  parts: TextPartInput[],
): Promise<void> {
  // 1. Send prompt (fire-and-forget via promptAsync)
  let useBatchFallback = false;
  try {
    const result = await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts },
    });
    if (result.error) {
      throw new Error(String(result.error));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warning: promptAsync unavailable (${msg}), using batch mode`);
    useBatchFallback = true;
  }

  // 2. Batch fallback — block until complete, then print assistant text
  if (useBatchFallback) {
    const result = await client.session.prompt({
      path: { id: sessionID },
      body: { parts },
    });
    if (result.error) {
      throw new Error(`prompt failed: ${String(result.error)}`);
    }
    if (result.data) {
      for (const part of result.data.parts) {
        if (part.type === "text" && part.synthetic !== true && part.ignored !== true) {
          process.stdout.write(part.text);
        }
      }
    }
    process.stdout.write("\n");
    return;
  }

  // 3. SSE streaming — subscribe globally, filter by our sessionID.
  // User message parts arrive first (no delta, no synthetic flag); assistant
  // parts arrive after with growing `.text`. Use messageID tracking: skip
  // parts from the first messageID (the user's own echo), emit diff text
  // from subsequent messageIDs.
  const sub = await client.event.subscribe();
  const seenText = new Map<string, string>(); // partID → previously seen text
  let userMessageID: string | undefined;

  try {
    for await (const event of sub.stream) {
      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.sessionID !== sessionID) break;

          if (part.type === "text") {
            // First text part we see belongs to the user message — skip it
            if (userMessageID === undefined) {
              userMessageID = part.messageID;
            }
            if (part.messageID === userMessageID) break;

            const prev = seenText.get(part.id) ?? "";
            if (part.text.startsWith(prev)) {
              const diff = part.text.slice(prev.length);
              if (diff) process.stdout.write(diff);
              seenText.set(part.id, part.text);
            } else {
              // Non-contiguous update — emit full text
              process.stdout.write(part.text);
              seenText.set(part.id, part.text);
            }
          } else if (part.type === "tool") {
            process.stderr.write(`[tool: ${part.tool}...]\n`);
          }
          break;
        }
        case "session.status": {
          const props = event.properties;
          if (props.sessionID === sessionID && props.status.type === "idle") {
            process.stdout.write("\n");
            return;
          }
          break;
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`stream error: ${msg}`);
  }

  // Stream ended without idle — flush
  process.stdout.write("\n");
}

// ── Main ───────────────────────────────────────────────────────────────

let exitCode = 0;
try {
  const client = await resolveClient();

  if (question) {
    const sessionID = opts.session
      ? await resolveSession(client, opts.session)
      : await client.session.create({ body: {} }).then((r) => {
          if (r.error) throw new Error(`failed to create session: ${String(r.error)}`);
          return r.data!.id;
        });

    const parts = assembleParts(path, question, opts.paste);
    await streamResponse(client, sessionID, parts);
  } else if (opts.session) {
    // Resolve session for future use (ensure it exists)
    await resolveSession(client, opts.session);
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("error:", msg);
  exitCode = 1;
} finally {
  closeSpawnedServer();
}

process.exit(exitCode);
