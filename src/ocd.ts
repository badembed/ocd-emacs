import { Command } from "commander";

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

const opts = program.opts();
const args: string[] = program.args;

// --list-sessions takes precedence over everything else
if (opts.listSessions) {
  console.log("list=true");
  process.exit(0);
}

// Disambiguation: commander assigns positional args in order,
// but when only one is present it is the question, not the path.
let path: string | undefined;
let question: string | undefined;

if (args.length >= 2) {
  path = args[0];
  question = args[1];
} else if (args.length === 1) {
  question = args[0];
} else {
  // No positional arguments — show help
  program.help();
  process.exit(0);
}

// Build debug output in fixed order: session, paste, file, q
const parts: string[] = [];
if (opts.session) {
  parts.push(`session=${opts.session}`);
}
if (opts.paste) {
  parts.push("paste=true");
}
if (path !== undefined) {
  parts.push(`file=${path}`);
}
if (question !== undefined) {
  if (parts.length > 0) {
    parts.push(`q=${question}`);
  } else {
    // Question is the sole output — print verbatim, no "q=" prefix
    parts.push(question);
  }
}

console.log(parts.join(", "));
