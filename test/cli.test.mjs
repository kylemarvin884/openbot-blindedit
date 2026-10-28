import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

const path = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function capture() {
  let out = "";
  let err = "";
  return {
    io: { stdout: { write: (chunk) => (out += chunk) }, stderr: { write: (chunk) => (err += chunk) } },
    stdout: () => out,
    stderr: () => err,
  };
}

test("exits 1 and prints the risky files", async () => {
  const run = capture();
  const code = await main(["audit", path("blind-session.jsonl"), "--no-color"], run.io);

  assert.equal(code, 1);
  assert.match(run.stdout(), /config\/prod\.yaml/);
  assert.match(run.stdout(), /src\/checkout\.ts/);
  assert.match(run.stdout(), /2 risky writes/);
});

test("exits 0 by default when only guard rejections occurred", async () => {
  const run = capture();
  const code = await main(["audit", path("guarded-session.jsonl"), "--no-color"], run.io);

  assert.equal(code, 0);
  assert.match(run.stdout(), /2 write attempts rejected/);
});

test("--fail-on=attempt makes guard rejections fail", async () => {
  const run = capture();
  const code = await main(["audit", path("guarded-session.jsonl"), "--fail-on=attempt"], run.io);
  assert.equal(code, 1);
});

test("--json emits a stable report", async () => {
  const run = capture();
  const code = await main(["audit", path("clean-session.jsonl"), "--json"], run.io);
  const report = JSON.parse(run.stdout());

  assert.equal(code, 0);
  assert.equal(report.format, "claude-code");
  assert.equal(report.summary.riskyWrites, 0);
  assert.equal(report.summary.coveredWrites, 3);
  assert.ok(Array.isArray(report.risky));
});

test("missing file and bad options exit 2", async () => {
  const missing = capture();
  assert.equal(await main(["audit", path("nope.jsonl")], missing.io), 2);
  assert.match(missing.stderr(), /cannot read/);

  const bad = capture();
  assert.equal(await main(["audit", path("clean-session.jsonl"), "--fail-on=maybe"], bad.io), 2);
  assert.match(bad.stderr(), /invalid --fail-on/);
});

test("unknown command exits 2", async () => {
  const run = capture();
  assert.equal(await main(["scan", path("clean-session.jsonl")], run.io), 2);
  assert.match(run.stderr(), /unknown command/);
});
