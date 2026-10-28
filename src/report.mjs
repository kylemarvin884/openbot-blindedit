// Rendering. Text output is for humans, JSON is the stable interface.

const ESC = "\u001b[";

function paint(enabled) {
  return {
    bold: (text) => (enabled ? `${ESC}1m${text}${ESC}0m` : text),
    dim: (text) => (enabled ? `${ESC}2m${text}${ESC}0m` : text),
    red: (text) => (enabled ? `${ESC}31m${text}${ESC}0m` : text),
    yellow: (text) => (enabled ? `${ESC}33m${text}${ESC}0m` : text),
    green: (text) => (enabled ? `${ESC}32m${text}${ESC}0m` : text),
  };
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function plural(count, word) {
  if (count === 1) return `${count} ${word}`;
  const pluralWord = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
  return `${count} ${pluralWord}`;
}

export function renderReport(report, { color = false, exitCode = 0, quiet = false } = {}) {
  const c = paint(color);
  const summary = report.summary;
  const lines = [];
  const verdict = exitCode === 0 ? c.green("exit 0") : c.red(`exit ${exitCode}`);

  if (quiet) {
    lines.push(
      `${plural(report.summary.riskyWrites, "risky write")}, ${plural(report.summary.attempts, "guard retry")} → ${verdict}`,
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `${c.bold(`blindedit ${report.version}`)} — ${report.events} events, ${plural(summary.reads, "read")}, ${plural(summary.writes, "write")}`,
  );
  lines.push(`${c.dim("transcript")}  ${report.transcript || "(stdin)"}  (${report.format})`);
  lines.push("");

  if (report.risky.length === 0) {
    lines.push(c.green("✓ no writes landed without a prior read"));
  } else {
    lines.push(c.red(`✗ ${plural(report.risky.length, "file")} written without a prior read`));
    for (const item of report.risky) {
      const count = item.writes > 1 ? ` ×${item.writes}` : "";
      lines.push(`  ${item.path.padEnd(28)} line ${String(item.line).padEnd(5)} ${item.mode}${count}`);
      lines.push(`  ${" ".repeat(28)} ${c.dim(item.reason)}`);
    }
  }

  if (report.attempts.length > 0) {
    lines.push("");
    lines.push(c.yellow(`⚠ ${plural(summary.attempts, "write attempt")} rejected by the read-before-write guard`));
    for (const item of report.attempts) {
      const where = item.lines.length === 1 ? `line ${item.lines[0]}` : `lines ${item.lines.join(", ")}`;
      lines.push(`  ${item.path.padEnd(28)} ${where}`);
    }
    lines.push(`  ${" ".repeat(28)} ${c.dim("each retry re-sends the edit after a read: wasted output tokens")}`);
  }

  const clean = [];
  if (summary.coveredWrites > 0) clean.push(`${plural(summary.coveredWrites, "write")} after a read`);
  if (summary.createdFiles > 0) clean.push(`${plural(summary.createdFiles, "file")} created by the agent`);
  if (clean.length > 0) {
    lines.push("");
    lines.push(c.green(`✓ ${clean.join(", ")}`));
  }

  if (summary.failedWrites > 0) {
    lines.push("");
    lines.push(c.dim(`  ${plural(summary.failedWrites, "unrelated failed write")} ignored`));
  }

  lines.push("");
  lines.push(
    `${plural(summary.riskyWrites, "risky write")}, ${plural(summary.attempts, "guard retry")} → ${verdict}`,
  );

  if (report.warnings.length > 0) {
    lines.push(c.dim(`  ${plural(report.warnings.length, "unparsed line")}; run with --json to inspect`));
  }

  return `${lines.join("\n")}\n`;
}

export function exitCodeFor(report, failOn = "write") {
  if (failOn === "none") return 0;
  if (report.summary.riskyWrites > 0) return 1;
  if (failOn === "attempt" && report.summary.attempts > 0) return 1;
  return 0;
}
