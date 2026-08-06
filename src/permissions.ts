import { createInterface } from "node:readline";
import type { OpencodeClient } from "@opencode-ai/sdk";

export type PermissionMode = "interactive" | "auto" | "reject";
export type PermissionResponse = "once" | "always" | "reject";

export type PermissionInfo = {
  id: string;
  type: string;
  title: string;
  sessionID: string;
  pattern?: string | Array<string>;
};

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
 * --auto / OCD_AUTO → auto; TTY → interactive; else reject (no hang).
 */
export function resolvePermissionMode(opts: {
  autoFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean | null;
}): PermissionMode {
  const env = opts.env ?? process.env;
  const autoEnv = env.OCD_AUTO === "1" || env.OCD_AUTO === "true";
  if (opts.autoFlag === true || autoEnv) return "auto";
  const tty =
    opts.stdinIsTTY !== undefined && opts.stdinIsTTY !== null
      ? opts.stdinIsTTY
      : Boolean(process.stdin.isTTY);
  if (tty) return "interactive";
  return "reject";
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
    throw new Error(`permission reply failed: ${String(result.error)}`);
  }
}

/**
 * Ask the user on stderr; read one line from stdin.
 * y/Enter → once, a → always, n → reject. One retry on unknown, then reject.
 */
export function promptPermission(
  perm: PermissionInfo,
  signal?: AbortSignal,
): Promise<PermissionResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const pattern =
      perm.pattern === undefined
        ? ""
        : Array.isArray(perm.pattern)
          ? perm.pattern.join(", ")
          : perm.pattern;

    const writePrompt = (retry: boolean): void => {
      process.stderr.write(
        `[permission] ${perm.type}\n` +
          `  ${perm.title}\n` +
          (pattern ? `  pattern: ${pattern}\n` : "") +
          (retry ? `  invalid input, try again\n` : "") +
          `  [y] once  [a] always  [n] reject\n` +
          `> `,
      );
    };

    writePrompt(false);

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
      const key = line.trim().toLowerCase();
      if (key === "" || key === "y" || key === "yes") {
        finish("once");
        return;
      }
      if (key === "a" || key === "always") {
        finish("always");
        return;
      }
      if (key === "n" || key === "no" || key === "reject") {
        finish("reject");
        return;
      }
      attempts += 1;
      if (attempts >= 2) {
        process.stderr.write("  giving up, rejecting\n");
        finish("reject");
        return;
      }
      writePrompt(true);
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
 */
export async function handlePermission(opts: {
  client: OpencodeClient;
  sessionID: string;
  perm: PermissionInfo;
  mode: PermissionMode;
  signal?: AbortSignal;
  answered: Set<string>;
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
  } else {
    try {
      response = await promptPermission(perm, signal);
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
