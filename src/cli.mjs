#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { auditTranscript, VERSION } from "./audit.mjs";
import { parseTranscript } from "./parse.mjs";
import { exitCodeFor, renderJson, renderReport } from "./report.mjs";

const HELP = `blindedit ${VERSION} — find files a coding agent edited without reading them

Usage:
  blindedit audit <transcript.jsonl> [options]

Options:
  --json                  machine-readable output
  --fail-on=write|attempt|none
                          exit 1 on landed blind writes (default: write),
                          on guard rejections too (attempt), or never (none)
  --root <dir>            directory paths are resolved/displayed against
                          (default: the transcript's cwd)
  --quiet                 print only the summary line
  --no-color              disable ANSI colors
  -h, --help              show this help
  -v, --version           print version

Input formats:
  Claude Code JSONL, OpenAI-style tool_calls, generic {tool,input} events.

Exit codes:
  0  no violation (or --fail-on=none)
  1  blind write found (or guard retries with --fail-on=attempt)
  2  bad usage or unreadable transcript

Notes:
  - A Write that the harness reports as "create" is not flagged; the agent
    authored that file in this session.
  - "read" includes Read/View tools and simple cat/head/tail/sed -n/Get-Content
    commands. Piped or globbed reads are not counted.
`;

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`blindedit: ${error.message}\n`);
    return 2;
  }

  if (options.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!options.file) {
    io.stderr.write(`${HELP}\n`);
    return 2;
  }

  let text;
  try {
    text = await fs.readFile(options.file, "utf8");
  } catch (error) {
    io.stderr.write(`blindedit: cannot read ${options.file}: ${error.message}\n`);
    return 2;
  }

  const parsed = parseTranscript(text, { file: options.file });
  if (parsed.events.length === 0) {
    io.stderr.write(
      `blindedit: no tool calls found in ${options.file} (parsed ${parsed.parsedLines} JSON line(s))\n`,
    );
    return 2;
  }

  const report = auditTranscript(parsed, { root: options.root });
  const exitCode = exitCodeFor(report, options.failOn);
  const color = Boolean(io.stdout.isTTY) && !options.noColor;

  io.stdout.write(
    options.json
      ? renderJson(report)
      : renderReport(report, { color, exitCode, quiet: options.quiet }),
  );
  return exitCode;
}

function parseArgs(argv) {
  const options = {
    file: null,
    json: false,
    quiet: false,
    noColor: false,
    help: false,
    version: false,
    root: null,
    failOn: "write",
  };

  const args = [...argv];
  if (args[0] === "audit") args.shift();
  else if (args[0] && !args[0].startsWith("-") && args[0] !== "help") {
    throw new Error(`unknown command "${args[0]}" (expected: audit <transcript.jsonl>)`);
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help" || arg === "help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--no-color") options.noColor = true;
    else if (arg === "--root") {
      const value = args[i + 1];
      if (!value) throw new Error("--root needs a directory");
      options.root = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--fail-on") {
      const value = args[i + 1];
      if (!value) throw new Error("--fail-on needs write|attempt|none");
      options.failOn = validateFailOn(value);
      i += 1;
    } else if (arg.startsWith("--fail-on=")) {
      options.failOn = validateFailOn(arg.slice("--fail-on=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else if (!options.file) {
      options.file = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }

  return options;
}

function validateFailOn(value) {
  if (!["write", "attempt", "none"].includes(value)) {
    throw new Error(`invalid --fail-on=${value} (expected write, attempt, or none)`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
