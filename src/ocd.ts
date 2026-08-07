import { Command } from "commander";
import {
  resolveClient,
  closeSpawnedServer,
  abortActiveSession,
  clearActiveAbort,
} from "./client";
import { resolveSession, listSessions } from "./sessions";
import { assembleParts, resolveWorkspace } from "./context";
import { streamResponse } from "./stream";
import { resolvePermissionMode } from "./permissions";
import { runStreamLoop } from "./repl";
import { formatSdkError } from "./errors";

const program = new Command();

program
  .name("ocd")
  .description("CLI wrapper for OpenCode Agent SDK")
  .argument(
    "[path]",
    "file (attach as context) or folder (OpenCode working directory)",
  )
  .argument("[question]", "question to ask")
  .option("-p, --paste", "include clipboard content")
  .option("-s, --session <name>", "named session to use or create")
  .option("-v, --verbose", "log reasoning and tool calls to stderr")
  .option(
    "--auto",
    "auto-approve OpenCode permissions (once), like opencode run --auto",
  )
  .option("-l, --list-sessions", "list named sessions")
  .option(
    "--stream",
    "read prompts from stdin, stream responses to stdout (multi-turn)",
  )
  .option("-n, --name <name>", "session name (required with --stream)")
  .option(
    "--jsonl",
    "with --stream, emit JSON Lines (session_id/text/permission) for machine clients",
  );

program.parse();

const opts = program.opts<{
  paste?: boolean;
  session?: string;
  verbose?: boolean;
  auto?: boolean;
  listSessions?: boolean;
  stream?: boolean;
  name?: string;
  jsonl?: boolean;
}>();
const args: string[] = program.args;

function onSignal(code: number): void {
  try {
    abortActiveSession();
  } catch {
    // ignore abort errors during shutdown
  }
  try {
    closeSpawnedServer();
  } catch {
    // ignore kill errors during shutdown
  }
  process.exit(code);
}

// Global signal handlers are registered only for non-stream modes. In
// --stream mode, runStreamLoop installs its own SIGINT handler that aborts
// the in-flight stream or closes readline cleanly; a second handler that
// calls process.exit(130) would race it and kill the process before the
// user can send the next prompt. SIGTERM in stream mode falls through to
// Node's default (exit 143), which is appropriate for an external kill.
if (!opts.stream) {
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGTERM", () => onSignal(143));
}

async function main(): Promise<number> {
  // 1. --list-sessions takes precedence (cwd workspace)
  if (opts.listSessions) {
    const client = await resolveClient(process.cwd());
    await listSessions(client);
    return 0;
  }

  // 2. --stream mode: stdin-driven multi-turn loop.
  if (opts.stream) {
    if (!opts.name) {
      console.error("error: --name required with --stream");
      return 1;
    }
    const client = await resolveClient(process.cwd());
    const sessionID = await resolveSession(client, opts.name);
    const verbose =
      opts.verbose === true ||
      process.env.OCD_VERBOSE === "1" ||
      process.env.OCD_VERBOSE === "true";
    const jsonl = opts.jsonl === true;
    const permissionMode = resolvePermissionMode({
      autoFlag: opts.auto === true,
      jsonlFlag: jsonl,
    });
    const controller = new AbortController();
    await runStreamLoop(client, sessionID, {
      signal: controller.signal,
      verbose,
      permissionMode,
      jsonl,
    });
    return 0;
  }

  // 3. Disambiguate path vs question
  let path: string | undefined;
  let question: string | undefined;

  if (args.length >= 2) {
    path = args[0];
    question = args[1];
  } else if (args.length === 1) {
    question = args[0];
  } else if (!opts.paste && !opts.session) {
    // Bare invocation with no args/flags → help
    program.help();
  }

  // 4. Validate question before connecting
  if (!question || question.trim().length === 0) {
    console.error("error: question required");
    return 1;
  }

  // 5. Resolve workspace + assemble parts before spawning server
  const workspace = resolveWorkspace(path);
  const parts = assembleParts(workspace.file, question, opts.paste === true);

  // 6. Resolve client bound to the workspace directory
  const client = await resolveClient(workspace.directory);

  // 7. Resolve or create session.
  // Always set a title on anonymous sessions so OpenCode skips the separate
  // title-agent LLM call (which frequently hangs on small models).
  const sessionID = opts.session
    ? await resolveSession(client, opts.session)
    : await (async () => {
        const title =
          question.length > 48 ? question.slice(0, 45) + "..." : question;
        const created = await client.session.create({ body: { title } });
        if (created.error) {
          throw new Error(
            `failed to create session: ${formatSdkError(created.error)}`,
          );
        }
        return created.data!.id;
      })();

  // 8. Stream response
  const verbose =
    opts.verbose === true ||
    process.env.OCD_VERBOSE === "1" ||
    process.env.OCD_VERBOSE === "true";
  const permissionMode = resolvePermissionMode({
    autoFlag: opts.auto === true,
  });
  await streamResponse(client, sessionID, parts, { verbose, permissionMode });
  return 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("error:", msg);
  exitCode = 1;
} finally {
  clearActiveAbort();
  closeSpawnedServer();
}

process.exit(exitCode);
