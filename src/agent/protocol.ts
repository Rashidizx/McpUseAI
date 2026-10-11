import type { ToolDescription } from "../core/tool-registry.js";

/**
 * The text protocol between the bridge and a model in a web chat.
 *
 * The model writes tool calls as fenced code blocks holding JSON; the bridge
 * answers with one message starting "ZX RESULTS". A reply with no call in it
 * is the final answer. Everything here is pure: text in, text out.
 */

export type ToolCall = { tool: string; arguments: Record<string, unknown> };

export type CallResult = {
  tool: string;
  summary: string;
  ok: boolean;
  /** Tool output, or the error text when `ok` is false. */
  text: string;
};

export const RESULTS_HEADER = "ZX RESULTS";

/**
 * Sent once at the start of each conversation, glued in front of the first
 * message. Ends with a "USER REQUEST:" line, so whatever follows reads as the
 * request, whether it is the user's text or a batch of tool results.
 */
export function buildPrimer(tools: readonly ToolDescription[], workspace: string): string {
  const list = tools.map((t) => `- ${t.name} [${t.opClass}] ${t.description}`).join("\n");
  return [
    "You are working on the user's computer through a local tool bridge called ZX.",
    `Workspace folder: ${workspace}. Every path is relative to it.`,
    "",
    "To use a tool, write a fenced code block tagged zx whose content is JSON:",
    "```zx",
    '{"tool": "fs_read", "arguments": {"file_path": "README.md"}}',
    "```",
    "",
    "To write a file, leave \"content\" out of the JSON and put the file in the very next code block, as it is:",
    "```zx",
    '{"tool": "fs_write", "arguments": {"file_path": "index.html"}}',
    "```",
    "```html",
    "<!doctype html> ...",
    "```",
    "",
    "Rules:",
    "- You may write several zx blocks in one message; they run in order.",
    "- If a file you write contains ``` lines itself (Markdown), fence its content block with ```` (four backticks).",
    `- After your zx blocks (and the content block of any fs_write), stop and wait. Results arrive in the next message, starting with "${RESULTS_HEADER}".`,
    "- Never say a tool call worked before you see its result; you do not know yet.",
    "- Never end a message by announcing a step (\"first I will read…\"): if you need a tool, put its zx block in that same message. A message with no zx block ends the task.",
    "- Find things with fs_grep or fs_list before reading. Read large files in pages.",
    "- Writes and exec need the user's approval. If one is denied, do not retry it; ask or choose another way.",
    "- When the task is done, reply with your answer and no zx block. Never show a zx block as an example.",
    "- Reply in the user's language.",
    "",
    "Tools:",
    list,
    "",
    "---",
    "USER REQUEST:",
    "",
  ].join("\n");
}

/** `closed` is false when the reply ended inside the block (cut off). */
type Block = { lang: string; body: string; closed: boolean };

/** Fenced blocks in order. Line based, so a fence inside a block cannot end it early. */
export function fencedBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[i]!);
    if (open === null) continue;
    const fence = open[1]!;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j]!.trim();
      if (close.length >= fence.length && close === fence[0]!.repeat(close.length)) break;
      body.push(lines[j]!);
    }
    blocks.push({ lang: open[2]!.toLowerCase(), body: body.join("\n"), closed: j < lines.length });
    i = j;
  }
  return blocks;
}

/**
 * Tool calls in a reply.
 *
 * A block counts when it is tagged `zx`, `json` or nothing, and its JSON names
 * a registered tool. Some sites drop the language tag when they render, so an
 * untagged block has to be accepted; other languages never are, so code the
 * model shows as an example is not run. Problems are reported only for blocks
 * tagged `zx`, which the model clearly meant as calls.
 */
export function parseCalls(text: string, known: ReadonlySet<string>): { calls: ToolCall[]; errors: string[] } {
  const calls: ToolCall[] = [];
  const errors: string[] = [];

  // Results the model wrote itself are not results; nothing after them is acted on.
  const invented = text.indexOf(RESULTS_HEADER);
  const blocks = fencedBlocks(invented >= 0 ? text.slice(0, invented) : text);
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    if (block.lang !== "zx" && block.lang !== "json" && block.lang !== "") continue;
    const strict = block.lang === "zx";

    let value: unknown;
    try {
      value = JSON.parse(block.body);
    } catch (error) {
      try {
        value = JSON.parse(repairJson(block.body));
      } catch {
        if (strict) errors.push(`a zx block is not valid JSON (${(error as Error).message})`);
        continue;
      }
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || typeof item !== "object" || typeof (item as { tool?: unknown }).tool !== "string") {
        if (strict) errors.push('a zx block must hold {"tool": "...", "arguments": {...}}');
        continue;
      }
      const { tool, arguments: args } = item as { tool: string; arguments?: unknown };
      if (!known.has(tool)) {
        if (strict) errors.push(`unknown tool "${tool}". Available: ${[...known].join(", ")}`);
        continue;
      }
      const call: ToolCall = {
        tool,
        arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {},
      };
      // fs_write without content takes the next code block, verbatim. Files
      // are far easier for a model to write as code than as an escaped string.
      const next = blocks[index + 1];
      if (tool === "fs_write" && typeof call.arguments.content !== "string" && next !== undefined && (next.lang !== "zx" || !/^\s*[[{]/.test(next.body))) {
        index++;
        // A content block the reply ended inside would write half a file.
        if (!next.closed) {
          errors.push(`the content block for ${String(call.arguments.file_path ?? "fs_write")} was cut off; send the whole file again`);
          continue;
        }
        call.arguments.content = next.body.endsWith("\n") ? next.body : `${next.body}\n`;
      }
      // Nothing to write: tell the model how, rather than letting the tool fail.
      if (tool === "fs_write" && typeof call.arguments.content !== "string") {
        errors.push(
          `fs_write for ${String(call.arguments.file_path)} has no content: put the file in a code block right after the zx block, or in "content"`,
        );
        continue;
      }
      calls.push(call);
    }
  }
  return { calls, errors };
}

/**
 * Fix the two mistakes models make most in hand-written JSON: real line breaks
 * or tabs inside a string (common when the string is file content), and a
 * trailing comma before `}` or `]`. Anything else is left for the model to fix.
 */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (char === "\n") {
        out += "\\n";
        continue;
      } else if (char === "\r") {
        out += "\\r";
        continue;
      } else if (char === "\t") {
        out += "\\t";
        continue;
      }
    } else if (char === '"') inString = true;
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Render a tool's `data` as text a model reads well. */
export function renderData(data: unknown, summary: string): string {
  if (data === undefined || data === null) return summary;
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.text === "string") {
      const { text, ...meta } = record;
      return `${JSON.stringify(meta)}\n${text}`;
    }
    if (typeof record.stdout === "string" || typeof record.stderr === "string") {
      const { stdout, stderr, ...meta } = record;
      return `${JSON.stringify(meta)}\n--- stdout ---\n${stdout ?? ""}\n--- stderr ---\n${stderr ?? ""}`;
    }
  }
  return JSON.stringify(data, null, 1);
}

/** One message carrying every result, kept under `maxChars`. */
export function formatResults(results: readonly CallResult[], maxChars: number): string {
  // Each result's header and fences take room too; the floor stays small so many results still fit.
  const share = Math.max(200, Math.floor((maxChars - 400 - results.length * 160) / Math.max(1, results.length)));
  const parts = results.map((result, index) => {
    let body = result.text;
    if (body.length > share) {
      body = `${body.slice(0, share)}\n[... ${body.length - share} more characters cut; ask for a smaller range]`;
    }
    const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
    const status = result.ok ? "ok" : "error";
    return `### ${index + 1}. ${result.tool}: ${result.summary} (${status})\n${fence}\n${body}\n${fence}`;
  });
  return [
    RESULTS_HEADER,
    ...parts,
    "Continue. Use zx blocks for more tool calls, or reply without one when the task is done.",
  ].join("\n\n");
}

/** Tell the model its call blocks could not be used. */
export function formatParseErrors(errors: readonly string[]): string {
  return [
    RESULTS_HEADER,
    "None of your tool calls ran:",
    ...errors.map((e) => `- ${e}`),
    "Fix the zx block and send it again.",
  ].join("\n");
}

function longestRun(text: string, char: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
