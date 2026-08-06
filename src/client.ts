import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import nodePath from "node:path";

/** Ephemeral one-shot serve (killed on ocd exit). Not used for the :4097 daemon. */
let spawnedServer: { close(): void } | undefined;
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

/** Close ephemeral auto-spawned server only (never the persistent :4097 daemon). */
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

export function setActiveAbort(fn: () => void): void {
  activeAbort = fn;
}

export function clearActiveAbort(): void {
  activeAbort = undefined;
}

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
const DEFAULT_PORT = 4097;

/**
 * Resolve an OpenCode client:
 * 1. OCD_SERVER_URL or default :4097 → connect
 * 2. If default is down → start persistent `opencode serve --pure` on :4097 (survives ocd exit)
 * 3. Explicit OCD_SERVER_URL down → error (no auto-start)
 * 4. Last resort → ephemeral --pure (killed on exit)
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
  }

  // First-run (or daemon died): start persistent pure serve on :4097
  try {
    await ensurePersistentDaemon();
    return await connect(DEFAULT_SERVER_URL, directory);
  } catch {
    // fall through to ephemeral
  }

  try {
    return await spawnEphemeralPureServer(directory);
  } catch (err: unknown) {
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
        `cannot start OpenCode server: ${msg}\n` +
          `Try manually:\n` +
          `  opencode serve --hostname=127.0.0.1 --port=${DEFAULT_PORT} --pure`,
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
 * Start a long-lived `opencode serve --pure` on :4097.
 * Detached + unref — survives ocd exit; not killed by closeSpawnedServer().
 */
function ensurePersistentDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = process.env.OPENCODE_BIN_PATH || "opencode";
    const proc = spawn(
      bin,
      [
        "serve",
        "--hostname=127.0.0.1",
        `--port=${DEFAULT_PORT}`,
        "--pure",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      },
    );

    // Don't keep ocd alive waiting on this child after we connect.
    proc.unref();

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timeout starting OpenCode daemon on :${DEFAULT_PORT}\n${output.slice(-500)}`,
        ),
      );
    }, 15_000);

    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      // Already running / race with another ocd — treat as success and reconnect.
      if (
        /opencode server listening/i.test(output) ||
        /EADDRINUSE|address already in use/i.test(output)
      ) {
        finishOk();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // If it exited immediately with EADDRINUSE already handled above.
      reject(
        new Error(
          `OpenCode daemon exited with code ${code}\n${output.slice(-500)}`,
        ),
      );
    });
  });
}

/** One-shot serve on ephemeral port — killed when ocd exits. */
function spawnEphemeralPureServer(directory: string): Promise<OpencodeClient> {
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
