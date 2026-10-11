/**
 * Line diff for showing file changes, git style. Myers' O((N+M)D) algorithm
 * after trimming the common prefix and suffix, which is where most edits leave
 * almost everything.
 */

export type DiffLine = { type: " " | "+" | "-"; text: string; old?: number; new?: number };
export type Hunk = { oldStart: number; newStart: number; lines: DiffLine[] };
export type FileDiff = { path: string; added: number; removed: number; created: boolean; hunks: Hunk[]; truncated: boolean };

const CONTEXT = 3;
const MAX_LINES_SHOWN = 1500;
/** Beyond this many differing lines the edit path is not worth computing. */
const MAX_EDIT = 4000;
/** The search keeps one row per edit distance; past this many cells (about 16 MB) it gives up. */
const MAX_TRACE_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The edit script from `a` to `b`, as one entry per line. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head: DiffLine[] = a.slice(0, start).map((text, i) => ({ type: " ", text, old: i + 1, new: i + 1 }));
  const tail: DiffLine[] = a.slice(endA).map((text, i) => ({ type: " ", text, old: endA + i + 1, new: endB + i + 1 }));
  const middle = myers(a.slice(start, endA), b.slice(start, endB), start);
  return [...head, ...middle, ...tail];
}

function myers(a: readonly string[], b: readonly string[], offset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  // Nothing in common worth searching for: everything old goes, everything new comes.
  const wholesale = (): DiffLine[] => [
    ...a.map((text, i): DiffLine => ({ type: "-", text, old: offset + i + 1 })),
    ...b.map((text, i): DiffLine => ({ type: "+", text, new: offset + i + 1 })),
  ];
  if (n === 0 || m === 0 || max > MAX_EDIT * 2) return wholesale();

  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    // Two very different files: memory and time grow with every step, so stop early.
    if ((d + 1) * v.length > MAX_TRACE_CELLS) return wholesale();
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[max + k - 1]! < vd[max + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[max + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ type: " ", text: a[x]!, old: offset + x + 1, new: offset + y + 1 });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        out.push({ type: "+", text: b[y]!, new: offset + y + 1 });
      } else {
        x--;
        out.push({ type: "-", text: a[x]!, old: offset + x + 1 });
      }
    }
  }
  return out.reverse();
}

/** Group changes into hunks with a few lines of context, like `git diff`. */
export function fileDiff(path: string, before: string | null, after: string): FileDiff {
  const lines = diffLines(splitLines(before ?? ""), splitLines(after));
  const added = lines.filter((l) => l.type === "+").length;
  const removed = lines.filter((l) => l.type === "-").length;

  const hunks: Hunk[] = [];
  let shown = 0;
  let truncated = false;
  let current: Hunk | null = null;
  let lastChange = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const near = lines.slice(i, i + CONTEXT + 1).some((l) => l.type !== " ");
    const line = lines[i]!;
    if (line.type !== " ") lastChange = i;
    if (line.type === " " && !near && i - lastChange > CONTEXT) {
      current = null;
      continue;
    }
    if (shown >= MAX_LINES_SHOWN) {
      truncated = true;
      break;
    }
    if (current === null) {
      current = { oldStart: line.old ?? (line.new ?? 1), newStart: line.new ?? (line.old ?? 1), lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
    shown++;
  }
  return { path, added, removed, created: before === null, hunks, truncated };
}

