// Core rule: a write is "blind" when the session never successfully read that
// path before the write landed. Guard rejections are counted separately.

import process from "node:process";
import { commandReadPaths, displayPath, GUARD_RE, pathKey, resolvePath } from "./parse.mjs";

export const VERSION = "0.1.0";

const REASONS = {
  edit: "edit applied without reading the file first",
  overwrite: "full-content write to an existing file that was never read",
  "write-unknown": "write without a prior read (no tool result recorded)",
};

export function auditTranscript(parsed, { root } = {}) {
  const base = root || parsed.cwd || process.cwd();
  const entries = new Map();
  const order = [];
  let reads = 0;
  let writes = 0;
  let coveredWrites = 0;
  let createdFiles = 0;
  let failedWrites = 0;

  function entryFor(value, event) {
    const absolute = resolvePath(value, base);
    const key = pathKey(absolute);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        absolute,
        path: displayPath(absolute, base),
        read: false,
        readLine: null,
        viaCommand: false,
        created: false,
        blind: false,
        blindWrites: 0,
        coveredWrites: 0,
        failedWrites: 0,
        attempts: [],
        firstBlind: null,
        firstLine: event.line,
      };
      entries.set(key, entry);
      order.push(entry);
    }
    return entry;
  }

  for (const event of parsed.events) {
    if (event.kind === "read" && event.path) {
      const entry = entryFor(event.path, event);
      if (event.isError) {
        entry.failedReads = (entry.failedReads ?? 0) + 1;
        continue;
      }
      if (!entry.read) {
        entry.read = true;
        entry.readLine = event.line;
      }
      reads += 1;
      continue;
    }

    if (event.kind === "command") {
      for (const value of commandReadPaths(event.command)) {
        const entry = entryFor(value, event);
        if (!entry.read) {
          entry.read = true;
          entry.readLine = event.line;
          entry.viaCommand = true;
        }
        reads += 1;
      }
      continue;
    }

    if (event.kind !== "write" || !event.path) continue;
    writes += 1;
    const entry = entryFor(event.path, event);

    // A file the agent created itself does not need a prior read.
    if (entry.read || entry.created) {
      coveredWrites += 1;
      entry.coveredWrites += 1;
      continue;
    }

    if (event.isError) {
      if (GUARD_RE.test(event.resultText)) {
        entry.attempts.push({ line: event.line, tool: event.tool, at: event.at });
      } else {
        failedWrites += 1;
        entry.failedWrites += 1;
      }
      continue;
    }

    if (event.mode === "create") {
      createdFiles += 1;
      entry.created = true;
      entry.coveredWrites += 1;
      coveredWrites += 1;
      continue;
    }

    entry.blind = true;
    entry.blindWrites += 1;
    if (!entry.firstBlind) {
      entry.firstBlind = { line: event.line, tool: event.tool, mode: event.mode, at: event.at };
    }
  }

  const risky = order
    .filter((entry) => entry.blind)
    .map((entry) => ({
      path: entry.path,
      line: entry.firstBlind.line,
      tool: entry.firstBlind.tool,
      mode: entry.firstBlind.mode,
      writes: entry.blindWrites,
      reason: REASONS[entry.firstBlind.mode] ?? REASONS["write-unknown"],
    }))
    .sort((a, b) => a.line - b.line);

  const attempts = order
    .filter((entry) => entry.attempts.length > 0)
    .map((entry) => ({ path: entry.path, lines: entry.attempts.map((item) => item.line), count: entry.attempts.length }))
    .sort((a, b) => a.lines[0] - b.lines[0]);

  const attemptCount = attempts.reduce((sum, item) => sum + item.count, 0);
  const riskyWrites = risky.reduce((sum, item) => sum + item.writes, 0);

  return {
    version: VERSION,
    transcript: parsed.file,
    format: parsed.format,
    cwd: parsed.cwd,
    events: parsed.events.length,
    summary: {
      reads,
      writes,
      coveredWrites,
      createdFiles,
      failedWrites,
      riskyFiles: risky.length,
      riskyWrites,
      attemptFiles: attempts.length,
      attempts: attemptCount,
    },
    risky,
    attempts,
    warnings: parsed.warnings,
  };
}

export { REASONS };
