import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";
import { abortActiveSession } from "./client";
import { streamResponse } from "./stream";
import type { PermissionMode } from "./permissions";

export type StreamLoopOptions = {
  /** Log reasoning + tool calls to stderr (`-v` / `OCD_VERBOSE`). */
  verbose?: boolean;
  /** How to answer OpenCode permission.updated prompts. */
  permissionMode?: PermissionMode;
  /**
   * AbortSignal for cancelling the in-flight stream. When this signal fires,
   * the loop behaves as if SIGINT was received — abort the current stream if
   * one is in flight, otherwise exit the loop cleanly.
   */
  signal: AbortSignal;
};

/**
 * Module-level flag so the SIGINT / signal-abort handler closure can detect
 * whether a stream is currently being awaited. Set to `true` just before each
 * `streamResponse` call and `false` immediately after it resolves or rejects.
 */
let streamInFlight = false;

/**
 * Read prompts from stdin line-by-line and stream responses to stdout via
 * `streamResponse`. Exits cleanly on:
 *   - EOF (readline `close` event)
 *   - the `quit` keyword (case-insensitive, trimmed) on its own line
 *   - SIGINT or external `signal` abort with no stream in flight
 *
 * SIGINT / signal abort during an in-flight stream calls
 * `abortActiveSession()` to abort the current stream without killing the
 * loop, so the next prompt can be read. Non-abort stream errors are logged
 * to stderr and the loop continues — a real client will surface them
 * through the stream's own diagnostics.
 */
export async function runStreamLoop(
  client: OpencodeClient,
  sessionID: string,
  options: StreamLoopOptions,
): Promise<void> {
  const { verbose, permissionMode, signal } = options;

  // output: process.stderr keeps stdout clean for streamed responses.
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  // F3 EOF bug fix: when stdin is already closed at startup (e.g. `printf '' |
  // ocd --stream` or `</dev/null | ocd --stream`), the readline async iterator
  // never starts iterating because there is no data, and the for-await below
  // never receives the `end` event. The spawned OpenCode server keeps the
  // event loop alive, so the process hangs. Explicitly close readline on
  // stdin end/close so the for-await terminates immediately.
  process.stdin.on("end", () => {
    console.error("stream loop: stdin EOF, exiting");
    rl.close();
  });
  process.stdin.on("close", () => {
    console.error("stream loop: stdin closed, exiting");
    rl.close();
  });

  // Tracks whether the current stream rejection came from our interrupt path
  // (SIGINT / signal abort) vs. a real error. Local to this invocation; the
  // handler closure captures it. Reset on every interrupt and after each
  // stream so a subsequent genuine error still propagates.
  let userInitiatedAbort = false;

  /**
   * Shared interrupt handler. SIGINT and external signal abort both route
   * here so the behavior stays in sync. If a stream is in-flight, abort it
   * and let the loop continue to the next prompt. Otherwise, close readline
   * so the for-await ends and the function returns.
   */
  const handleInterrupt = (source: "SIGINT" | "signal"): void => {
    if (streamInFlight) {
      console.error(
        `stream loop: ${source} received, aborting current stream`,
      );
      userInitiatedAbort = true;
      abortActiveSession();
      return;
    }
    console.error(`stream loop: ${source} received, exiting`);
    rl.close();
  };

  const onSigint = (): void => handleInterrupt("SIGINT");
  const onAbort = (): void => handleInterrupt("signal");
  // Registered AFTER readline is created and BEFORE the loop starts, per spec.
  process.on("SIGINT", onSigint);
  signal.addEventListener("abort", onAbort);

  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.toLowerCase() === "quit") {
        console.error("stream loop: quit received, exiting");
        break;
      }
      const parts: TextPartInput[] = [{ type: "text", text: line }];
      streamInFlight = true;
      try {
        await streamResponse(client, sessionID, parts, {
          verbose,
          permissionMode,
        });
      } catch (err: unknown) {
        if (userInitiatedAbort) {
          // Expected: the interrupt path already logged the reason.
          userInitiatedAbort = false;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`stream loop: stream error (${msg})`);
        }
      } finally {
        streamInFlight = false;
      }
    }
  } finally {
    // Clean up listeners so a second runStreamLoop call (or process exit)
    // doesn't leak handlers or fire a stale abort on a new loop.
    process.removeListener("SIGINT", onSigint);
    signal.removeEventListener("abort", onAbort);
    rl.close();
  }
}

// Minimal CLI for exercising runStreamLoop in isolation (todo 3 verification).
// Real wiring — client resolution, session management, commander flags — lives
// in src/ocd.ts (todo 4). This stub exists only so `bun run src/repl.ts`
// drives the loop end-to-end during automated checks; importing this module
// from another file (e.g. ocd.ts) does NOT trigger the loop.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // Proxy that throws on every property access — streamResponse will fail
  // loudly, the loop will log the error and continue, and EOF / `quit` will
  // exit cleanly. This is exactly what the todo 3 functional tests expect.
  const stubClient = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return () => {
        throw new Error(`stub client: ${String(prop)} not implemented`);
      };
    },
  }) as unknown as OpencodeClient;
  const controller = new AbortController();
  runStreamLoop(stubClient, "test-session", { signal: controller.signal }).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`stream loop: ${msg}`);
    },
  );
}
