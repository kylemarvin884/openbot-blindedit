#!/usr/bin/env node
// Runs blindedit on the three bundled sessions so the README output is
// reproducible with one command.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

const cases = [
  ["fixtures/blind-session.jsonl", "harness without read-before-write guard"],
  ["fixtures/guarded-session.jsonl", "Claude Code style guard rejections"],
  ["fixtures/clean-session.jsonl", "read-before-write respected"],
];

for (const [file, label] of cases) {
  const absolute = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const target = path.relative(process.cwd(), absolute).split(path.sep).join("/");
  console.log(`\n### ${label} (${target})\n`);
  const code = await main(["audit", target, "--no-color"]);
  console.log(`(process exit code: ${code})`);
}
