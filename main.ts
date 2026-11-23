// main.ts is mend, the CLI SPEC.md specifies: it applies an AI-written edit, in any of four formats, to a tree of
// text files. Sections 1 to 4, 9 and 10 are the kit's starter (MIT): the command line, the output and exit codes,
// safe paths, format detection, JSON edits and the all-or-nothing write. Sections 5 to 8 are this entry's work:
// matching lines at three tiers with tier-2 re-indentation, unified diffs (nearest-occurrence hunks, creations,
// deletions, moves, `\ No newline at end of file`), SEARCH/REPLACE blocks (path recovery, ambiguity) and V4A patches
// (anchors, cursors, end-of-file chunks, moves), plus the `R old -> new` line for a successful move. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. The output turns a move's D and A lines into one R line. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- SPEC.md section 5: files, lines, matching ----------

/** A file as lines: its own line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every position where O occurs in lines at tier, at or after `from`. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found { tier: number; occ: number[]; }

/** The first tier (0..2, or 0 alone under --strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk or chunk body: context (in O and N), old (O only), new (N only). */
interface BodyItem { kind: 'ctx' | 'old' | 'new'; text: string; backslash: boolean; }

interface ON {
  o: string[];
  n: { text: string; ctx: number }[]; // ctx: index into O when a context line, else -1
}

function buildON(items: BodyItem[]): ON {
  const o: string[] = [];
  const n: { text: string; ctx: number }[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') { n.push({ text: it.text, ctx: o.length }); o.push(it.text); }
    else if (it.kind === 'old') o.push(it.text);
    else n.push({ text: it.text, ctx: -1 });
  }
  return { o, n };
}

/** The lines that replace O at pos: context lines as the file's own matched lines, tier-2 re-indent for the rest. */
function replacement(fileLines: string[], pos: number, on: ON, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && on.o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(on.o[0]!);
  }
  const out: string[] = [];
  for (const item of on.n) {
    if (item.ctx >= 0) { out.push(fileLines[pos + item.ctx]!); continue; }
    let t = item.text;
    // Section 5: at tier 2 every non-context line of N is re-indented ("every other line" is
    // other than a context line, not other than the first line: the first N line is re-indented too).
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// ---------- SPEC.md section 6: unified diffs ----------

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

interface Hunk {
  a: number;
  items: BodyItem[];
  /** a `\` line follows the hunk's last context or `+` line */
  lastBackslash: boolean;
  /** a `\` line follows the hunk's last `+` line */
  lastPlusBackslash: boolean;
  hasPlus: boolean;
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: after the four characters, up to the first tab, surrounding spaces removed, a/ or b/ removed. */
function uniPath(raw: string): string {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +/, '').replace(/ +$/, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A section's header: the lines before its first hunk. Returns the index of the next line to handle. */
function uniHeader(lines: string[], start: number, sec: USection): number {
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.pairOld !== null) return i;
        sec.pairOld = uniPath(line);
        sec.pairNew = uniPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (HUNK_HEAD.test(line)) return i;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
    else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
    else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.createMode = true;
    else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.deleteMode = true;
    i += 1;
  }
  return i;
}

/** A section's hunks and the lines between them. Returns the index of the next line to handle. */
function uniBody(lines: string[], start: number, sec: USection): number {
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    const hm = HUNK_HEAD.exec(line);
    if (hm !== null) {
      const hunk: Hunk = { a: Number(hm[1]), items: [], lastBackslash: false, lastPlusBackslash: false, hasPlus: false };
      sec.hunks.push(hunk);
      i += 1;
      const raw: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      for (const bl of raw) {
        if (bl.startsWith('\\')) {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.backslash = true;
          continue;
        }
        if (bl === '') hunk.items.push({ kind: 'ctx', text: '', backslash: false });
        else if (bl.startsWith(' ')) hunk.items.push({ kind: 'ctx', text: bl.slice(1), backslash: false });
        else if (bl.startsWith('-')) hunk.items.push({ kind: 'old', text: bl.slice(1), backslash: false });
        else hunk.items.push({ kind: 'new', text: bl.slice(1), backslash: false });
      }
      for (let k = hunk.items.length - 1; k >= 0; k -= 1) {
        const it = hunk.items[k]!;
        if (it.kind === 'ctx' || it.kind === 'new') { hunk.lastBackslash = it.backslash; break; }
      }
      for (let k = hunk.items.length - 1; k >= 0; k -= 1) {
        const it = hunk.items[k]!;
        if (it.kind === 'new') { hunk.lastPlusBackslash = it.backslash; hunk.hasPlus = true; break; }
      }
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { pairOld: null, pairNew: null, renameOld: null, renameNew: null, diffOld: m[1]!, diffNew: m[2]!, createMode: false, deleteMode: false, hunks: [] };
      sections.push(sec);
      i += 1;
      i = uniHeader(lines, i, sec);
      i = uniBody(lines, i, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { pairOld: uniPath(line), pairNew: uniPath(lines[i + 1]!), renameOld: null, renameNew: null, diffOld: null, diffNew: null, createMode: false, deleteMode: false, hunks: [] };
      sections.push(sec);
      i += 2;
      i = uniHeader(lines, i, sec);
      i = uniBody(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** A section's hunks, in order, each on the result of the ones before it. */
function applyUnifiedHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const on = buildON(h.items);
    if (on.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > doc.lines.length) pos = doc.lines.length;
      const atEnd = pos === doc.lines.length;
      const repl = on.n.map((x) => x.text);
      doc.lines.splice(pos, 0, ...repl);
      if (atEnd) doc.final = !h.lastBackslash;
      d += on.n.length;
    } else {
      const found = findTier(doc.lines, on.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const repl = replacement(doc.lines, best, on, found.tier);
      const runsToEnd = best + on.o.length === doc.lines.length;
      doc.lines.splice(best, on.o.length, ...repl);
      if (runsToEnd) doc.final = !h.lastBackslash;
      d += on.n.length - on.o.length;
    }
  }
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameOld ?? sec.diffOld ?? '';
  const newPath = sec.pairNew ?? sec.renameNew ?? sec.diffNew ?? '';
  const create = sec.createMode || oldPath === '/dev/null';
  const del = sec.deleteMode || newPath === '/dev/null';
  return (tree: Tree) => {
    if (create) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') out.push(it.text);
        if (h.hasPlus) lastPlusBackslash = h.lastPlusBackslash;
      }
      tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (del) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const doc = parseDoc(before);
      applyUnifiedHunks(doc, sec.hunks, strict, oldPath);
      tree.now.set(newPath, renderDoc(doc));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const doc = parseDoc(before);
    applyUnifiedHunks(doc, sec.hunks, strict, oldPath);
    tree.now.set(oldPath, renderDoc(doc));
  };
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, o, nw) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const found = findTier(doc.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const on: ON = { o, n: nw.map((text) => ({ text, ctx: -1 })) };
      doc.lines.splice(pos, o.length, ...replacement(doc.lines, pos, on, found.tier));
      tree.now.set(p, renderDoc(doc));
    })(path, oldLines, newLines));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- SPEC.md section 8: V4A patches ----------

interface VChunk { anchor: string | null; items: BodyItem[]; eof: boolean; }
interface RawLine { text: string; no: number; }

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = trimSpaces(line.slice(prefix.length));
    const headerNo = i + 1;
    i += 1;
    const raw: RawLine[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (isStart(l)) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, raw));
    else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
    } else edits.push(v4aUpdateEdit(path, raw, headerNo, strict));
  }
  return edits;
}

function v4aAddEdit(path: string, raw: RawLine[]): Edit {
  const fileLines: string[] = [];
  for (const r of raw) {
    if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
    else if (r.text === '') fileLines.push('');
    else throw new Exit2(`error: parse ${r.no}`);
  }
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aUpdateEdit(path: string, raw: RawLine[], headerNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(raw[0]!.text.slice('*** Move to: '.length));
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = start; k < raw.length; k += 1) {
    const r = raw[k]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = trimSpaces(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) cur = { anchor: null, items: [], eof: true };
      else cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        cur = { anchor: null, items: [], eof: false };
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '', backslash: false });
      else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
      else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1), backslash: false });
      else cur.items.push({ kind: 'new', text: l.slice(1), backslash: false });
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      const on = buildON(ch.items);
      if (ch.anchor !== null) {
        let foundAt = -1;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && foundAt < 0; t += 1) {
          for (let j = cursor; j < doc.lines.length; j += 1) {
            if (tierEq(doc.lines[j]!, ch.anchor, t)) { foundAt = j; break; }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (on.o.length === 0) {
        const pos = ch.eof ? doc.lines.length : cursor;
        const repl = on.n.map((x) => x.text);
        doc.lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && chosen === null; t += 1) {
          for (const p of occurrences(doc.lines, on.o, t, cursor)) {
            if (ch.eof && p + on.o.length !== doc.lines.length) continue;
            chosen = { tier: t, pos: p };
            break;
          }
        }
        if (chosen === null) throw new Fail('no-match', path);
        const repl = replacement(doc.lines, chosen.pos, on, chosen.tier);
        doc.lines.splice(chosen.pos, on.o.length, ...repl);
        cursor = chosen.pos + repl.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byPath)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  let rows: { key: string; line: string }[] = changed.map((p) => {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    return { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
  });
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.key === oldP && r.line.startsWith('D '));
    const ai = rows.findIndex((r) => r.key === newP && r.line.startsWith('A '));
    if (di >= 0 && ai >= 0) {
      rows = rows.filter((_, idx) => idx !== di && idx !== ai);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => byPath(a.key, b.key));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
