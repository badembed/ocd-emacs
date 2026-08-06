import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import nodePath from "node:path";

/** Module-level handle for auto-spawned server — closed on exit. */
let spawnedServer: { close(): void } | undefined;
/** Pid of auto-spawned serve — set at spawn time (before "listening"). */
let spawnedPid: number | undefined;

/** Active stream abort hook (session.abort + AbortController). */
let activeAbort: (() => void) | undefined;

function killPid(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

/** Close the auto-spawned OpenCode server if one was started. */
export function closeSpawnedServer(): void {
  if (spawnedServer) {
    try {
      spawnedServer.close();
    } catch {
      // ignore
    }
    spawnedServer = undefined;
  }
  killPid(spawnedPid);
  spawnedPid = undefined;
}

/** Register cleanup for the in-flight stream (called on SIGINT/timeout). */
export function setActiveAbort(fn: () => void): void {
  activeAbort = fn;
}

export function clearActiveAbort(): void {
  activeAbort = undefined;
}

/** Abort the active stream/session if any. */
export function abortActiveSession(): void {
  const fn = activeAbort;
  activeAbort = undefined;
  if (fn) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

/** Default ocd-dedicated OpenCode serve (override with OCD_SERVER_URL). */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4097";

/**
 * Resolve an OpenCode client:
 * 1. OCD_SERVER_URL or default http://127.0.0.1:4097 → connect (probe session.list)
 * 2. OPENCODE_BIN_PATH → prepend dir to PATH (for spawn)
 * 3. If preferred URL is the default and unreachable → spawn `opencode serve --pure`
 *    If OCD_SERVER_URL was set explicitly and unreachable → error (no silent fallback)
 *
 * `directory` becomes the OpenCode project root (x-opencode-directory).
 */
export async function resolveClient(
  directory: string = process.cwd(),
): Promise<OpencodeClient> {
  const explicitUrl = process.env.OCD_SERVER_URL;
  const serverUrl = explicitUrl ?? DEFAULT_SERVER_URL;

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

  try {
    return await connect(serverUrl, directory);
  } catch (err: unknown) {
    if (explicitUrl !== undefined) {
      throw err;
    }
    // Default :4097 not up — fall through to auto-spawn
  }

  try {
    return await spawnPureServer(directory);
  } catch (err: unknown) {
    // Fallback to SDK spawn if --pure unsupported
    try {
      const result = await createOpencode({
        hostname: "127.0.0.1",
        port: 0,
        timeout: 15_000,
      });
      spawnedServer = result.server;
      spawnedPid = undefined;
      return createOpencodeClient({
        baseUrl: result.server.url,
        directory,
      });
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cannot auto-spawn OpenCode server: ${msg}\n` +
          `Start a dedicated serve, or set OCD_SERVER_URL:\n` +
          `  opencode serve --hostname=127.0.0.1 --port=4097 --pure\n` +
          `  export OCD_SERVER_URL=${DEFAULT_SERVER_URL}`,
      );
    }
  }
}

async function connect(
  baseUrl: string,
  directory: string,
): Promise<OpencodeClient> {
  const client = createOpencodeClient({
    baseUrl,
    directory,
  });
  try {
    await client.session.list();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot connect to OpenCode server at ${baseUrl}: ${msg}`);
  }
  return client;
}

/**
 * Spawn `opencode serve --pure` so user plugins (e.g. OhMyOpenCode) don't
 * block headless one-shot prompts for ~60s+ / hang forever.
 */
function spawnPureServer(directory: string): Promise<OpencodeClient> {
  return new Promise((resolve, reject) => {
    const bin = process.env.OPENCODE_BIN_PATH || "opencode";
    const proc = spawn(
      bin,
      ["serve", "--hostname=127.0.0.1", "--port=0", "--pure"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    // Set immediately — child may appear in ps before "listening" is parsed.
    spawnedPid = proc.pid;

    const killProc = (): void => {
      killPid(proc.pid ?? spawnedPid);
    };

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProc();
      spawnedPid = undefined;
      reject(
        new Error(
          `Timeout waiting for opencode serve --pure\n${output.slice(-500)}`,
        ),
      );
    }, 15_000);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      const match = output.match(
        /opencode server listening on (https?:\/\/\S+)/,
      );
      if (!match) return;
      settled = true;
      clearTimeout(timeout);
      const url = match[1].replace(/[.,;]+$/, "");
      spawnedPid = proc.pid ?? spawnedPid;
      spawnedServer = { close: killProc };
      void connect(url, directory).then(resolve, (err: unknown) => {
        killProc();
        spawnedPid = undefined;
        reject(err);
      });
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      spawnedPid = undefined;
      reject(err);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      spawnedPid = undefined;
      reject(
        new Error(
          `opencode serve exited with code ${code}\n${output.slice(-500)}`,
        ),
      );
    });
  });
}
