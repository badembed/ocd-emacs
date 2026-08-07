import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { formatSdkError } from "./errors";

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
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const tmp = SESSIONS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(mapping, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmp, SESSIONS_FILE);
  try {
    chmodSync(SESSIONS_FILE, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
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
  if (name.startsWith("ses_")) {
    return name;
  }

  const mapping = readMapping();

  if (mapping[name] !== undefined) {
    const result = await client.session.get({
      path: { id: mapping[name] },
    });
    if (!result.error) {
      return mapping[name];
    }
    delete mapping[name];
    writeMapping(mapping);
  }

  const result = await client.session.create({
    body: { title: name },
  });
  if (result.error) {
    throw new Error(
      `failed to create session "${name}": ${formatSdkError(result.error)}`,
    );
  }
  const id = result.data!.id;

  mapping[name] = id;
  writeMapping(mapping);
  return id;
}

/**
 * List all named sessions from the JSON store with their details.
 * Prints a table to stdout.
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
