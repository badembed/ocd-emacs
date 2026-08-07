import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { OpencodeClient, TextPartInput } from "@opencode-ai/sdk";
import { abortActiveSession } from "./client";
import { streamResponse } from "./stream";
import {
  parsePermissionReply,
  type PermissionMode,
  type PermissionResponse,
  type WaitPermissionReply,
} from "./permissions";

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
  /**
   * Emit JSON Lines on stdout for machine clients (Emacs). Opt-in via
   * `ocd --stream --jsonl`; plain text remains the default for humans.
   */
  jsonl?: boolean;
};

/**
 * Module-level flag so the SIGINT / signal-abort handler closure can detect
 * whether a stream is currently being awaited. Set to `true` just before each
 * `streamResponse` call and `false` immediately after it resolves or rejects.
 */
let streamInFlight = false;

type PermissionWaiter = {
  resolve: (response: PermissionResponse) => void;
  reject: (err: Error) => void;
};

/** Simple async FIFO for chat prompts (stdin demux). */
class PromptQueue {
  private readonly items: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  push(line: string): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(line);
      return;
    }
    this.items.push(line);
  }

  /** Resolve with null when the queue is closed and empty. */
  take(): Promise<string | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }
}

/**
 * Read prompts from stdin line-by-line and stream responses to stdout via
 * `streamResponse`. Exits cleanly on:
 *   - EOF (readline `close` event)
 *   - the `quit` keyword (case-insensitive, trimmed) on its own line
 *   - SIGINT or external `signal` abort with no stream in flight
 *
 * A single stdin reader stays active during in-flight streams so JSONL
 * `permission_reply` lines can resolve permission waiters. Plain text lines
 * received during a stream are queued as the next chat prompts.
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
  const jsonl = options.jsonl === true;

  const promptQueue = new PromptQueue();
  const pendingPermissionReplies = new Map<string, PermissionWaiter>();

  const waitPermissionReply: WaitPermissionReply = (id, replySignal) => {
    return new Promise<PermissionResponse>((resolve, reject) => {
      if (replySignal?.aborted || signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (pendingPermissionReplies.has(id)) {
        process.stderr.write(
          `warning: duplicate waitPermissionReply for ${id}\n`,
        );
        reject(new Error(`duplicate permission wait for ${id}`));
        return;
      }

      const cleanup = (): void => {
        pendingPermissionReplies.delete(id);
        replySignal?.removeEventListener("abort", onAbort);
        signal.removeEventListener("abort", onAbort);
      };

      const onAbort = (): void => {
        const waiter = pendingPermissionReplies.get(id);
        if (!waiter) return;
        cleanup();
        waiter.reject(new Error("aborted"));
      };

      pendingPermissionReplies.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      replySignal?.addEventListener("abort", onAbort, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const rejectAllPermissionWaiters = (reason: string): void => {
    const waiters = [...pendingPermissionReplies.values()];
    pendingPermissionReplies.clear();
    for (const waiter of waiters) {
      waiter.reject(new Error(reason));
    }
  };

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
  // stdin end/close so the reader terminates immediately.
  const onStdinEnd = (): void => {
    console.error("stream loop: stdin EOF, exiting");
    rl.close();
  };
  const onStdinClose = (): void => {
    console.error("stream loop: stdin closed, exiting");
    rl.close();
  };
  process.stdin.on("end", onStdinEnd);
  process.stdin.on("close", onStdinClose);

  // Tracks whether the current stream rejection came from our interrupt path
  // (SIGINT / signal abort) vs. a real error. Local to this invocation; the
  // handler closure captures it. Reset on every interrupt and after each
  // stream so a subsequent genuine error still propagates.
  let userInitiatedAbort = false;
  let shuttingDown = false;

  /**
   * Shared interrupt handler. SIGINT and external signal abort both route
   * here so the behavior stays in sync. If a stream is in-flight, abort it
   * and let the loop continue to the next prompt. Otherwise, close readline
   * so the demux ends and the function returns.
   */
  const handleInterrupt = (source: "SIGINT" | "signal"): void => {
    if (streamInFlight) {
      console.error(
        `stream loop: ${source} received, aborting current stream`,
      );
      userInitiatedAbort = true;
      rejectAllPermissionWaiters("aborted");
      abortActiveSession();
      return;
    }
    console.error(`stream loop: ${source} received, exiting`);
    shuttingDown = true;
    rejectAllPermissionWaiters("aborted");
    promptQueue.close();
    rl.close();
  };

  const onSigint = (): void => handleInterrupt("SIGINT");
  const onAbort = (): void => handleInterrupt("signal");
  // Registered AFTER readline is created and BEFORE the loop starts, per spec.
  process.on("SIGINT", onSigint);
  signal.addEventListener("abort", onAbort);

  // Always-on stdin demux: permission replies resolve waiters; other lines
  // become chat prompts (queued even while a stream is in flight).
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line.length === 0) return;

    const reply = parsePermissionReply(line);
    if (reply) {
      const waiter = pendingPermissionReplies.get(reply.id);
      if (!waiter) {
        process.stderr.write(
          `warning: permission_reply for unknown id ${reply.id}\n`,
        );
        return;
      }
      // Malformed response values are already normalized to reject by parser.
      waiter.resolve(reply.response);
      return;
    }

    // Control-looking JSON must never become a chat prompt.
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as { type?: unknown };
        if (typeof obj.type === "string") {
          if (obj.type !== "permission_reply") {
            process.stderr.write(
              `warning: ignoring unknown control JSON type ${obj.type}\n`,
            );
          }
          return;
        }
      } catch {
        // Not JSON — treat as a chat prompt below.
      }
    }

    if (line.toLowerCase() === "quit") {
      console.error("stream loop: quit received, exiting");
      shuttingDown = true;
      rejectAllPermissionWaiters("aborted");
      promptQueue.close();
      rl.close();
      return;
    }

    promptQueue.push(line);
  });

  rl.on("close", () => {
    shuttingDown = true;
    rejectAllPermissionWaiters("aborted");
    promptQueue.close();
  });

  // Announce the OpenCode session id once so Emacs can persist it.
  if (jsonl) {
    process.stdout.write(
      JSON.stringify({ type: "session_id", id: sessionID }) + "\n",
    );
  }

  try {
    while (!shuttingDown) {
      const line = await promptQueue.take();
      if (line === null) break;

      const parts: TextPartInput[] = [{ type: "text", text: line }];
      streamInFlight = true;
      try {
        await streamResponse(client, sessionID, parts, {
          verbose,
          permissionMode,
          jsonl,
          waitPermissionReply,
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
        rejectAllPermissionWaiters("aborted");
      }
    }
  } finally {
    // Clean up listeners so a second runStreamLoop call (or process exit)
    // doesn't leak handlers or fire a stale abort on a new loop.
    process.removeListener("SIGINT", onSigint);
    signal.removeEventListener("abort", onAbort);
    process.stdin.removeListener("end", onStdinEnd);
    process.stdin.removeListener("close", onStdinClose);
    rejectAllPermissionWaiters("aborted");
    promptQueue.close();
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
