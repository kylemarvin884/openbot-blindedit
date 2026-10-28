import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { auditTranscript } from "../src/audit.mjs";
import { parseTranscript } from "../src/parse.mjs";

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
const audit = (name) => auditTranscript(parseTranscript(fixture(name), { file: name }));

test("flags edits and overwrites that landed without a read", () => {
  const report = audit("blind-session.jsonl");

  assert.deepEqual(
    report.risky.map((item) => item.path),
    ["config/prod.yaml", "src/checkout.ts"],
  );
  assert.equal(report.risky[0].mode, "overwrite");
  assert.equal(report.risky[1].mode, "edit");
  assert.equal(report.summary.riskyWrites, 2);
  assert.equal(report.summary.riskyFiles, 2);
});

test("does not flag reads, created files, or command reads", () => {
  const report = audit("blind-session.jsonl");
  const paths = report.risky.map((item) => item.path);

  assert.equal(paths.includes("src/cart.ts"), false, "read before edit");
  assert.equal(paths.includes("src/parser.ts"), false, "created then edited");
  assert.equal(paths.includes("src/pricing.ts"), false, "read via cat");
  assert.equal(report.summary.createdFiles, 1);
  assert.equal(report.summary.coveredWrites, 4);
});

test("counts guard rejections separately from landed writes", () => {
  const report = audit("guarded-session.jsonl");

  assert.equal(report.summary.riskyWrites, 0);
  assert.equal(report.summary.attempts, 2);
  assert.deepEqual(report.attempts, [{ path: "src/api.ts", lines: [1, 3], count: 2 }]);
  assert.equal(report.summary.coveredWrites, 1);
});

test("clean session exits with nothing to report", () => {
  const report = audit("clean-session.jsonl");
  assert.equal(report.summary.riskyWrites, 0);
  assert.equal(report.summary.attempts, 0);
  assert.equal(report.summary.coveredWrites, 3);
});

test("matches absolute writes against relative reads", () => {
  const text = [
    call("Read", { file_path: "src/a.ts" }, "1", "/repo/x"),
    result("1", "ok", false, "/repo/x"),
    call("Edit", { file_path: "/repo/x/src/a.ts" }, "2", "/repo/x"),
    result("2", "ok", false, "/repo/x"),
  ].join("\n");

  const report = auditTranscript(parseTranscript(text));
  assert.equal(report.summary.riskyWrites, 0);
  assert.equal(report.summary.coveredWrites, 1);
});

test("treats a write after a failed read as blind", () => {
  const text = [
    call("Read", { file_path: "src/lost.ts" }, "1"),
    result("1", "file not found", true),
    call("Edit", { file_path: "src/lost.ts" }, "2"),
    result("2", "ok"),
  ].join("\n");

  const report = auditTranscript(parseTranscript(text));
  assert.equal(report.summary.riskyFiles, 1);
  assert.equal(report.risky[0].path, "src/lost.ts");
});

test("groups repeated writes to the same unread file", () => {
  const text = [
    call("Edit", { file_path: "src/a.ts" }, "1"),
    result("1", "ok"),
    call("MultiEdit", { file_path: "src/a.ts" }, "2"),
    result("2", "ok"),
  ].join("\n");

  const report = auditTranscript(parseTranscript(text));
  assert.equal(report.summary.riskyFiles, 1);
  assert.equal(report.summary.riskyWrites, 2);
  assert.equal(report.risky[0].writes, 2);
});

function call(name, input, id, cwd) {
  return JSON.stringify({
    type: "assistant",
    ...(cwd ? { cwd } : {}),
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function result(id, content, isError = false, cwd) {
  return JSON.stringify({
    type: "user",
    ...(cwd ? { cwd } : {}),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });
}
