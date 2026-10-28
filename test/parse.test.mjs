import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { commandReadPaths, parseTranscript } from "../src/parse.mjs";

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

test("parses Claude Code JSONL and attaches tool results", () => {
  const parsed = parseTranscript(fixture("blind-session.jsonl"), { file: "blind.jsonl" });

  assert.equal(parsed.format, "claude-code");
  assert.equal(parsed.cwd, "/repo/shop");
  assert.equal(parsed.events.length, 8);

  const write = parsed.events.find((event) => event.tool === "Write" && event.path === "config/prod.yaml");
  assert.equal(write.kind, "write");
  assert.equal(write.mode, "overwrite");
  assert.equal(write.isError, false);

  const create = parsed.events.find((event) => event.tool === "Write" && event.path === "src/parser.ts");
  assert.equal(create.mode, "create");

  const read = parsed.events.find((event) => event.tool === "Read");
  assert.equal(read.kind, "read");
  assert.equal(read.isError, false);
});

test("keeps guard errors attached to the failing write", () => {
  const parsed = parseTranscript(fixture("guarded-session.jsonl"));
  const failed = parsed.events.filter((event) => event.isError);
  assert.equal(failed.length, 2);
  assert.match(failed[0].resultText, /has not been read yet/);
});

test("parses generic and OpenAI-style logs", () => {
  const generic = parseTranscript(
    [
      JSON.stringify({ tool: "Read", input: { path: "a.ts" } }),
      JSON.stringify({ tool: "Edit", input: { path: "a.ts" } }),
    ].join("\n"),
  );
  assert.equal(generic.format, "generic");
  assert.deepEqual(generic.events.map((event) => event.kind), ["read", "write"]);

  const openai = parseTranscript(
    JSON.stringify({
      role: "assistant",
      tool_calls: [
        { id: "1", function: { name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) } },
      ],
    }),
  );
  assert.equal(openai.format, "openai");
  assert.equal(openai.events[0].kind, "read");
  assert.equal(openai.events[0].path, "b.ts");
});

test("commandReadPaths only counts direct single-file reads", () => {
  assert.deepEqual(commandReadPaths("cat src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(commandReadPaths("head -n 20 src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(commandReadPaths("sed -n '1,40p' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(commandReadPaths("Get-Content -Path src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(commandReadPaths("cat src/a.ts | grep total"), ["src/a.ts"]);
  assert.deepEqual(commandReadPaths("cat src/*.ts"), []);
  assert.deepEqual(commandReadPaths("npm test"), []);
  assert.deepEqual(commandReadPaths("sed 's/a/b/' src/a.ts"), []);
  assert.deepEqual(commandReadPaths("rg total src"), []);
});
