import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
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
 * 2. OPENCODE_BIN_PATH → prepend dir to PATH, auto-spawn
 * 3. Neither set     → auto-spawn via PATH
 */
export async function resolveClient(): Promise<OpencodeClient> {
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
    const result = await createOpencode();
    spawnedServer = result.server;
    await result.client.session.list();
    return result.client;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot auto-spawn OpenCode server: ${msg}\n` +
        `Install OpenCode or set OCD_SERVER_URL / OPENCODE_BIN_PATH.`,
    );
  }
}
