import { createInterface } from "node:readline";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { formatSdkError } from "./errors";

export type PermissionMode = "interactive" | "auto" | "reject" | "jsonl";
export type PermissionResponse = "once" | "always" | "reject";

export type PermissionInfo = {
  id: string;
  type: string;
  title: string;
  sessionID: string;
  pattern?: string | Array<string>;
};

export type WaitPermissionReply = (
  id: string,
  signal?: AbortSignal,
) => Promise<PermissionResponse>;

/**
 * Normalize SSE permission payloads.
 * Newer OpenCode: permission.asked
 *   { id, sessionID, permission, patterns?, metadata?, always?, tool? }
 * SDK 1.18 types: permission.updated
 *   { id, sessionID, type, title, pattern? }
 */
export function normalizePermissionEvent(
  type: string,
  properties: unknown,
): PermissionInfo | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const p = properties as Record<string, unknown>;
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : undefined;
  const id = typeof p.id === "string" ? p.id : undefined;
  if (!sessionID || !id) return undefined;

  if (type === "permission.asked") {
    const permType =
      typeof p.permission === "string" ? p.permission : "unknown";
    const patterns = p.patterns;
    const meta =
      typeof p.metadata === "object" && p.metadata !== null
        ? (p.metadata as Record<string, unknown>)
        : {};
    const command =
      typeof meta.command === "string"
        ? meta.command
        : typeof meta.path === "string"
          ? meta.path
          : undefined;
    const title = command
      ? `${permType}: ${command}`
      : Array.isArray(patterns) && patterns.length > 0
        ? `${permType}: ${patterns.map(String).join(", ")}`
        : permType;
    return {
      id,
      sessionID,
      type: permType,
      title,
      pattern: Array.isArray(patterns)
        ? patterns.map(String)
        : typeof patterns === "string"
          ? patterns
          : undefined,
    };
  }

  if (type === "permission.updated") {
    const permType = typeof p.type === "string" ? p.type : "unknown";
    const title = typeof p.title === "string" ? p.title : permType;
    return {
      id,
      sessionID,
      type: permType,
      title,
      pattern:
        typeof p.pattern === "string" || Array.isArray(p.pattern)
          ? (p.pattern as string | string[])
          : undefined,
    };
  }

  return undefined;
}

/**
 * Resolve how ocd should answer OpenCode permission prompts.
 * --auto / OCD_AUTO → auto; --jsonl → jsonl; TTY → interactive; else reject.
 */
export function resolvePermissionMode(opts: {
  autoFlag?: boolean;
  jsonlFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean | null;
}): PermissionMode {
  const env = opts.env ?? process.env;
  const autoEnv = env.OCD_AUTO === "1" || env.OCD_AUTO === "true";
  if (opts.autoFlag === true || autoEnv) return "auto";
  if (opts.jsonlFlag === true) return "jsonl";
  const tty =
    opts.stdinIsTTY !== undefined && opts.stdinIsTTY !== null
      ? opts.stdinIsTTY
      : Boolean(process.stdin.isTTY);
  if (tty) return "interactive";
  return "reject";
}

export function isPermissionResponse(
  value: unknown,
): value is PermissionResponse {
  return value === "once" || value === "always" || value === "reject";
}

/**
 * Parse a stdin control line for JSONL permission replies.
 * Returns undefined when the line is not a permission_reply object.
 */
export function parsePermissionReply(
  line: string,
): { id: string; response: PermissionResponse } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "permission_reply") return undefined;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  if (!id) {
    process.stderr.write(
      "warning: permission_reply missing id, ignoring\n",
    );
    return undefined;
  }
  if (!isPermissionResponse(obj.response)) {
    process.stderr.write(
      `warning: permission_reply for ${id} has invalid response, rejecting\n`,
    );
    return { id, response: "reject" };
  }
  return { id, response: obj.response };
}

/** Emit a JSONL permission ask on stdout for machine clients. */
export function writePermissionJsonl(perm: PermissionInfo): void {
  const patterns =
    perm.pattern === undefined
      ? undefined
      : Array.isArray(perm.pattern)
        ? perm.pattern
        : [perm.pattern];
  const event: Record<string, unknown> = {
    type: "permission",
    id: perm.id,
    permission: perm.type,
    title: perm.title,
  };
  if (patterns !== undefined && patterns.length > 0) {
    event.patterns = patterns;
  }
  process.stdout.write(JSON.stringify(event) + "\n");
}

export async function replyPermission(
  client: OpencodeClient,
  sessionID: string,
  permissionID: string,
  response: PermissionResponse,
): Promise<void> {
  const result = await client.postSessionIdPermissionsPermissionId({
    path: { id: sessionID, permissionID },
    body: { response },
  });
  if (result.error) {
    throw new Error(
      `permission reply failed: ${formatSdkError(result.error)}`,
    );
  }
}

/** Parse one interactive permission answer line. */
export function parsePermissionAnswer(
  line: string,
): PermissionResponse | "retry" {
  const key = line.trim().toLowerCase();
  if (key === "" || key === "y" || key === "yes") return "once";
  if (key === "a" || key === "always") return "always";
  if (key === "n" || key === "no" || key === "reject") return "reject";
  return "retry";
}

function writePermissionPrompt(perm: PermissionInfo, retry: boolean): void {
  const pattern =
    perm.pattern === undefined
      ? ""
      : Array.isArray(perm.pattern)
        ? perm.pattern.join(", ")
        : perm.pattern;
  process.stderr.write(
    `[permission] ${perm.type}\n` +
      `  ${perm.title}\n` +
      (pattern ? `  pattern: ${pattern}\n` : "") +
      (retry ? `  invalid input, try again\n` : "") +
      `  [y] once  [a] always  [n] reject\n` +
      `> `,
  );
}

/**
 * Ask on stderr; read answers via `readLine` (stream demux) or a private
 * readline (one-shot). y/Enter → once, a → always, n → reject.
 */
export async function promptPermission(
  perm: PermissionInfo,
  signal?: AbortSignal,
  readLine?: () => Promise<string>,
): Promise<PermissionResponse> {
  if (signal?.aborted) {
    throw new Error("aborted");
  }

  if (readLine) {
    writePermissionPrompt(perm, false);
    let attempts = 0;
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      let line: string;
      try {
        line = await readLine();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "aborted" || signal?.aborted) {
          throw err instanceof Error ? err : new Error(msg);
        }
        throw err instanceof Error ? err : new Error(msg);
      }
      const parsed = parsePermissionAnswer(line);
      if (parsed !== "retry") return parsed;
      attempts += 1;
      if (attempts >= 2) {
        process.stderr.write("  giving up, rejecting\n");
        return "reject";
      }
      writePermissionPrompt(perm, true);
    }
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    writePermissionPrompt(perm, false);

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: Boolean(process.stdin.isTTY),
    });

    let attempts = 0;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
    };

    const finish = (response: PermissionResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    rl.on("line", (line) => {
      const parsed = parsePermissionAnswer(line);
      if (parsed !== "retry") {
        finish(parsed);
        return;
      }
      attempts += 1;
      if (attempts >= 2) {
        process.stderr.write("  giving up, rejecting\n");
        finish("reject");
        return;
      }
      writePermissionPrompt(perm, true);
    });

    rl.on("close", () => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve("reject");
      }
    });
  });
}

/**
 * Decide and send a permission reply. Dedupes by permission id via `answered`.
 * For `jsonl` mode, `waitPermissionReply` must be provided by the stdin demux.
 */
export async function handlePermission(opts: {
  client: OpencodeClient;
  sessionID: string;
  perm: PermissionInfo;
  mode: PermissionMode;
  signal?: AbortSignal;
  answered: Set<string>;
  waitPermissionReply?: WaitPermissionReply;
  /** Shared stdin line reader (stream demux) for interactive TTY mode. */
  readStdinLine?: () => Promise<string>;
}): Promise<void> {
  const { client, sessionID, perm, mode, signal, answered } = opts;

  if (answered.has(perm.id)) return;
  answered.add(perm.id);

  let response: PermissionResponse;
  if (mode === "auto") {
    response = "once";
    process.stderr.write(
      `[permission] ${perm.type}: auto-approved (once)\n  ${perm.title}\n`,
    );
  } else if (mode === "reject") {
    response = "reject";
    process.stderr.write(
      `[permission] ${perm.type}: rejected (non-TTY; use --auto to approve)\n` +
        `  ${perm.title}\n`,
    );
  } else if (mode === "jsonl") {
    const wait = opts.waitPermissionReply;
    if (!wait) {
      process.stderr.write(
        `warning: jsonl permission mode without waitPermissionReply, rejecting\n`,
      );
      response = "reject";
    } else {
      writePermissionJsonl(perm);
      try {
        response = await wait(perm.id, signal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "aborted" || signal?.aborted) {
          // Prefer reject-then-abort so OpenCode does not hang the tool.
          try {
            await replyPermission(client, sessionID, perm.id, "reject");
          } catch {
            // best-effort
          }
          throw err instanceof Error ? err : new Error(msg);
        }
        process.stderr.write(
          `warning: permission_reply failed (${msg}), rejecting\n`,
        );
        response = "reject";
      }
    }
  } else {
    try {
      response = await promptPermission(perm, signal, opts.readStdinLine);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "aborted" || signal?.aborted) {
        throw err instanceof Error ? err : new Error(msg);
      }
      process.stderr.write(
        `warning: permission prompt failed (${msg}), rejecting\n`,
      );
      response = "reject";
    }
  }

  try {
    await replyPermission(client, sessionID, perm.id, response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: ${msg}\n`);
  }
}
