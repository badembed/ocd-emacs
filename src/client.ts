import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import nodePath from "node:path";

/** Module-level handle for auto-spawned server — closed on exit. */
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
 * 2. OPENCODE_BIN_PATH → prepend dir to PATH
 * 3. Existing local serve on :4096 → reuse
 * 4. Auto-spawn `opencode serve --pure` on ephemeral port
 */
export async function resolveClient(): Promise<OpencodeClient> {
  const serverUrl = process.env.OCD_SERVER_URL;
  if (serverUrl) {
    return connect(serverUrl);
  }

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

  // Prefer an already-running local server (e.g. `opencode` TUI / serve)
  try {
    return await connect("http://127.0.0.1:4096");
  } catch {
    // not running — fall through to auto-spawn
  }

  try {
    return await spawnPureServer();
  } catch (err: unknown) {
    // Fallback to SDK spawn if --pure unsupported
    try {
      const result = await createOpencode({
        hostname: "127.0.0.1",
        port: 0,
        timeout: 15_000,
      });
      spawnedServer = result.server;
      return createOpencodeClient({
        baseUrl: result.server.url,
        directory: process.cwd(),
      });
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cannot auto-spawn OpenCode server: ${msg}\n` +
          `Install OpenCode or set OCD_SERVER_URL / OPENCODE_BIN_PATH.`,
      );
    }
  }
}

async function connect(baseUrl: string): Promise<OpencodeClient> {
  const client = createOpencodeClient({
    baseUrl,
    directory: process.cwd(),
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
function spawnPureServer(): Promise<OpencodeClient> {
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

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
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
      spawnedServer = {
        close() {
          proc.kill();
        },
      };
      void connect(url).then(resolve, (err: unknown) => {
        proc.kill();
        reject(err);
      });
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
      reject(
        new Error(
          `opencode serve exited with code ${code}\n${output.slice(-500)}`,
        ),
      );
    });
  });
}
