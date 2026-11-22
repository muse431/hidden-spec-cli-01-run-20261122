// mend: apply AI-written edits in four formats to a tree of text files.
// Implemented from SPEC.md: unified diffs, SEARCH/REPLACE blocks, V4A
// patches and JSON edits, with three tiers of line matching and
// all-or-nothing writes. Node 22, standard library only.
// Run as: node main.ts [options] [PATCH]
//
// When MAKEFUN_ENV_URL is set this file hands the trial over to runner.ts
// (kept as the kit ships it); otherwise it runs the CLI once.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse-level failure: exit 2 with this single line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: reported as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file split into lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** Positions of O in lines at the first tier where it occurs, or null. */
function findOccurrences(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
    const pos: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (norm(lines[i + j]!) !== norm(o[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one. */
function findFrom(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
    for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (norm(lines[i + j]!) !== norm(o[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

/** One line of the replacement text: a context line, or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  /** Index of this context line inside O; -1 for a new line. */
  ctxIdx: number;
}

/** Build the lines that replace a match at `at`, found at `tier`. */
function buildReplacement(o: string[], n: NewLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const fLead = leadingWs(fileLines[at] ?? '');
    const pLead = leadingWs(o[0]!);
    for (const item of n) {
      if (item.ctx) {
        out.push(fileLines[at + item.ctxIdx]!);
      } else if (item.text === '' || /^[ \t]+$/.test(item.text)) {
        out.push(item.text);
      } else if (item.text.startsWith(pLead)) {
        out.push(fLead + item.text.slice(pLead.length));
      } else {
        out.push(item.text);
      }
    }
    return out;
  }
  for (const item of n) {
    out.push(item.ctx ? fileLines[at + item.ctxIdx]! : item.text);
  }
  return out;
}

/** Re-indent plain new lines (no context) at tier 2; otherwise as they are. */
function buildPlainReplacement(o: string[], n: string[], fileLines: string[], at: number, tier: number): string[] {
  return buildReplacement(o, n.map((text) => ({ text, ctx: false, ctxIdx: -1 })), fileLines, at, tier);
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
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
      const st = splitFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = [...st.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: st.br, final: st.final }));
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line A (1-based, 0 when the hunk inserts at the top). */
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  noEolPlus: boolean;
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  diffOld: string | null;
  diffNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function headerPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const p = (tab < 0 ? raw : raw.slice(0, tab)).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse one hunk body starting after its header; returns the hunk and the next index. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  let j = start;
  const raw: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  // kinds[i] is 'ctx' | 'old' | 'new' | 'backslash' for raw[i].
  const kinds: string[] = [];
  for (const l of raw) {
    if (l === '') {
      kinds.push('ctx');
      o.push('');
      n.push({ text: '', ctx: true, ctxIdx: o.length - 1 });
    } else if (l[0] === ' ') {
      kinds.push('ctx');
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, ctxIdx: o.length - 1 });
    } else if (l[0] === '-') {
      kinds.push('old');
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      kinds.push('new');
      n.push({ text: l.slice(1), ctx: false, ctxIdx: -1 });
    } else {
      kinds.push('backslash');
    }
  }
  let noEol = false;
  let noEolPlus = false;
  for (let i = kinds.length - 1; i >= 0; i -= 1) {
    if (kinds[i] === 'ctx' || kinds[i] === 'new') {
      noEol = kinds[i + 1] === 'backslash';
      break;
    }
  }
  for (let i = kinds.length - 1; i >= 0; i -= 1) {
    if (kinds[i] === 'new') {
      noEolPlus = kinds[i + 1] === 'backslash';
      break;
    }
  }
  return { hunk: { a, o, n, noEol, noEolPlus }, next: j };
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line.trimEnd());
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    cur = { pairOld: null, pairNew: null, hasPair: false, diffOld, diffNew, renameOld: null, renameNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const d = parseDiffGit(line);
        if (d === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(d[0], d[1]);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        cur!.pairOld = headerPath(line);
        cur!.pairNew = headerPath(lines[i + 1]!);
        cur!.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('diff --git ')) {
        const d = parseDiffGit(line);
        if (d === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(d[0], d[1]);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (cur!.hasPair) {
          if ((lines[i + 1] ?? '').startsWith('+++ ')) {
            startSection(null, null);
            cur!.pairOld = headerPath(line);
            cur!.pairNew = headerPath(lines[i + 1]!);
            cur!.hasPair = true;
            i += 2;
            continue;
          }
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.pairOld = headerPath(line);
          cur!.pairNew = headerPath(lines[i + 1]!);
          cur!.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunkBody(lines, i + 1, a);
        cur!.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) cur!.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur!.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur!.newFile = true;
      else if (line.startsWith('deleted file mode')) cur!.delFile = true;
      i += 1;
      continue;
    }
    // After the first hunk: new sections, new hunks, everything else ignored.
    if (line.startsWith('diff --git ')) {
      const d = parseDiffGit(line);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(d[0], d[1]);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null, null);
      cur!.pairOld = headerPath(line);
      cur!.pairNew = headerPath(lines[i + 1]!);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunkBody(lines, i + 1, a);
      cur!.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply a section's hunks to a file's lines; returns the new text. */
function applyUnifiedHunks(origText: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(origText);
  const lines = [...st.lines];
  let final = st.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const ins = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = ins === lines.length;
      const seg = h.n.map((x) => x.text);
      lines.splice(ins, 0, ...seg);
      if (atEnd && seg.length > 0) final = !h.noEolPlus;
      d += h.n.length;
      continue;
    }
    const occ = findOccurrences(lines, h.o, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.pos[0]!;
    for (const p of occ.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + h.o.length === lines.length;
    const seg = buildReplacement(h.o, h.n, lines, best, occ.tier);
    lines.splice(best, h.o.length, ...seg);
    if (atEnd) final = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return joinFile({ lines, br: st.br, final });
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  let oldP: string | null = null;
  let newP: string | null = null;
  if (sec.hasPair) {
    oldP = sec.pairOld === '/dev/null' ? null : sec.pairOld;
    newP = sec.pairNew === '/dev/null' ? null : sec.pairNew;
  } else {
    oldP = sec.renameOld ?? sec.diffOld;
    newP = sec.renameNew ?? sec.diffNew;
  }
  const isCreate = sec.newFile || (sec.hasPair && sec.pairOld === '/dev/null');
  const isDelete = sec.delFile || (sec.hasPair && sec.pairNew === '/dev/null');
  return (tree) => {
    if (isCreate) {
      if (newP === null) throw new Fail('missing', oldP ?? '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEolPlus = false;
      for (const h of sec.hunks) {
        const ps = h.n.filter((x) => !x.ctx);
        if (ps.length > 0) noEolPlus = h.noEolPlus;
        for (const x of ps) plus.push(x.text);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEolPlus ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', newP ?? '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) throw new Fail('missing', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, sec.hunks, strict, p));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const occ = findOccurrences(st.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const seg = buildPlainReplacement(oldLines, newLines, st.lines, occ.pos[0]!, occ.tier);
    const lines = [...st.lines];
    lines.splice(occ.pos[0]!, oldLines.length, ...seg);
    tree.now.set(path, joinFile({ lines, br: st.br, final: st.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const lineNo = i + 1;
    i += 1;
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: V4aSection = { kind, path, lineNo, addLines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (const item of raw) {
        if (item.text.startsWith('+')) sec.addLines.push(item.text.slice(1));
        else if (item.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${item.no}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let cur: V4aChunk | null = null;
      let eofEnded = false;
      for (const item of raw) {
        const t = item.text;
        if (sec.moveTo === null && cur === null && sec.chunks.length === 0 && t.startsWith('*** Move to: ')) {
          sec.moveTo = t.slice('*** Move to: '.length).trim();
          continue;
        }
        if ((t === '*** End of File' || (t.trim() === '*** End of File' && t[0] !== ' '))) {
          if (cur === null) throw new Exit2(`error: parse ${item.no}`);
          cur.eof = true;
          sec.chunks.push(cur);
          cur = null;
          eofEnded = true;
          continue;
        }
        if (t.startsWith('@@')) {
          if (cur !== null) sec.chunks.push(cur);
          cur = { anchor: t.slice(2).trim(), o: [], n: [], eof: false };
          eofEnded = false;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length === 0 && !eofEnded) cur = { anchor: '', o: [], n: [], eof: false };
            else throw new Exit2(`error: parse ${item.no}`);
          }
          if (t === '') {
            cur.o.push('');
            cur.n.push({ text: '', ctx: true, ctxIdx: cur.o.length - 1 });
          } else if (t[0] === ' ') {
            cur.o.push(t.slice(1));
            cur.n.push({ text: t.slice(1), ctx: true, ctxIdx: cur.o.length - 1 });
          } else if (t[0] === '-') {
            cur.o.push(t.slice(1));
          } else {
            cur.n.push({ text: t.slice(1), ctx: false, ctxIdx: -1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${item.no}`);
      }
      if (cur !== null) sec.chunks.push(cur);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
    }
    sections.push(sec);
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = splitFile(before);
    const lines = [...st.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== '') {
        const found = findFrom(lines, [chunk.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos + 1;
      }
      if (chunk.o.length === 0) {
        const ins = chunk.eof ? lines.length : cursor;
        const seg = chunk.n.map((x) => x.text);
        lines.splice(ins, 0, ...seg);
        cursor = ins + seg.length;
        continue;
      }
      const found = findFrom(lines, chunk.o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const seg = buildReplacement(chunk.o, chunk.n, lines, found.pos, found.tier);
      lines.splice(found.pos, chunk.o.length, ...seg);
      cursor = found.pos + seg.length;
    }
    const out = joinFile({ lines, br: st.br, final: st.final });
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC sections 1, 2 and 10)       */
/* ------------------------------------------------------------------ */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  // Build the changed-paths rows: a successful move is one `R` line, not a `D` + `A` pair.
  const rows: { key: string; text: string; path: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, path: newP });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const r of rows) {
      const now = tree.now.get(r.path);
      if (r.text.startsWith('R ')) {
        // The old path is deleted and the new path written below; do both here.
        const pair = tree.moves.find(([o, n]) => n === r.path);
        if (pair !== undefined) {
          rmSync(pair[0], { force: true });
          mkdirSync(dirname(r.path), { recursive: true });
          writeFileSync(r.path, now ?? '');
        }
      } else if (now === null) {
        rmSync(r.path, { force: true });
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
      }
    }
    // A move whose pair was not an `R` row (e.g. the old path was recreated)
    // still needs its paths written; handle any tree entry not covered above.
    for (const p of tree.now.keys()) {
      if (rows.some((r) => r.path === p)) continue;
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
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
