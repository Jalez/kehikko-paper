/**
 * A LaTeX -> renderable-block parser that never loses the source offsets.
 *
 * The whole point of this file: the reader sees prose and figures, but every
 * span on screen still knows the byte range in the .tex file it came from. That
 * is what lets a highlight in the browser turn into an exact edit range for the
 * AI, with no diffing or fuzzy matching.
 *
 * Two kinds of segment come out of inline parsing:
 *   - literal:  rendered text is character-identical to the source, so an
 *               offset inside the rendered text maps 1:1 onto the source.
 *   - derived:  the rendering differs from the source (\autocite{x} shows as
 *               [x]), so any selection touching it snaps to the whole segment.
 *
 * Keeping that distinction is what makes selection mapping honest rather than
 * approximate — we never claim a precise offset we cannot actually justify.
 */

export type SegmentStyle = "emph" | "bold" | "code" | "cite" | "ref" | "math" | "quote" | "todo";

export interface Segment {
  /** What the reader sees. */
  text: string;
  /** Byte offset of this segment's source in the containing file. */
  srcStart: number;
  srcEnd: number;
  /** True when `text` is character-identical to source[srcStart..srcEnd]. */
  literal: boolean;
  styles: SegmentStyle[];
  /** For cite/ref segments: the key(s) being referenced. */
  keys?: string[];
}

export type Block =
  | { kind: "heading"; id: string; srcStart: number; srcEnd: number; level: number; segments: Segment[]; label?: string }
  | { kind: "paragraph"; id: string; srcStart: number; srcEnd: number; segments: Segment[] }
  | { kind: "figure"; id: string; srcStart: number; srcEnd: number; graphics: string[]; caption: Segment[]; label?: string }
  | { kind: "list"; id: string; srcStart: number; srcEnd: number; ordered: boolean; items: Segment[][] }
  | { kind: "equation"; id: string; srcStart: number; srcEnd: number; latex: string; label?: string }
  | {
      kind: "table"; id: string; srcStart: number; srcEnd: number; raw: string;
      caption: Segment[]; label?: string;
      /** Parsed grid, or null when the body was too irregular to trust. */
      grid: TableGrid | null;
    }
  | { kind: "verbatim"; id: string; srcStart: number; srcEnd: number; raw: string; env: string }
  | { kind: "comment"; id: string; srcStart: number; srcEnd: number; text: string }
  | { kind: "preamble"; id: string; srcStart: number; srcEnd: number; raw: string }
  /** \include{chapters/3_methods} — the edge that defines document order. */
  | { kind: "include"; id: string; srcStart: number; srcEnd: number; target: string }
  /** \maketitle, \tableofcontents, \printbibliography … structural, not prose. */
  | { kind: "structure"; id: string; srcStart: number; srcEnd: number; command: string }
  | { kind: "unknown"; id: string; srcStart: number; srcEnd: number; raw: string; env?: string };

export type CellAlign = "left" | "center" | "right";

export interface TableCell {
  segments: Segment[];
  align: CellAlign;
  colSpan: number;
}

export interface TableRow {
  cells: TableCell[];
  /** A horizontal rule sits above this row. */
  ruleAbove: boolean;
  isHeader: boolean;
}

export interface TableGrid {
  rows: TableRow[];
  /** True when a rule closes the table. */
  ruleBelow: boolean;
}

export interface ParsedDocument {
  /** Path relative to the project's tex root. */
  path: string;
  blocks: Block[];
  /** Byte length of the source this was parsed from, for staleness checks. */
  sourceLength: number;
}

const HEADING_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

const VERBATIM_ENVS = new Set(["verbatim", "lstlisting", "minted", "Verbatim", "alltt"]);
const FIGURE_ENVS = new Set(["figure", "figure*", "SCfigure", "wrapfigure"]);
const TABLE_ENVS = new Set(["table", "table*", "longtable", "tabularx"]);
const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "displaymath", "multline", "multline*"]);

/** Citation-ish commands and how many leading optional args to ignore. */
const CITE_CMDS = new Set([
  "cite", "autocite", "parencite", "textcite", "citep", "citet",
  "footcite", "supercite", "citeauthor", "citeyear", "fullcite",
]);
const REF_CMDS = new Set(["ref", "autoref", "Cref", "cref", "eqref", "pageref", "nameref"]);
const STYLE_CMDS: Record<string, SegmentStyle> = {
  emph: "emph",
  textit: "emph",
  textsl: "emph",
  textbf: "bold",
  textsc: "bold",
  texttt: "code",
  textrm: "emph",
  underline: "emph",
};

/** Commands whose braced argument should be dropped entirely, not rendered. */
const DROP_WITH_ARG = new Set([
  "label", "index", "hypersetup", "vspace", "hspace", "caption*",
  "addcontentsline", "cite*", "nocite", "graphicspath",
]);

/**
 * todonotes macros that already exist in this thesis.
 *
 * These are the coloured boxes the author sees in the compiled PDF. The
 * workbench lifts them out of the prose and onto the margin rail, where they
 * can be answered — so the notes that were previously write-only become a
 * conversation. The note's text leaves the reading flow (it reappears in the
 * rail) but the macro still renders a pin glyph, which gives the rail something
 * to anchor its leader line to and shows the reader where the note lives.
 */
export const TODO_MACROS: Record<string, string> = {
  missing: "missing",
  alt: "alternative",
  thought: "question",
  attention: "claim",
  todo: "todo",
};

/** File-inclusion commands: these define the document's chapter order. */
const INCLUDE_CMDS = new Set(["include", "input", "subfile", "includeonly"]);

/**
 * Structural commands that occupy a line of their own. They carry no prose but
 * they are real source, so they get a block rather than vanishing into a gap —
 * an invisible line is a line the AI could clobber without anyone noticing.
 */
const STRUCTURE_CMDS = new Set([
  "maketitle", "tableofcontents", "listoffigures", "listoftables", "listoftodos",
  "printbibliography", "clearpage", "newpage", "appendix", "frontmatter",
  "mainmatter", "backmatter", "bibliography", "bibliographystyle",
]);

/** Single-token escapes: source is 2 chars, rendering is 1. */
const CHAR_ESCAPES: Record<string, string> = {
  "%": "%", "&": "&", "_": "_", "#": "#", "$": "$", "{": "{", "}": "}",
};

/** Zero-arg commands that render as a literal glyph or nothing. */
const SYMBOL_CMDS: Record<string, string> = {
  ldots: "…", dots: "…", textellipsis: "…",
  "\\": "\n", newline: "\n", par: "\n",
  quad: " ", qquad: "  ", ",": " ", ";": " ", ":": " ", " ": " ",
  textendash: "–", textemdash: "—",
  ae: "æ", oe: "œ", aa: "å", AA: "Å", o: "ø", O: "Ø", ss: "ß",
  LaTeX: "LaTeX", TeX: "TeX",
  bigskip: "", medskip: "", smallskip: "", noindent: "", centering: "",
  clearpage: "", newpage: "", hline: "", toprule: "", midrule: "", bottomrule: "",
};

/**
 * One character of the source, or the empty string past its end.
 *
 * Every scan in this file walks an index forward and tests the character it
 * lands on, and under `noUncheckedIndexedAccess` those reads are honestly typed
 * `string | undefined`. The temptation is to silence that with a `!`. It would
 * be wrong: `/[a-zA-Z]/.test(undefined)` is `true`, because `test` stringifies
 * its argument and "undefined" is all letters — so a file ending mid-command
 * would have the parser read a name off the end of the string rather than stop.
 * The empty string is the answer that makes every one of those tests false,
 * which is what "there is no character there" should mean.
 */
function ch(src: string, i: number): string {
  return src[i] ?? "";
}

/**
 * A macro the paper defined for itself, and why this parser expands them.
 *
 * Every paper in this roadmap opens by defining its own three words:
 *
 *     \newcommand{\gh}[1]{\texttt{gh\##1}}
 *     \newcommand{\mr}[1]{\texttt{!#1}}
 *     \newcommand{\work}[1]{\par\smallskip\noindent\emph{#1}\par\smallskip}
 *
 * Without expansion the fallback for an unknown command applies — drop the
 * wrapper, keep the argument — and `\work{\gh{111}}` renders as the bare
 * string `111`. That is not a small cosmetic loss. `gh#111` is a reference to a
 * piece of work and `111` is a number, and a reading view that turns one into
 * the other is a reading view that disagrees with the PDF about what the paper
 * says. The whole claim of this app is that you read the prose instead of the
 * markup, which is only worth anything if the prose is the same prose.
 *
 * ## What is expanded, and the much longer list of what is not
 *
 * One-argument `\newcommand` and `\renewcommand`, with a body that is
 * substituted textually for `#1` and then parsed as ordinary inline content. No
 * `\def`, no optional-argument defaults, no `\newenvironment`, no recursion
 * guard beyond a depth limit. This is not a TeX engine and must not grow into
 * one: a paper that needs more than this is a paper that should be read in the
 * PDF, and a half-built macro processor would be a program that renders MOST
 * papers correctly, which is the worst of the available outcomes.
 *
 * ## The offsets an expansion can honestly claim
 *
 * None, inside itself. The text that comes out of a macro body is not in the
 * file — `gh#` appears nowhere in `\gh{111}` — so every segment produced by an
 * expansion is marked derived and given the range of the WHOLE macro call. That
 * is the same contract the citation and cross-reference renderings already
 * keep, and it is what stops this file from ever claiming a byte range it
 * cannot justify. Styles survive the expansion (`\texttt` in the body still
 * makes the result `code`), because a style is a fact about the rendering and
 * not a claim about the source.
 */
export interface Macro {
  arity: number;
  body: string;
}

/**
 * The macros in force while the current document is being parsed.
 *
 * Module-level, alongside `idCounter`, and for the same unglamorous reason:
 * `parseInline` is called recursively from a dozen places and is exported for
 * use on a bare range, and threading a table through every one of those
 * signatures would be a large change to a file that is otherwise copied
 * verbatim from a program that worked. It is set by `parseLatex` and restored
 * afterwards, so a caller that parses one document inside another gets its own
 * table back rather than the inner document's.
 *
 * It is set explicitly and not derived per file, because a paper's macros are
 * defined in `main.tex` and USED in `chapters/*.tex`, which have no preamble at
 * all. A chapter parsed with a table rebuilt from its own text would find no
 * macros and render every reference in the paper as a naked number — which is
 * exactly the bug this exists to fix, reintroduced one file over.
 */
let activeMacros: ReadonlyMap<string, Macro> = new Map();

/** How deep one macro may expand into another before this gives up. */
const MAX_MACRO_DEPTH = 8;
let macroDepth = 0;

/**
 * Read every one-argument macro definition out of a source.
 *
 * Scans raw text rather than blocks because these live in the preamble, which
 * the parser deliberately folds into one opaque block. A definition whose body
 * cannot be brace-matched is skipped rather than guessed at: an unbalanced body
 * substituted into prose would corrupt every paragraph after it, and a missing
 * macro only costs the fallback that was there before.
 */
export function findMacros(src: string): Map<string, Macro> {
  const out = new Map<string, Macro>();
  const define = /\\(?:re)?newcommand\s*\{?\s*\\([a-zA-Z]+)\s*\}?\s*(?:\[(\d)\])?\s*\{/g;
  for (;;) {
    const m = define.exec(src);
    if (!m) break;
    const name = m[1]!;
    const arity = m[2] ? Number(m[2]) : 0;
    if (arity !== 1) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close <= open) continue;
    out.set(name, { arity, body: src.slice(open + 1, close - 1) });
  }
  return out;
}

/**
 * Substitute one argument into a macro body.
 *
 * `\#` is TeX's escaped hash and is NOT a parameter — `\gh`'s body is
 * `\texttt{gh\##1}`, so a naive replace of every `#1` would be correct here by
 * luck and wrong on `\#1`, which means a literal hash followed by a one. The
 * escape is protected first, substituted around, and restored.
 */
function expandMacro(macro: Macro, argument: string): string {
  const GUARD = "\u0000HASH\u0000";
  return macro.body.split("\\#").join(GUARD).split("#1").join(argument).split(GUARD).join("\\#");
}

/**
 * Block ids, and why the counter is reset per parse rather than per process.
 *
 * It used to run monotonically for the life of the program, which was harmless
 * where this parser came from — one document, parsed once, ids never leaving
 * the process. Here it is not. The page uses these ids as anchors for the
 * section list, and a module serves the same paper repeatedly: parsed a second
 * time with a running counter, every heading in `heading-11 … heading-30`
 * becomes `heading-41 …`, and a link a reader had in front of them scrolls
 * nowhere. So `parseLatex` resets it, and the ids for a given source are the
 * same ids every time that source is read — which is what an anchor has to
 * mean.
 *
 * The reset is per FILE, not per paper, so `readPaper` merging a main file with
 * its chapters would collide: each chapter would start again at `heading-1`.
 * That is why `PlacedBlock` carries `file` and the page keys anchors on the
 * pair, rather than on an id the parser never promised to make unique across
 * documents.
 */
let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Find the index just past the `{...}` group starting at `open`. Brace-aware. */
function matchBrace(src: string, open: number): number {
  if (src[open] !== "{") return open;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Find the index just past a `[...]` optional group, or `pos` if none. */
function matchBracket(src: string, pos: number): number {
  if (src[pos] !== "[") return pos;
  let depth = 0;
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return pos;
}

/** Read a command name starting at a backslash. Returns null if not a command. */
function readCommandName(src: string, pos: number): { name: string; end: number } | null {
  if (src[pos] !== "\\") return null;
  let i = pos + 1;
  if (i >= src.length) return null;
  // Single non-letter control symbols like \\ \, \% are one char long.
  if (!/[a-zA-Z]/.test(ch(src, i))) return { name: ch(src, i), end: i + 1 };
  while (i < src.length && /[a-zA-Z*]/.test(ch(src, i))) i++;
  return { name: src.slice(pos + 1, i), end: i };
}

/** True when the `%` at `pos` is a real comment start (not an escaped \%). */
function isCommentStart(src: string, pos: number): boolean {
  if (src[pos] !== "%") return false;
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && src[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

// ---------------------------------------------------------------------------
// Inline parsing: source range -> styled, source-mapped segments
// ---------------------------------------------------------------------------

/**
 * Parse the inline content of source[start..end) into segments.
 *
 * `inherited` styles are pushed down into nested content so that highlighting
 * inside \emph{...} still yields exact literal offsets.
 */
export function parseInline(src: string, start: number, end: number, inherited: SegmentStyle[] = []): Segment[] {
  const out: Segment[] = [];
  let literalStart = -1;
  let i = start;

  const flushLiteral = (upto: number) => {
    if (literalStart < 0) return;
    const text = src.slice(literalStart, upto);
    if (text.length > 0) {
      out.push({ text, srcStart: literalStart, srcEnd: upto, literal: true, styles: [...inherited] });
    }
    literalStart = -1;
  };

  const pushDerived = (text: string, s: number, e: number, styles: SegmentStyle[], keys?: string[]) => {
    out.push({ text, srcStart: s, srcEnd: e, literal: false, styles: [...inherited, ...styles], keys });
  };

  while (i < end) {
    const c = src[i];

    // Comments inside a paragraph: drop through end of line.
    if (isCommentStart(src, i)) {
      flushLiteral(i);
      const nl = src.indexOf("\n", i);
      i = nl === -1 || nl > end ? end : nl + 1;
      continue;
    }

    // LaTeX quotes: ``x'' -> "x". Source and render differ in length.
    if (c === "`" && src[i + 1] === "`") {
      flushLiteral(i);
      pushDerived("“", i, i + 2, []);
      i += 2;
      continue;
    }
    if (c === "'" && src[i + 1] === "'") {
      flushLiteral(i);
      pushDerived("”", i, i + 2, []);
      i += 2;
      continue;
    }

    // Non-breaking space renders as a plain space.
    if (c === "~") {
      flushLiteral(i);
      pushDerived(" ", i, i + 1, []);
      i += 1;
      continue;
    }

    // Inline math.
    if (c === "$") {
      flushLiteral(i);
      const isDouble = src[i + 1] === "$";
      const delim = isDouble ? "$$" : "$";
      let close = src.indexOf(delim, i + delim.length);
      if (close === -1 || close > end) close = end;
      // Keep the raw LaTeX; the client renders it with KaTeX. Math segments
      // are derived, so a selection touching one snaps to the whole span — the
      // rendered maths has no honest per-character source correspondence.
      const latex = src.slice(i + delim.length, close);
      pushDerived(latex, i, Math.min(close + delim.length, end), ["math"]);
      i = Math.min(close + delim.length, end);
      continue;
    }

    // Brace groups with no command in front: transparent, just recurse.
    if (c === "{") {
      flushLiteral(i);
      const close = Math.min(matchBrace(src, i), end);
      out.push(...parseInline(src, i + 1, close - 1, inherited));
      i = close;
      continue;
    }

    if (c === "\\") {
      const cmd = readCommandName(src, i);
      if (!cmd) { i++; continue; }
      flushLiteral(i);
      const { name } = cmd;
      let p = cmd.end;

      // \% \& \_ ... render as the bare character.
      if (CHAR_ESCAPES[name] !== undefined) {
        pushDerived(CHAR_ESCAPES[name], i, p, []);
        i = p;
        continue;
      }

      // Symbol commands: no arguments, fixed rendering. Swallow a following
      // brace pair used purely to terminate the name (\LaTeX{}).
      if (SYMBOL_CMDS[name] !== undefined) {
        let e = p;
        if (src[e] === "{" && src[e + 1] === "}") e += 2;
        const text = SYMBOL_CMDS[name];
        if (text) pushDerived(text, i, e, []);
        i = e;
        continue;
      }

      // Skip optional args so \autocite[see][12]{key} lands on the real arg.
      while (src[p] === "[") {
        const nb = matchBracket(src, p);
        if (nb === p) break;
        p = nb;
      }

      // Citations render as a bracketed key list.
      if (CITE_CMDS.has(name)) {
        const close = src[p] === "{" ? matchBrace(src, p) : p;
        const keys = src.slice(p + 1, Math.max(p + 1, close - 1)).split(",").map((k) => k.trim()).filter(Boolean);
        pushDerived(`[${keys.join(", ")}]`, i, close, ["cite"], keys);
        i = close;
        continue;
      }

      // Cross-references render as a marker; the target is kept for tooling.
      if (REF_CMDS.has(name)) {
        const close = src[p] === "{" ? matchBrace(src, p) : p;
        const key = src.slice(p + 1, Math.max(p + 1, close - 1)).trim();
        pushDerived(`§${key}`, i, close, ["ref"], [key]);
        i = close;
        continue;
      }

      // Styling commands: recurse so inner text keeps exact offsets.
      if (STYLE_CMDS[name]) {
        const close = src[p] === "{" ? matchBrace(src, p) : p;
        if (close > p) {
          out.push(...parseInline(src, p + 1, close - 1, [...inherited, STYLE_CMDS[name]]));
          i = close;
        } else {
          i = p;
        }
        continue;
      }

      // Author's todonotes, and the one behaviour in this parser that was
      // changed rather than copied.
      //
      // Where it came from, this collapsed to a bare pin glyph and the note's
      // text was lifted out onto a margin rail, where it could be answered.
      // There is no rail here: this app reads a paper and takes no writes. Kept
      // as it was, the text of every annotation an author wrote would vanish
      // behind a ◆ pointing at nothing — a silent loss, and the worst kind,
      // because the page would still look complete. So the pin stays (it says
      // at a glance that this is a note rather than the argument) and the text
      // follows it in the reading flow, carrying the `todo` style down into
      // whatever markup is inside it.
      if (TODO_MACROS[name] !== undefined) {
        const close = src[p] === "{" ? matchBrace(src, p) : p;
        pushDerived("◆\u00a0", i, p, ["todo"]);
        if (close > p) out.push(...parseInline(src, p + 1, close - 1, [...inherited, "todo"]));
        i = Math.max(close, p);
        continue;
      }

      // Commands whose content should vanish from the rendered view.
      if (DROP_WITH_ARG.has(name)) {
        const close = src[p] === "{" ? matchBrace(src, p) : p;
        i = Math.max(close, p);
        continue;
      }

      // A macro the paper defined for itself. See `Macro` above for why these
      // are expanded at all and for the offsets an expansion may claim.
      const macro = activeMacros.get(name);
      if (macro && src[p] === "{" && macroDepth < MAX_MACRO_DEPTH) {
        const close = matchBrace(src, p);
        const expanded = expandMacro(macro, src.slice(p + 1, close - 1));
        macroDepth += 1;
        // Parsed in its own buffer, because the expansion is not in the file:
        // the offsets the recursive call produces are offsets into a string
        // that exists for one statement, and letting a single one of them
        // escape would be this parser telling a lie of exactly the kind it was
        // written to make impossible. So every segment that comes back is
        // flattened onto the range of the macro call itself.
        const inner = parseInline(expanded, 0, expanded.length, inherited);
        macroDepth -= 1;
        for (const seg of inner) {
          out.push({ ...seg, srcStart: i, srcEnd: close, literal: false });
        }
        i = close;
        continue;
      }

      // Unknown command with an argument: drop the wrapper, keep the content.
      if (src[p] === "{") {
        const close = matchBrace(src, p);
        out.push(...parseInline(src, p + 1, close - 1, inherited));
        i = close;
        continue;
      }

      // Unknown bare command: drop it.
      i = p;
      continue;
    }

    if (literalStart < 0) literalStart = i;
    i++;
  }

  flushLiteral(end);
  return normalizeWhitespace(out);
}

/**
 * Make hard-wrapped source read as flowing prose without losing exactness.
 *
 * A .tex paragraph is wrapped at ~90 columns, so its literal text is full of
 * newlines that must render as single spaces. Rewriting the segment wholesale
 * would force it to derived, and a derived segment cannot be subdivided — which
 * would make a one-sentence annotation decorate the entire paragraph.
 *
 * So instead of collapsing in place, we *split*: each run of words stays a
 * literal segment with exact offsets, and only the whitespace between them
 * becomes a derived single space. Precision is preserved everywhere it
 * actually matters, and it is given up only on the gaps between words.
 */
function normalizeWhitespace(segments: Segment[]): Segment[] {
  const out: Segment[] = [];

  for (const seg of segments) {
    if (!seg.literal) {
      if (seg.text.length > 0) out.push(seg);
      continue;
    }

    const re = /\s+/g;
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(seg.text)) !== null) {
      // A lone space already renders correctly; leave it inside the literal run.
      if (m[0] === " ") continue;

      if (m.index > last) {
        out.push({
          ...seg,
          text: seg.text.slice(last, m.index),
          srcStart: seg.srcStart + last,
          srcEnd: seg.srcStart + m.index,
          literal: true,
        });
      }
      out.push({
        ...seg,
        text: " ",
        srcStart: seg.srcStart + m.index,
        srcEnd: seg.srcStart + m.index + m[0].length,
        literal: false,
      });
      last = m.index + m[0].length;
    }

    if (last < seg.text.length) {
      out.push({
        ...seg,
        text: seg.text.slice(last),
        srcStart: seg.srcStart + last,
        srcEnd: seg.srcEnd,
        literal: true,
      });
    }
  }

  // Drop whitespace that ended up at the very edges, so a paragraph does not
  // render with a stray leading or trailing space.
  while (out.length && !out[0]!.literal && out[0]!.text.trim() === "") out.shift();
  while (out.length && !out[out.length - 1]!.literal && out[out.length - 1]!.text.trim() === "") out.pop();

  return out.filter((s) => s.text.length > 0);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Consume a `\label{...}` immediately following `pos`, if present. */
function peekLabel(src: string, pos: number, limit: number): { label?: string; end: number } {
  let i = pos;
  while (i < limit && /\s/.test(ch(src, i))) i++;
  if (!src.startsWith("\\label", i)) return { end: pos };
  const brace = i + "\\label".length;
  if (src[brace] !== "{") return { end: pos };
  const close = matchBrace(src, brace);
  return { label: src.slice(brace + 1, close - 1).trim(), end: close };
}

/** Extract every \includegraphics target inside a source range. */
function extractGraphics(src: string, start: number, end: number): string[] {
  const out: string[] = [];
  const re = /\\includegraphics\s*(\[[^\]]*\])?\s*\{/g;
  const slice = src.slice(start, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const braceAt = start + m.index + m[0].length - 1;
    const close = matchBrace(src, braceAt);
    out.push(src.slice(braceAt + 1, close - 1).trim());
  }
  return out;
}

/** Extract the first \caption{...} inside a range as inline segments. */
function extractCaption(src: string, start: number, end: number): Segment[] {
  const idx = src.indexOf("\\caption", start);
  if (idx === -1 || idx >= end) return [];
  let p = idx + "\\caption".length;
  if (src[p] === "*") p++;
  while (src[p] === "[") {
    const nb = matchBracket(src, p);
    if (nb === p) break;
    p = nb;
  }
  if (src[p] !== "{") return [];
  const close = matchBrace(src, p);
  return parseInline(src, p + 1, close - 1);
}

const RULE_CMDS = new Set(["hline", "toprule", "midrule", "bottomrule", "cline", "cmidrule", "hdashline"]);

/** Column alignments from a tabular preamble like `lcc` or `l|p{4cm}|X`. */
function parseColSpec(spec: string): CellAlign[] {
  const out: CellAlign[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "l") out.push("left");
    else if (c === "c") out.push("center");
    else if (c === "r" || c === "R") out.push("right");
    else if (c === "p" || c === "m" || c === "b" || c === "X") {
      out.push("left");
      // Skip the width argument that follows p/m/b.
      if (spec[i + 1] === "{") i = matchBrace(spec, i + 1) - 1;
    } else if (c === "*" || c === "@" || c === "!" || c === ">" || c === "<") {
      // Repeats and inserts are not modelled; skip their braced argument.
      if (spec[i + 1] === "{") i = matchBrace(spec, i + 1) - 1;
    }
    // '|' and whitespace carry no column of their own.
  }
  return out;
}

/**
 * Find the top-level occurrences of a delimiter inside a source range,
 * ignoring anything nested in braces or escaped with a backslash.
 */
function topLevelSplits(src: string, start: number, end: number, delim: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      // `\\` is a row break and `\&` is a literal ampersand — both are two
      // characters, so stepping over the pair is what keeps them out of the way.
      if (delim === "\\\\" && src[i + 1] === "\\" && depth === 0) {
        out.push(i);
        i += 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; continue; }
    if (depth === 0 && delim === "&" && c === "&") out.push(i);
    i++;
  }
  return out;
}

/** Parse one cell, unwrapping \multicolumn if present. */
function parseCell(src: string, start: number, end: number, fallback: CellAlign): TableCell {
  let s = start;
  while (s < end && /\s/.test(ch(src, s))) s++;

  if (src.startsWith("\\multicolumn", s)) {
    let p = s + "\\multicolumn".length;
    if (src[p] === "{") {
      const nClose = matchBrace(src, p);
      const span = Number(src.slice(p + 1, nClose - 1).trim()) || 1;
      let q = nClose;
      if (src[q] === "{") {
        const aClose = matchBrace(src, q);
        const align = parseColSpec(src.slice(q + 1, aClose - 1))[0] ?? fallback;
        q = aClose;
        if (src[q] === "{") {
          const cClose = matchBrace(src, q);
          return { segments: parseInline(src, q + 1, cClose - 1), align, colSpan: span };
        }
      }
    }
  }

  return { segments: parseInline(src, start, end), align: fallback, colSpan: 1 };
}

/**
 * Parse a tabular body into a grid.
 *
 * Rendering the real table rather than dumping the source matters for more
 * than looks: every cell keeps its own source range, so a single figure in a
 * results table can be highlighted and questioned on its own.
 *
 * Returns null when the body does not look like a regular grid — better to
 * fall back to showing the source than to render a confidently wrong table.
 */
function parseTabular(src: string, start: number, end: number): TableGrid | null {
  // Locate the innermost tabular-like environment inside the float.
  const envMatch = /\\begin\{(tabular\*?|tabularx|longtable|array)\}/.exec(src.slice(start, end));
  if (!envMatch) return null;

  const envStart = start + envMatch.index;
  /* Group 1 of a regex that matched — `!` because the alternation is
     entirely inside the group, so a match without it is not reachable. */
  const env = envMatch[1]!;
  let p = envStart + envMatch[0].length;

  // tabularx/tabular* take a width argument before the column spec.
  if (env === "tabularx" || env === "tabular*") {
    while (p < end && /\s/.test(ch(src, p))) p++;
    if (src[p] === "{") p = matchBrace(src, p);
  }
  // An optional [t]/[b] positioning argument may precede the spec.
  while (p < end && /\s/.test(ch(src, p))) p++;
  if (src[p] === "[") p = matchBracket(src, p);
  while (p < end && /\s/.test(ch(src, p))) p++;
  if (src[p] !== "{") return null;

  const specClose = matchBrace(src, p);
  const aligns = parseColSpec(src.slice(p + 1, specClose - 1));
  if (aligns.length === 0) return null;

  const bodyEnd = findEnvEnd(src, specClose, env).contentEnd;
  const rowBreaks = topLevelSplits(src, specClose, bodyEnd, "\\\\");

  // Slice the body into row ranges at each `\\`.
  const ranges: { from: number; to: number }[] = [];
  let cursor = specClose;
  for (const br of rowBreaks) {
    ranges.push({ from: cursor, to: br });
    cursor = br + 2;
  }
  if (cursor < bodyEnd) ranges.push({ from: cursor, to: bodyEnd });

  const rows: TableRow[] = [];
  let pendingRule = false;
  let ruleBelow = false;
  let ruleCount = 0;
  let headerBoundary = -1;

  for (const r of ranges) {
    // Strip leading rule commands; they belong to the row that follows.
    let from = r.from;
    for (;;) {
      while (from < r.to && /\s/.test(ch(src, from))) from++;
      if (src[from] !== "\\") break;
      const cmd = readCommandName(src, from);
      if (!cmd || !RULE_CMDS.has(cmd.name)) break;
      let after = cmd.end;
      if (src[after] === "(") { const c = src.indexOf(")", after); after = c === -1 ? after : c + 1; }
      if (src[after] === "{") after = matchBrace(src, after);
      from = after;
      pendingRule = true;
      ruleCount++;
      // The second rule conventionally closes the header block.
      if (ruleCount === 2 && headerBoundary === -1) headerBoundary = rows.length;
    }

    const text = src.slice(from, r.to);
    if (!text.trim()) {
      if (pendingRule) ruleBelow = true;
      continue;
    }

    const seps = topLevelSplits(src, from, r.to, "&");
    const cells: TableCell[] = [];
    let cellStart = from;
    let col = 0;
    for (const sep of [...seps, r.to]) {
      cells.push(parseCell(src, cellStart, sep, aligns[col] ?? "left"));
      col += cells[cells.length - 1]!.colSpan;
      cellStart = sep + 1;
    }

    if (cells.every((c) => c.segments.length === 0)) {
      if (pendingRule) ruleBelow = true;
      continue;
    }

    rows.push({ cells, ruleAbove: pendingRule, isHeader: false });
    pendingRule = false;
    ruleBelow = false;
  }

  if (rows.length === 0) return null;

  // Mark header rows. With a leading rule the boundary is the second rule;
  // otherwise assume a single header row when there is more than one row.
  const boundary = headerBoundary > 0 ? headerBoundary : rows.length > 1 && rows[0]!.ruleAbove ? 1 : 0;
  for (let i = 0; i < boundary; i++) rows[i]!.isHeader = true;

  // A grid whose rows disagree wildly about width is probably mis-parsed.
  const widths = rows.map((r) => r.cells.reduce((n, c) => n + c.colSpan, 0));
  if (Math.max(...widths) - Math.min(...widths) > Math.max(2, aligns.length - 1)) return null;

  return { rows, ruleBelow };
}

/** Split an itemize/enumerate body into per-\item segment lists. */
function parseItems(src: string, start: number, end: number): Segment[][] {
  const items: Segment[][] = [];
  const positions: number[] = [];
  let i = start;
  while (i < end) {
    if (src[i] === "\\" && src.startsWith("\\item", i)) {
      positions.push(i);
      i += 5;
      continue;
    }
    if (src[i] === "\\") { i += 2; continue; }
    i++;
  }
  for (let k = 0; k < positions.length; k++) {
    let s = positions[k]! + "\\item".length;
    while (src[s] === "[") {
      const nb = matchBracket(src, s);
      if (nb === s) break;
      s = nb;
    }
    const e = k + 1 < positions.length ? positions[k + 1]! : end;
    const segs = parseInline(src, s, e);
    if (segs.length) items.push(segs);
  }
  return items;
}

/**
 * Parse a full .tex source into blocks.
 *
 * `path` is carried through so blocks can be addressed as (path, srcStart).
 */
export function parseLatex(
  src: string,
  path: string,
  macros: ReadonlyMap<string, Macro> = findMacros(src),
): ParsedDocument {
  idCounter = 0;
  /* Saved and restored rather than simply assigned, so that a caller which is
     itself mid-parse — `summarizeRange` on a range of another document, say —
     is not left with this document's macros in force. */
  const outerMacros = activeMacros;
  activeMacros = macros;
  try {
    return parseBlocks(src, path);
  } finally {
    activeMacros = outerMacros;
  }
}

function parseBlocks(src: string, path: string): ParsedDocument {
  const blocks: Block[] = [];
  let i = 0;

  // Fold the preamble into one collapsed block — it is real source the AI may
  // need to edit, but nobody wants to scroll through fontspec setup.
  const docBegin = src.indexOf("\\begin{document}");
  if (docBegin > 0) {
    blocks.push({
      kind: "preamble",
      id: nextId("preamble"),
      srcStart: 0,
      srcEnd: docBegin + "\\begin{document}".length,
      raw: src.slice(0, docBegin),
    });
    i = docBegin + "\\begin{document}".length;
  }

  while (i < src.length) {
    // Skip blank space between blocks.
    if (/\s/.test(ch(src, i))) { i++; continue; }

    // Comment runs collapse into a single block so provenance notes stay visible.
    if (isCommentStart(src, i)) {
      const startAt = i;
      while (i < src.length) {
        if (!isCommentStart(src, i)) break;
        const nl = src.indexOf("\n", i);
        i = nl === -1 ? src.length : nl + 1;
        // Keep consuming only if the next line is also a comment.
        let j = i;
        while (j < src.length && /[ \t]/.test(ch(src, j))) j++;
        if (!isCommentStart(src, j)) break;
        i = j;
      }
      const text = src
        .slice(startAt, i)
        .split("\n")
        .map((l) => l.replace(/^\s*%+\s?/, ""))
        .join("\n")
        .trim();
      if (text) {
        blocks.push({ kind: "comment", id: nextId("comment"), srcStart: startAt, srcEnd: i, text });
      }
      continue;
    }

    if (src[i] === "\\") {
      const cmd = readCommandName(src, i);

      if (cmd && HEADING_LEVELS[cmd.name.replace(/\*$/, "")] !== undefined && src[cmd.end] === "{") {
        const bare = cmd.name.replace(/\*$/, "");
        const close = matchBrace(src, cmd.end);
        const { label, end: afterLabel } = peekLabel(src, close, src.length);
        blocks.push({
          kind: "heading",
          id: nextId("heading"),
          srcStart: i,
          srcEnd: afterLabel,
          level: HEADING_LEVELS[bare]!,
          segments: parseInline(src, cmd.end + 1, close - 1),
          label,
        });
        i = afterLabel;
        continue;
      }

      if (cmd && INCLUDE_CMDS.has(cmd.name) && src[cmd.end] === "{") {
        const close = matchBrace(src, cmd.end);
        blocks.push({
          kind: "include",
          id: nextId("include"),
          srcStart: i,
          srcEnd: close,
          target: src.slice(cmd.end + 1, close - 1).trim(),
        });
        i = close;
        continue;
      }

      if (cmd && STRUCTURE_CMDS.has(cmd.name.replace(/\*$/, ""))) {
        let e = cmd.end;
        // Swallow an optional [..] title and an empty {} terminator.
        e = matchBracket(src, e);
        if (src[e] === "{") e = matchBrace(src, e);
        blocks.push({
          kind: "structure",
          id: nextId("structure"),
          srcStart: i,
          srcEnd: e,
          command: src.slice(i, e).trim(),
        });
        i = e;
        continue;
      }

      if (cmd && cmd.name === "end") {
        // A stray \end{document} or similar: consume and move on.
        const close = src[cmd.end] === "{" ? matchBrace(src, cmd.end) : cmd.end;
        i = close;
        continue;
      }

      if (cmd && cmd.name === "begin" && src[cmd.end] === "{") {
        const nameClose = matchBrace(src, cmd.end);
        const env = src.slice(cmd.end + 1, nameClose - 1).trim();
        const bodyEnd = findEnvEnd(src, nameClose, env);
        const contentEnd = bodyEnd.contentEnd;
        const blockEnd = bodyEnd.blockEnd;
        const { label, end: afterLabel } = peekLabel(src, blockEnd, src.length);

        if (FIGURE_ENVS.has(env)) {
          const inner = findLabelIn(src, nameClose, contentEnd);
          blocks.push({
            kind: "figure",
            id: nextId("figure"),
            srcStart: i,
            srcEnd: afterLabel,
            graphics: extractGraphics(src, nameClose, contentEnd),
            caption: extractCaption(src, nameClose, contentEnd),
            label: inner ?? label,
          });
        } else if (TABLE_ENVS.has(env)) {
          const inner = findLabelIn(src, nameClose, contentEnd);
          blocks.push({
            kind: "table",
            id: nextId("table"),
            srcStart: i,
            srcEnd: afterLabel,
            raw: src.slice(i, blockEnd),
            caption: extractCaption(src, nameClose, contentEnd),
            label: inner ?? label,
            grid: parseTabular(src, nameClose, contentEnd),
          });
        } else if (LIST_ENVS.has(env)) {
          blocks.push({
            kind: "list",
            id: nextId("list"),
            srcStart: i,
            srcEnd: afterLabel,
            ordered: env === "enumerate",
            items: parseItems(src, nameClose, contentEnd),
          });
        } else if (MATH_ENVS.has(env)) {
          const inner = findLabelIn(src, nameClose, contentEnd);
          blocks.push({
            kind: "equation",
            id: nextId("equation"),
            srcStart: i,
            srcEnd: afterLabel,
            latex: src.slice(nameClose, contentEnd).trim(),
            label: inner ?? label,
          });
        } else if (VERBATIM_ENVS.has(env)) {
          blocks.push({
            kind: "verbatim",
            id: nextId("verbatim"),
            srcStart: i,
            srcEnd: afterLabel,
            raw: src.slice(nameClose, contentEnd),
            env,
          });
        } else if (env === "document" || env === "abstract" || env === "center") {
          // Transparent wrappers: step inside and keep parsing normally.
          i = nameClose;
          continue;
        } else {
          blocks.push({
            kind: "unknown",
            id: nextId("env"),
            srcStart: i,
            srcEnd: afterLabel,
            raw: src.slice(i, blockEnd),
            env,
          });
        }
        i = afterLabel;
        continue;
      }
    }

    // Anything else is running prose: consume to the next blank line or to the
    // next construct that starts its own block.
    const paraStart = i;
    let j = i;
    while (j < src.length) {
      if (src[j] === "\n") {
        // A blank line ends the paragraph.
        let k = j + 1;
        while (k < src.length && /[ \t\r]/.test(ch(src, k))) k++;
        if (k >= src.length || src[k] === "\n") { j = k; break; }
        // A line starting a new construct also ends it.
        if (src[k] === "\\") {
          const c2 = readCommandName(src, k);
          const bare = c2?.name.replace(/\*$/, "");
          if (c2 && (bare === "begin" || bare === "end" || (bare && HEADING_LEVELS[bare] !== undefined))) {
            j = j + 1;
            break;
          }
        }
        if (isCommentStart(src, k)) { j = j + 1; break; }
        j = k;
        continue;
      }
      if (src[j] === "\\") {
        const c2 = readCommandName(src, j);
        if (c2 && (c2.name === "begin" || c2.name === "end")) break;
        if (c2) { j = c2.end; continue; }
      }
      j++;
    }
    if (j <= paraStart) j = paraStart + 1;
    const segments = parseInline(src, paraStart, j);
    if (segments.some((s) => s.text.trim().length > 0)) {
      blocks.push({ kind: "paragraph", id: nextId("para"), srcStart: paraStart, srcEnd: j, segments });
    }
    i = j;
  }

  return { path, blocks, sourceLength: src.length };
}

/** Locate the matching \end{env}, honouring nesting of the same environment. */
function findEnvEnd(src: string, from: number, env: string): { contentEnd: number; blockEnd: number } {
  const openTag = `\\begin{${env}}`;
  const closeTag = `\\end{${env}}`;
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const nextOpen = src.indexOf(openTag, i);
    const nextClose = src.indexOf(closeTag, i);
    if (nextClose === -1) return { contentEnd: src.length, blockEnd: src.length };
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + openTag.length;
      continue;
    }
    depth--;
    if (depth === 0) return { contentEnd: nextClose, blockEnd: nextClose + closeTag.length };
    i = nextClose + closeTag.length;
  }
  return { contentEnd: src.length, blockEnd: src.length };
}

/** Find a \label{...} anywhere inside a range (figures put it after \caption). */
function findLabelIn(src: string, start: number, end: number): string | undefined {
  const idx = src.indexOf("\\label", start);
  if (idx === -1 || idx >= end) return undefined;
  const brace = idx + "\\label".length;
  if (src[brace] !== "{") return undefined;
  const close = matchBrace(src, brace);
  return src.slice(brace + 1, close - 1).trim();
}
