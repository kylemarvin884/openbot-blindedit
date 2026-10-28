// Transcript parsing for blindedit.
//
// Supports three shapes:
//   1. Claude Code JSONL  ({type, message:{content:[{type:"tool_use"}]}, toolUseResult})
//   2. OpenAI-style       ({tool_calls:[{id, function:{name, arguments}}]})
//   3. Generic line       ({tool, input, result})
//
// The parser is tolerant: a line that is not JSON is skipped with a warning and
// every event keeps its source line number so the report can point at it.

import path from "node:path";

const READ_TOOLS = new Set([
  "read",
  "readfile",
  "readfiles",
  "readtextfile",
  "view",
  "openfile",
  "fileread",
  "filesystemread",
  "filesystemreadfile",
]);

const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "writefile",
  "strreplace",
  "strreplaceeditor",
  "applypatch",
  "applydiff",
  "createfile",
  "notebookedit",
  "replacefile",
]);

const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "runcommand", "terminal", "powershell"]);

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
  "target_file",
  "targetFile",
  "notebook_path",
  "notebookPath",
  "absolute_path",
  "absolutePath",
];

const GUARD_RE =
  /(has not been read yet|read it first before writing|must (?:be )?read (?:the )?file.*before|file has not been read)/i;

const COMMAND_READERS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "type",
  "get-content",
  "gc",
]);

/**
 * @typedef {Object} TranscriptEvent
 * @property {number} index
 * @property {number} line
 * @property {string|null} at
 * @property {"read"|"write"|"command"|"other"} kind
 * @property {string} tool
 * @property {string|null} path
 * @property {string|null} command
 * @property {string|null} id
 * @property {string} mode   create | edit | overwrite | write-unknown | read | command | other
 * @property {boolean} isError
 * @property {string} resultText
 */

export function parseTranscript(text, { file = "" } = {}) {
  const lines = String(text).split(/\r?\n/);
  const events = [];
  const pendingResults = new Map();
  const warnings = [];
  let cwd = null;
  let format = "unknown";
  let parsedLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`line ${i + 1}: not valid JSON, skipped`);
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    parsedLines += 1;
    if (!cwd) cwd = firstCwd(obj);
    const at = toIso(firstTimestamp(obj));

    for (const result of resultBlocks(obj)) {
      if (result.id) pendingResults.set(result.id, result);
    }

    const blocks = toolBlocks(obj);
    if (blocks.length === 0) continue;

    if (obj.sessionId && obj.message) format = format === "unknown" ? "claude-code" : format;
    else if (Array.isArray(obj.tool_calls) || (obj.role && obj.message !== undefined)) {
      format = format === "unknown" ? "openai" : format;
    } else if (typeof obj.tool === "string" || typeof obj.tool_name === "string") {
      format = format === "unknown" ? "generic" : format;
    }

    for (const block of blocks) {
      const input = asObject(block.input);
      const tool = String(block.name ?? "");
      const kind = classifyTool(tool, input);
      const event = {
        index: events.length,
        line: i + 1,
        at,
        kind,
        tool,
        path: extractPath(input),
        command: extractCommand(input),
        id: block.id ?? null,
        mode: kind === "write" ? writeMode(tool, input, null) : kind,
        isError: false,
        resultText: "",
      };
      events.push(event);
    }
  }

  for (const event of events) {
    const result = event.id ? pendingResults.get(event.id) : null;
    if (!result) continue;
    event.isError = result.isError;
    event.resultText = result.text;
    if (event.kind === "write") {
      event.mode = writeMode(event.tool, {}, result);
    }
  }

  return { file, format, cwd, events, warnings, lines: lines.length, parsedLines };
}

export function normalizeToolName(name) {
  return String(name)
    .toLowerCase()
    .split(/__|\.|\//)
    .pop()
    .replace(/[^a-z0-9]/g, "");
}

export function classifyTool(name, input) {
  const normalized = normalizeToolName(name);
  const command = String(input?.command ?? "").toLowerCase();
  if (READ_TOOLS.has(normalized)) return "read";
  // Claude's older editor tool reads when command is "view".
  if ((normalized === "strreplaceeditor" || normalized === "edit") && command === "view") return "read";
  if (WRITE_TOOLS.has(normalized)) return "write";
  if (COMMAND_TOOLS.has(normalized)) return "command";
  return "other";
}

export function writeMode(toolName, input, result) {
  const normalized = normalizeToolName(toolName);
  const action = String(input?.command ?? "").toLowerCase();

  if (normalized === "createfile") return "create";
  if ((normalized === "strreplaceeditor" || normalized === "edit") && action === "create") return "create";
  if (result && !result.isError) {
    if (result.createType === "create" || /file created successfully|successfully created/i.test(result.text)) {
      return "create";
    }
    if (normalized === "write" || normalized === "writefile" || normalized === "replacefile") {
      if (result.createType === "update" || result.text) return "overwrite";
    }
  }
  if (normalized === "write" || normalized === "writefile" || normalized === "replacefile") {
    return result ? "overwrite" : "write-unknown";
  }
  if (normalized === "applypatch" || normalized === "applydiff") return "edit";
  return "edit";
}

export function extractPath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractCommand(input) {
  if (!input || typeof input !== "object") return null;
  const value = input.command ?? input.cmd ?? input.script;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Extract file paths a shell command read directly (cat/head/tail/sed -n/Get-Content).
 * Deliberately conservative: stops at pipes/redirects and ignores globs.
 */
export function commandReadPaths(command) {
  if (!command) return [];
  const head = String(command).split(/[|><;]|&&/)[0].trim();
  if (!head) return [];

  const tokens = head.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return [];

  const argv0 = stripQuotes(tokens[0]).toLowerCase().replace(/^.*[\\/]/, "");
  const isSed = argv0 === "sed";
  if (!COMMAND_READERS.has(argv0) && !isSed) return [];
  if (isSed && !tokens.slice(1).some((token) => token === "-n" || token.startsWith("-n"))) return [];

  const files = [];
  for (const raw of tokens.slice(1)) {
    const token = stripQuotes(raw);
    if (!token || token.startsWith("-") || token.startsWith("$")) continue;
    if (/^\d+$/.test(token)) continue;
    if (/[*?[\]{}]/.test(token)) continue;
    if (isSed && (/^\d+[,;]?\d*[pd]?$/.test(token) || token.startsWith("s/"))) continue;
    files.push(token);
  }
  return files;
}

export function resolvePath(value, cwd) {
  if (!value) return null;
  // Transcripts carry the cwd of the machine that produced them. A POSIX cwd
  // or an absolute POSIX path must not be re-rooted onto a Windows drive.
  if (process.platform === "win32" && (isPosixPath(value) || (cwd && isPosixPath(cwd)))) {
    const base = cwd && isPosixPath(cwd) ? cwd : "/";
    return path.posix.resolve(base, value);
  }
  const base = cwd || process.cwd();
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function isPosixPath(value) {
  return String(value).startsWith("/") && !/^[A-Za-z]:/.test(String(value));
}

export function pathKey(absolute) {
  const posix = String(absolute).replace(/\\/g, "/");
  return process.platform === "win32" ? posix.toLowerCase() : posix;
}

export function displayPath(absolute, root) {
  const posix = String(absolute).replace(/\\/g, "/");
  if (!root) return posix;
  let rootPosix = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!rootPosix.startsWith("/") && !/^[A-Za-z]:\//.test(rootPosix)) {
    rootPosix = String(path.resolve(root)).replace(/\\/g, "/").replace(/\/+$/, "");
  }
  const comparable = process.platform === "win32" ? posix.toLowerCase() : posix;
  const comparableRoot = process.platform === "win32" ? rootPosix.toLowerCase() : rootPosix;
  if (comparable === comparableRoot) return ".";
  return comparable.startsWith(`${comparableRoot}/`) ? posix.slice(rootPosix.length + 1) : posix;
}

function toolBlocks(obj) {
  const blocks = [];
  const message = obj.message && typeof obj.message === "object" ? obj.message : obj;

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "tool_use" && part.name) {
        blocks.push({ id: part.id ?? part.tool_use_id ?? null, name: part.name, input: part.input });
      }
    }
  }

  const callGroups = message === obj ? [obj.tool_calls] : [message.tool_calls, obj.tool_calls];
  for (const calls of callGroups) {
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const name = call.function?.name ?? call.name ?? call.tool;
      const input = call.function?.arguments ?? call.arguments ?? call.input;
      if (name) blocks.push({ id: call.id ?? call.tool_call_id ?? null, name, input });
    }
  }

  if (typeof obj.tool === "string") {
    blocks.push({ id: obj.id ?? null, name: obj.tool, input: obj.input ?? obj.args ?? obj.state?.input });
  }
  if (typeof obj.tool_name === "string") {
    blocks.push({ id: obj.id ?? null, name: obj.tool_name, input: obj.tool_input ?? obj.input ?? obj.args });
  }
  if (obj.state && typeof obj.state === "object" && obj.state.tool) {
    blocks.push({ id: obj.state.id ?? null, name: obj.state.tool, input: obj.state.input });
  }

  return blocks;
}

function resultBlocks(obj) {
  const blocks = [];
  const message = obj.message && typeof obj.message === "object" ? obj.message : obj;
  const list = Array.isArray(message.content) ? message.content : [];
  const legacy = Array.isArray(obj.tool_results) ? obj.tool_results : [];

  for (const part of [...list, ...legacy]) {
    if (!part || part.type !== "tool_result") continue;
    const toolUseResult = obj.toolUseResult;
    blocks.push({
      id: part.tool_use_id ?? part.id ?? part.tool_call_id ?? null,
      isError: Boolean(part.is_error ?? part.isError),
      text: resultText(part.content, toolUseResult),
      createType: createTypeOf(toolUseResult),
    });
  }
  return blocks;
}

function resultText(content, toolUseResult) {
  const parts = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item.text === "string") parts.push(item.text);
    }
  }
  if (typeof toolUseResult === "string") parts.push(toolUseResult);
  else if (toolUseResult && typeof toolUseResult === "object" && typeof toolUseResult.error === "string") {
    parts.push(toolUseResult.error);
  }
  return parts.join("\n");
}

function createTypeOf(toolUseResult) {
  if (!toolUseResult || typeof toolUseResult !== "object") return null;
  if (toolUseResult.type === "create" || toolUseResult.type === "update") return toolUseResult.type;
  if (toolUseResult.file && toolUseResult.file.type) return toolUseResult.file.type;
  return null;
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stripQuotes(value) {
  return String(value).replace(/^["']|["']$/g, "");
}

function firstTimestamp(obj) {
  const candidates = [
    obj.timestamp,
    obj.ts,
    obj.time,
    obj.created_at,
    obj.createdAt,
    obj.message?.timestamp,
    obj.state?.time?.created,
  ];
  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function firstCwd(obj) {
  const candidates = [obj.cwd, obj.project?.cwd, obj.message?.cwd, obj.state?.cwd];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : null;
}

export { GUARD_RE };
