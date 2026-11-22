// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Old/new pairs of move edits that succeeded, for the `R` output lines. */
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

/** A file's text split into lines: its own break, and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier sees it: 0 exact, 1 without trailing spaces/tabs, 2 without either end. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at or after `from` where O occurs at this tier (overlaps allowed). */
function findOccurrences(file: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const want = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= file.length; i++) {
    if (eofOnly && i + o.length !== file.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function matchAt(file: string[], o: string[], strict: boolean, from: number, eofOnly = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(file, o, t, from, eofOnly);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(file: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = Math.max(0, from); i < file.length; i++) {
      if (normLine(file[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** One line of an old/new pair. A context line is written as the file's own matched line. */
interface PairLine {
  text: string;
  context: boolean;
}

/** The lines N writes when O matched at `pos`: context lines from the file, other lines re-indented at tier 2. */
function replacementLines(file: string[], pos: number, o: PairLine[], n: PairLine[], tier: number): string[] {
  const out: string[] = [];
  const ctxAt: number[] = [];
  o.forEach((l, i) => {
    if (l.context) ctxAt.push(i);
  });
  let k = 0;
  const f = tier === 2 && o.length > 0 ? leading(file[pos] ?? '') : '';
  const p = tier === 2 && o.length > 0 ? leading(o[0]!.text) : '';
  for (const item of n) {
    if (item.context) {
      out.push(file[pos + ctxAt[k++]!]!);
    } else if (tier === 2 && item.text !== '' && !/^[ \t]*$/.test(item.text) && item.text.startsWith(p)) {
      out.push(f + item.text.slice(p.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** Replace O at `pos` in the file's lines with N. */
function spliceLines(file: string[], pos: number, o: PairLine[], n: PairLine[], tier: number): string[] {
  const rep = replacementLines(file, pos, o, n, tier);
  return [...file.slice(0, pos), ...rep, ...file.slice(pos + o.length)];
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

/** One hunk of a unified section: O its context and `-` lines, N its context and `+` lines. */
interface Hunk {
  a: number;
  o: PairLine[];
  n: PairLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoBreak: boolean;
}

interface Section {
  dashOld: string | undefined;
  dashNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  delete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** A `--- `/`+++ ` path: after the four characters, up to the first tab, spaces trimmed, `a/`/`b/` removed. */
function dashPath(l: string): string {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(head: RegExpExecArray, body: string[]): Hunk {
  const items: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[] = [];
  for (const b of body) {
    if (b === '') items.push({ kind: 'ctx', text: '' });
    else if (b.startsWith(' ')) items.push({ kind: 'ctx', text: b.slice(1) });
    else if (b.startsWith('-')) items.push({ kind: 'old', text: b.slice(1) });
    else if (b.startsWith('+')) items.push({ kind: 'new', text: b.slice(1) });
    else items.push({ kind: 'bs', text: b });
  }
  const o: PairLine[] = [];
  const n: PairLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push({ text: it.text, context: true });
      n.push({ text: it.text, context: true });
    } else if (it.kind === 'old') o.push({ text: it.text, context: false });
    else if (it.kind === 'new') n.push({ text: it.text, context: false });
  }
  let lastCtx = -1;
  let lastPlus = -1;
  items.forEach((it, i) => {
    if (it.kind === 'ctx' || it.kind === 'new') lastCtx = i;
    if (it.kind === 'new') lastPlus = i;
  });
  return {
    a: Number(head[1]),
    o,
    n,
    noBreak: lastCtx >= 0 && items[lastCtx + 1]?.kind === 'bs',
    plusNoBreak: lastPlus >= 0 && items[lastPlus + 1]?.kind === 'bs',
  };
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first hunk that fails. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): FileText {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      const ins = h.n.map((l) => l.text);
      f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos)];
      if (atEnd) f.finalBreak = !h.noBreak;
    } else {
      const m = matchAt(f.lines, h.o.map((l) => l.text), strict, 0);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.positions[0]!;
      for (const p of m.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.o.length === f.lines.length;
      f.lines = spliceLines(f.lines, best, h.o, h.n, m.tier);
      if (atEnd) f.finalBreak = !h.noBreak;
    }
    d += h.n.length - h.o.length;
  }
  return f;
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldRaw = s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
  const newRaw = s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
  const old = oldRaw === '/dev/null' ? null : (oldRaw ?? null);
  const nw = newRaw === '/dev/null' ? null : (newRaw ?? null);
  const create = s.create || s.dashOld === '/dev/null';
  const del = s.delete || s.dashNew === '/dev/null';
  return (tree) => {
    if (old !== null && !safe(old)) throw new Fail('unsafe', old);
    if (nw !== null && !safe(nw)) throw new Fail('unsafe', nw);
    if (create) {
      if (nw === null) return;
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const lines: string[] = [];
      for (const h of s.hunks) for (const item of h.n) if (!item.context) lines.push(item.text);
      let finalBreak = true;
      for (let i = s.hunks.length - 1; i >= 0; i--) {
        if (s.hunks[i]!.n.some((l) => !l.context)) {
          finalBreak = !s.hunks[i]!.plusNoBreak;
          break;
        }
      }
      tree.now.set(nw, lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (del) {
      if (old === null) return;
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return;
    }
    if (old !== null && nw !== null && old !== nw) {
      const before = tree.get(old);
      if (before === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const f = applyHunks(before, s.hunks, strict, old);
      tree.now.set(old, null);
      tree.now.set(nw, joinFile(f));
      tree.moves.push([old, nw]);
      return;
    }
    const p = old ?? nw;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(before, s.hunks, strict, p)));
  };
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const m = matchAt(f.lines, oldLines, strict, 0);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const o: PairLine[] = oldLines.map((t) => ({ text: t, context: false }));
    const n: PairLine[] = newLines.map((t) => ({ text: t, context: false }));
    f.lines = spliceLines(f.lines, m.positions[0]!, o, n, m.tier);
    tree.now.set(path, joinFile(f));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into edits, in order. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** Read a unified patch (SPEC.md section 6) into edits, in order. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasDashPair = false;
  const fresh = (): Section => ({ dashOld: undefined, dashNew: undefined, renameFrom: undefined, renameTo: undefined, diffOld: undefined, diffNew: undefined, create: false, delete: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      hasDashPair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasDashPair) {
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        hasDashPair = true;
      } else {
        cur = fresh();
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
        hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunk(m, body));
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.dashNew = dashPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One V4A chunk: O its context and `-` lines, N its context and `+` lines. */
interface VChunk {
  anchor: string | null;
  o: PairLine[];
  n: PairLine[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((l) => l.text);
        f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos)];
        cursor = pos + ins.length;
      } else {
        const m = matchAt(f.lines, ch.o.map((l) => l.text), strict, cursor, ch.eof);
        if (m === null) throw new Fail('no-match', path);
        const pos = m.positions[0]!;
        f.lines = spliceLines(f.lines, pos, ch.o, ch.n, m.tier);
        cursor = pos + ch.n.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

const V4A_SECTION = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Read a V4A patch (SPEC.md section 8) into edits, in order. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const bodyIdx: number[] = [];
      i += 1;
      while (i < last && !V4A_SECTION(lines[i]!)) {
        bodyIdx.push(i);
        i += 1;
      }
      while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
      const fileLines: string[] = [];
      for (const bi of bodyIdx) {
        const b = lines[bi]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${bi + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i += 1;
      while (i < last && !V4A_SECTION(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateLineNo = i + 1;
      const bodyIdx: number[] = [];
      i += 1;
      while (i < last && !V4A_SECTION(lines[i]!)) {
        bodyIdx.push(i);
        i += 1;
      }
      while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
      let k = 0;
      while (k < bodyIdx.length && blank(lines[bodyIdx[k]!]!)) k += 1;
      let moveTo: string | null = null;
      if (k < bodyIdx.length && lines[bodyIdx[k]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[bodyIdx[k]!]!.slice(13).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; items: { kind: 'ctx' | 'old' | 'new'; text: string }[]; eof: boolean } | null = null;
      const close = (): void => {
        if (cur === null) return;
        const o: PairLine[] = [];
        const n: PairLine[] = [];
        for (const it of cur.items) {
          if (it.kind === 'ctx') {
            o.push({ text: it.text, context: true });
            n.push({ text: it.text, context: true });
          } else if (it.kind === 'old') o.push({ text: it.text, context: false });
          else n.push({ text: it.text, context: false });
        }
        chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
        cur = null;
      };
      for (; k < bodyIdx.length; k++) {
        const bi = bodyIdx[k]!;
        const b = lines[bi]!;
        if (b.startsWith('@@')) {
          close();
          cur = { anchor: b.slice(2).trim(), items: [], eof: false };
          continue;
        }
        if (b === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            close();
          }
          continue;
        }
        if (b.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${bi + 1}`);
        if (blank(b)) {
          if (cur !== null) cur.items.push({ kind: 'ctx', text: '' });
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${bi + 1}`);
            cur = { anchor: null, items: [], eof: false };
          }
          cur.items.push({ kind: b.startsWith(' ') ? 'ctx' : b.startsWith('-') ? 'old' : 'new', text: b.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${bi + 1}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  const rowByPath = new Map<string, string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowByPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      if (rowByPath.has(old) && rowByPath.has(nw)) {
        rows.push({ key: nw, line: `R ${old} -> ${nw}` });
        used.add(old);
        used.add(nw);
      }
    }
  }
  for (const p of changed) {
    if (!used.has(p)) rows.push({ key: p, line: rowByPath.get(p)! });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
