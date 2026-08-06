import { Command } from "commander";
import { resolveClient, closeSpawnedServer } from "./client";
import { resolveSession, listSessions } from "./sessions";
import { assembleParts } from "./context";
import { streamResponse } from "./stream";

const program = new Command();

program
  .name("ocd")
  .description("CLI wrapper for OpenCode Agent SDK")
  .argument("[path]", "file or folder to include as context")
  .argument("[question]", "question to ask")
  .option("-p, --paste", "include clipboard content")
  .option("-s, --session <name>", "named session to use or create")
  .option("--list-sessions", "list named sessions");

program.parse();

const opts = program.opts<{
  paste?: boolean;
  session?: string;
  listSessions?: boolean;
}>();
const args: string[] = program.args;

async function main(): Promise<number> {
  // 1. --list-sessions takes precedence
  if (opts.listSessions) {
    const client = await resolveClient();
    await listSessions(client);
    return 0;
  }

  // 2. Disambiguate path vs question
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

  // 3. Validate question before connecting
  if (!question || question.trim().length === 0) {
    console.error("error: question required");
    return 1;
  }

  // 4. Resolve client
  const client = await resolveClient();

  // 5. Resolve or create session
  const sessionID = opts.session
    ? await resolveSession(client, opts.session)
    : await client.session.create({ body: {} }).then((r) => {
        if (r.error) {
          throw new Error(`failed to create session: ${String(r.error)}`);
        }
        return r.data!.id;
      });

  // 6. Assemble context parts and stream response
  const parts = assembleParts(path, question, opts.paste === true);
  await streamResponse(client, sessionID, parts);
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
  closeSpawnedServer();
}

process.exit(exitCode);
