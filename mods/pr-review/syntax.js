// Syntax highlighting for diff lines, no dependencies. tokenize(line, lang, state) -> {spans, state}:
// spans are [{start, end, kind, ref?, href?}] in UTF-16 offsets; kind is one of the Editor's semantic names
// (keyword string comment function type number constant variable operator punctuation boolean). `ref: true` marks
// names worth a go-to-definition (types, called functions, members, Markdown links). `state` carries block comments,
// multi-line strings, heredocs and Markdown fences from one line to the next of the same file side.
// langOf(path, first) names the language: by the path, else by the file's first line (a "#!" line).
// Pure module: no gpui import, so `node test_syntax.mjs` can load it.

const words = (s) => new Set(s.split(" ").filter(Boolean));
const C_OPS = { line: ["//"], block: ["/*", "*/"] };
const SPECS = {
  js: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "class interface type enum namespace", defFn: "function",
    kw: "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return super switch this throw try typeof var void while with yield async await as of static get set type interface enum implements private protected public readonly declare namespace abstract keyof infer is satisfies module",
    consts: "null undefined NaN Infinity", types: "string number boolean any unknown never void object symbol bigint" },
  python: { line: ["#"], quotes: "'\"", multi: ['"""', "'''"], prefixes: true, decorators: "function", defType: "class", defFn: "def",
    kw: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    consts: "None self cls", bools: "True False", types: "int str float bool list dict set tuple bytes object type" },
  java: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface enum record", defFn: "",
    kw: "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield",
    consts: "null", types: "int long short byte char float double boolean void" },
  kotlin: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface object typealias", defFn: "fun",
    kw: "as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor data enum finally get import init internal lateinit open override private protected public sealed set suspend companion inline reified",
    consts: "null", types: "Int Long Short Byte Char Float Double Boolean Unit String Any Nothing" },
  cpp: { ...C_OPS, quotes: "'\"", preproc: true, rawStrings: true, defType: "class struct enum union namespace concept", defFn: "",
    kw: "alignas alignof asm auto break case catch class const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if import inline module mutable namespace new noexcept operator override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while concept",
    consts: "nullptr NULL", types: "void bool char char8_t char16_t char32_t wchar_t short int long float double signed unsigned size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t byte boolean word" },
  go: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "type", defFn: "func",
    kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    consts: "nil iota", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any" },
  rust: { ...C_OPS, quotes: "\"", lifetimes: true, macros: true, defType: "struct enum trait type union mod", defFn: "fn",
    kw: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    consts: "None", types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str" },
  hcl: { line: ["#", "//"], block: ["/*", "*/"], quotes: "\"", heredoc: true, keys: "variable", defType: "", defFn: "",
    kw: "resource data module variable output locals provider terraform for in if for_each count depends_on lifecycle dynamic content backend required_providers moved import check",
    consts: "null" },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'", nocase: true, defType: "table view", defFn: "function",
    kw: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer full cross on group by order having limit offset as distinct union all is in exists between like ilike case when then else end primary key foreign references default with returning begin commit rollback view if replace function returns language asc desc unique constraint add column cascade grant revoke",
    consts: "null", types: "int integer smallint bigint serial bigserial varchar char text boolean bool timestamp timestamptz date time interval uuid json jsonb numeric decimal real float double" },
  json: { quotes: "\"", keys: "function", consts: "null", kw: "" },
};
for (const s of Object.values(SPECS)) {
  for (const k of ["kw", "consts", "types"]) s[k] = words(s[k] ?? "");
  s.bools = words(s.bools ?? "true false");
  s.defType = words(s.defType ?? "");
  s.defFn = words(s.defFn ?? "");
}

const EXT = { ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "python", pyi: "python",
  java: "java", c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", tf: "hcl", tfvars: "hcl", hcl: "hcl", yml: "yaml", yaml: "yaml",
  toml: "toml", json: "json", jsonc: "json", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", markdown: "markdown",
  sql: "sql", dockerfile: "dockerfile",
  mk: "make", make: "make", properties: "properties", ini: "properties", cfg: "properties", conf: "properties", editorconfig: "properties", npmrc: "properties", gitconfig: "properties",
  // Shell by another name; fish and just are close enough for comments, strings, variables and commands.
  ksh: "shell", fish: "shell", bats: "shell", command: "shell", just: "shell", envrc: "shell", profile: "shell",
  bashrc: "shell", zshrc: "shell", zshenv: "shell", zprofile: "shell", bash_profile: "shell", bash_aliases: "shell", bash_logout: "shell" };
const TEMPLATE = /\.(?:tpl|tftpl|tmpl|j2|erb|in|example|sample|dist)$/; // deploy.sh.tpl is a shell script with holes
const INTERPRETER = { sh: "shell", bash: "shell", zsh: "shell", dash: "shell", ksh: "shell", ash: "shell", fish: "shell", bats: "shell",
  python: "python", pypy: "python", uv: "python", node: "js", nodejs: "js", deno: "js", bun: "js", tsx: "js", "ts-node": "js" };
const HOOK_DIR = /(?:^|\/)(?:hooks|\.husky|\.githooks)\/[a-z-]+$/; // Git hooks carry no ending
const WORKFLOW = /(?:^|\/)\.github\/workflows\/[^/]+$|(?:^|\/)action\.ya?ml$/, SPRING = /^(?:application|bootstrap)[\w.-]*\.ya?ml$/, TOML_NAME = /^(?:(?:cargo|poetry|uv|pdm)\.lock|pipfile)$/;

/** Highlighter language for a path (null: plain text). `first` is the file's first line where the caller has it: a
 *  script without an ending is known by its "#!" line (firstLineOf reads it from a diff). */
export function langOf(path, first = "") {
  const name = path.split("/").pop().toLowerCase().replace(TEMPLATE, "");
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile" || name.startsWith("makefile.")) return "make";
  if (name === "justfile" || name.endsWith(".env") || name.startsWith(".env.")) return "shell";
  if (TOML_NAME.test(name)) return "toml";
  const known = EXT[name.includes(".") ? name.split(".").pop() : ""];
  // YAML with more to say: a GitHub Actions workflow or action, a Spring configuration.
  if (known === "yaml") return WORKFLOW.test(path.toLowerCase().replace(TEMPLATE, "")) ? "workflow" : SPRING.test(name) ? "spring" : "yaml";
  if (known) return known;
  if (first.charCodeAt(0) === 35 && first.charCodeAt(1) === 33) { // "#!/usr/bin/env -S python3 -u", "#!/bin/sh -e"
    const [prog, ...args] = first.slice(2).trim().split(/\s+/), base = prog.split("/").pop();
    const run = base === "env" ? args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "" : base;
    return INTERPRETER[run.split("/").pop().replace(/[\d.]+$/, "")] ?? null;
  }
  return HOOK_DIR.test(path.toLowerCase()) ? "shell" : null;
}

/** What a file's diff says beyond its path, for langOf. `lines`: the file's part of a patch (its header lines and
 *  hunks; splitPatch's `lines`). Line 1 where the first hunk shows it; "#!sh" for an executable file (git mode 100755)
 *  whose line 1 the diff does not show.
 *  ponytail: most executable files without an ending are shell scripts; reading line 1 from the checkout would say
 *  for sure, if a Python or Ruby script coloured as shell ever matters. */
export function firstLineOf(lines) {
  let exec = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.charCodeAt(0) === 64) { // "@@ -1,4 +1,6 @@": the hunks come in order, so the first one decides
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
      if (m && (m[1] === "1" || m[2] === "1") && lines[i + 1] !== undefined) return lines[i + 1].slice(1);
      break;
    }
    if (/^(?:new file mode|deleted file mode|new mode|index \S+) 100755$/.test(l)) exec = true;
  }
  return exec ? "#!sh" : "";
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUM = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[a-zA-Z]*/y;
const PUNCT = "{}[]();,.";
const PYPREFIX = /[rRbBfFuU]{1,2}(?=['"])/y, RUST_CHAR = /'(?:\\.|[^'\\])'/y, RUST_LT = /'[A-Za-z_]\w*/y;
const PREPROC = /\s*#\s*[a-z]+/y, INCLUDE = /\s*<[^>]*>/y, RAW = /R"([^(\s"\\]{0,16})\(/y;
const HEREDOC = /<<-?(\w+)\s*$/y, SHVAR = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y;
const OPS = "+-*/%=<>!&|^~?:";
const isSpace = (c) => c === 32 || c === 9;
const isDigit = (c) => c >= 48 && c <= 57;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const pascal = (w) => /^[A-Z][A-Z0-9]*[a-z]/.test(w);
const allCaps = (w) => w.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(w);

// Every scanner's loop starts a pass with `i = forward(i, at); at = i;`: a pass that did not move on (a pattern that
// matched nothing and left the position where it was, or put it back to the start of the line) takes one character as
// plain text and goes on. So a line of n characters takes at most n passes, whatever a branch does wrong, and no line
// can keep its slice for ever (Herdr stops such a slice, and the file's colors with it).
export const forward = (i, at) => (i > at ? i : at + 1);

/** One line -> {spans, state}. `state` is null at the start of a file (or after a gap). A scanner that throws leaves
 *  its line plain and starts the next one afresh, instead of taking the file's colors with it. */
export function tokenize(line, lang, state = null) {
  try { return tokenizeStrict(line, lang, state); } catch { return { spans: [], state: null }; }
}
/** As tokenize, but a scanner's exception comes through: how the tests get to see one. */
export function tokenizeStrict(line, lang, state = null) {
  if (lang === "markdown") return markdown(line, state);
  if (lang === "dockerfile") return dockerfile(line, state);
  if (lang === "shell") return shell(line, state, 0, []);
  if (lang === "make") return make(line, state);
  if (lang === "yaml" || lang === "workflow" || lang === "spring") return yaml(line, state, lang);
  if (lang === "properties") return properties(line, state);
  if (lang === "toml") return toml(line, state);
  const spec = SPECS[lang];
  if (!spec) return { spans: [], state: null };
  // A script's "#!/usr/bin/env node" line is no code of its language (Rust's "#![attr]" is).
  if (line.charCodeAt(0) === 35 && line.charCodeAt(1) === 33 && line.charCodeAt(2) !== 91) return { spans: [{ start: 0, end: line.length, kind: "comment" }], state };
  return scan(line, spec, state, 0, []);
}

// Scans line[from..] with spec, appending to spans.
function scan(line, spec, state, from, spans) {
  const n = line.length, push = (start, end, kind, extra) => { if (end > start) spans.push(extra ? { start, end, kind, ...extra } : { start, end, kind }); };
  let i = from;
  // Continue a construct left open on the previous line.
  if (state) {
    if (state.h) { // heredoc: ends on a line that is just the marker
      if (line.trim() === state.h) { push(0, n, "keyword"); return { spans, state: null }; }
      push(0, n, "string"); return { spans, state };
    }
    const end = line.indexOf(state.end, i);
    const kind = state.c ? "comment" : "string";
    if (end < 0) { push(i, n, kind); return { spans, state }; }
    push(i, end + state.end.length, kind);
    i = end + state.end.length;
    state = null;
  }
  if (spec.preproc) {
    PREPROC.lastIndex = i;
    if (PREPROC.test(line)) {
      push(line.indexOf("#", i), PREPROC.lastIndex, "keyword"); i = PREPROC.lastIndex;
      INCLUDE.lastIndex = i;
      if (INCLUDE.test(line)) { push(line.indexOf("<", i), INCLUDE.lastIndex, "string"); i = INCLUDE.lastIndex; }
    }
  }
  let prevWord = "", prevChar = 0;
  for (let at = i - 1; i < n;) {
    i = forward(i, at); at = i;
    if (i >= n) break;
    const c = line.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    const ch = line[i];
    // Comments.
    if (spec.line && spec.line.some((p) => line.startsWith(p, i))) { push(i, n, "comment"); break; }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      const end = line.indexOf(spec.block[1], i + 2);
      if (end < 0) { push(i, n, "comment"); return { spans, state: { c: 1, end: spec.block[1] } }; }
      push(i, end + 2, "comment"); i = end + 2; prevChar = 0; continue;
    }
    // Strings (with Python prefixes like f"", rb'').
    let q = -1;
    if (spec.quotes.includes(ch)) q = i;
    else if (spec.prefixes && "rRbBfFuU".includes(ch)) { PYPREFIX.lastIndex = i; if (PYPREFIX.test(line)) q = PYPREFIX.lastIndex; }
    if (q >= 0) {
      const multi = spec.multi?.find((m) => line.startsWith(m, q));
      if (multi) {
        const end = line.indexOf(multi, q + multi.length);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: multi } }; }
        push(i, end + multi.length, "string"); i = end + multi.length; prevChar = 0; continue;
      }
      {
        const quote = line[q]; let j = q + 1;
        while (j < n && line[j] !== quote) j += line[j] === "\\" && quote !== "`" ? 2 : 1;
        const end = Math.min(j + 1, n);
        // JSON/YAML keys: a string followed by ":".
        const key = spec.keys && /^\s*:/.test(line.slice(end, end + 8));
        push(i, end, key ? spec.keys : "string"); i = end; prevChar = 0; continue;
      }
    }
    if (spec.rawStrings && ch === "R" && line[i + 1] === '"') { // C++ R"delim( ... )delim"
      RAW.lastIndex = i;
      if (RAW.test(line)) {
        const close = `)${/R"([^(]*)\(/.exec(line.slice(i))[1]}"`, end = line.indexOf(close, RAW.lastIndex);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: close } }; }
        push(i, end + close.length, "string"); i = end + close.length; continue;
      }
    }
    if (spec.lifetimes && ch === "'") { // Rust: 'x' char literal or 'a lifetime
      RUST_CHAR.lastIndex = i;
      if (RUST_CHAR.test(line)) { push(i, RUST_CHAR.lastIndex, "string"); i = RUST_CHAR.lastIndex; continue; }
      RUST_LT.lastIndex = i;
      if (RUST_LT.test(line)) { push(i, RUST_LT.lastIndex, "type"); i = RUST_LT.lastIndex; continue; }
    }
    if (spec.heredoc && line.startsWith("<<", i)) {
      HEREDOC.lastIndex = i;
      if (HEREDOC.test(line)) { push(i, n, "keyword"); return { spans, state: { h: /<<-?(\w+)/.exec(line.slice(i))[1] } }; }
    }
    if (spec.decorators && ch === "@") {
      IDENT.lastIndex = i + 1;
      if (IDENT.test(line)) { push(i, IDENT.lastIndex, spec.decorators, { ref: true }); i = IDENT.lastIndex; continue; }
    }
    if (isDigit(c) || (ch === "." && isDigit(line.charCodeAt(i + 1)))) {
      NUM.lastIndex = i;
      if (NUM.test(line)) { push(i, NUM.lastIndex, "number"); i = NUM.lastIndex; prevChar = 0; continue; }
    }
    if (isIdStart(c)) {
      IDENT.lastIndex = i;
      IDENT.test(line);
      const end = IDENT.lastIndex, w = line.slice(i, end), lw = spec.nocase ? w.toLowerCase() : w;
      let j = end; while (j < n && isSpace(line.charCodeAt(j))) j++;
      const next = line[j], member = prevChar === 46 || (prevChar === 58 && line[i - 2] === ":"); // "." or "::"
      let kind = null, ref = false;
      if (spec.keys && ((next === "=" && line[j + 1] !== "=") || (spec.keys !== "variable" && next === ":"))) kind = spec.keys;
      else if (!member && spec.kw.has(lw)) kind = "keyword";
      else if (spec.bools.has(lw)) kind = "boolean";
      else if (!member && spec.consts.has(lw)) kind = "constant";
      else if (spec.types.has(lw)) kind = "type";
      else if (spec.defType.has(prevWord)) { kind = "type"; ref = true; }
      else if (spec.defFn.has(prevWord)) { kind = "function"; ref = true; }
      else if (spec.macros && next === "!" && line[j + 1] !== "=") { kind = "function"; ref = true; }
      else if (next === "(") { kind = prevWord === "new" && pascal(w) ? "type" : "function"; ref = true; }
      else if (pascal(w)) { kind = "type"; ref = true; }
      else if (allCaps(w)) { kind = "constant"; ref = true; }
      else if (member) { kind = "variable"; ref = true; }
      if (kind) push(i, end, kind, ref ? { ref: true } : null);
      prevWord = lw; prevChar = line.charCodeAt(end - 1); i = end; continue;
    }
    push(i, i + 1, PUNCT.includes(ch) ? "punctuation" : OPS.includes(ch) ? "operator" : "punctuation");
    prevChar = c; if (ch !== "." && ch !== ":") prevWord = "";
    i++;
  }
  return { spans, state: null };
}

// Shell has its own scanner: a word is a command or an argument by its place, "#" opens a comment only at the start
// of a word, quotes hold "$var" and "$(…)", and a heredoc starts on the line after its "<<EOF".
// state (null: nothing open): {s, h, raw, tabs, k}. s: what is still open, innermost last, one character each:
// "'" '"' "$" ($'…') strings, "(" "`" command lists, "a" an array's words, "m" "p" arithmetic and a bracket in it.
// h: the marker of a heredoc whose body follows (raw: quoted marker, "$" stays text; tabs: "<<-", the marker may be
// indented). k: the line ended in "\", so the next one goes on with arguments.
const SH_KW = words("if then else elif fi for while until do done case esac in function select time return local export readonly declare typeset set unset shift exit source alias break continue trap eval exec end begin switch");
const SH_GOES_ON = words("if then else elif do while until time exec eval"), SH_DECL = words("local export readonly declare typeset alias");
const SH_WORD = /(?:[^\s;|&()<>'"`$\\]|\\.)+/y, SH_ASSIGN = /[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/y, SH_FN = /[ \t]*\([ \t]*\)/y;
const SH_REDIR = /(?:&>>?|\d*(?:>>|<<<|[<>]&|<>|>\||[<>]))[\d-]?/y, SH_HERE = /<<(-?)[ \t]*(?:(['"])([^'"]+)\2|(\\?)([\w.-]+))/y;
const SH_PATTERN = /[ \t]*[^\s()|;&<>]+(?:[ \t]*\|[ \t]*[^\s()|;&<>]+)*\)/y; // "-h | --help)" of a case
const SH_OPTION = /^-{1,2}[A-Za-z0-9?][\w-]*|^--$|^\+[a-z]$/, SH_NAME = /^[A-Za-z_]\w*$/, SH_NUMBER = /^(?:0x[\da-f]+|\d+(?:\.\d+)?)$/i, SH_TEST = /^[!=~+*\/%:<>-]+$/;
function shell(line, state, from, spans) {
  const n = line.length, push = (start, end, kind, ref) => { if (end > start) spans.push(ref ? { start, end, kind, ref: true } : { start, end, kind }); };
  // Text of a string where "$name" and "${…}" stand out.
  const text = (a, b) => {
    let at = a;
    for (let j = line.indexOf("$", a); j >= 0 && j < b; j = line.indexOf("$", j + 1)) {
      SHVAR.lastIndex = j;
      if (line.charCodeAt(j - 1) === 92 || !SHVAR.test(line)) continue;
      const end = Math.min(SHVAR.lastIndex, b);
      push(at, j, "string"); push(j, end, "constant"); at = end; j = end - 1;
    }
    push(at, b, "string");
  };
  if (state?.h) { // a heredoc's body, up to the line that is just its marker
    // from: where the shell's line starts inside its host (a recipe's or a block scalar's indentation)
    if ((state.tabs ? line.trim() : line.slice(from).trimEnd()) === state.h) { push(from, n, "keyword"); return { spans, state: state.s ? { s: state.s } : null }; }
    if (state.raw) push(from, n, "string"); else text(from, n);
    return { spans, state };
  }
  const open = state?.s ? state.s.split("") : [];
  let i = from, here = null, goesOn = false;
  // first: the next word is a command (again: it is one again after the value of NAME="…" at this depth). decl: after "local"/"export", where name=value pairs follow. name: the next word
  // names a function ("f") or a loop variable ("v"). wantIn: a "for" or "case" waits for its "in". pattern: a case
  // pattern may start here.
  let first = !state?.k, again = -1, decl = false, name = "", wantIn = "", pattern = open.length === 0 && first;
  for (let at = i - 1; i < n;) {
    i = forward(i, at); at = i;
    if (i >= n) break;
    const top = open.length ? open[open.length - 1] : "", c = line.charCodeAt(i);
    if (top === "'" || top === "$") { // a quote from an earlier line
      let j = i;
      while (j < n && line.charCodeAt(j) !== 39) j += top === "$" && line.charCodeAt(j) === 92 ? 2 : 1;
      if (j >= n) { push(i, n, "string"); i = n; break; }
      push(i, j + 1, "string"); i = j + 1; open.pop(); first = false; continue;
    }
    if (top === '"') { // up to the closing quote, or to a "$(" or "`" whose inside is code again
      let j = i;
      for (;;) {
        if (j >= n) { text(i, n); i = n; break; }
        const d = line.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 34) { text(i, j + 1); i = j + 1; open.pop(); first = false; break; }
        if (d === 36 && line.charCodeAt(j + 1) === 40) {
          text(i, j);
          if (line.charCodeAt(j + 2) === 40) { push(j, j + 1, "operator"); push(j + 1, j + 3, "keyword"); open.push("m"); i = j + 3; first = false; }
          else { push(j, j + 2, "operator"); open.push("("); i = j + 2; first = true; }
          break;
        }
        if (d === 96) { text(i, j); push(j, j + 1, "operator"); open.push("`"); i = j + 1; first = true; break; }
        if (d === 36) { SHVAR.lastIndex = j; if (SHVAR.test(line)) { j = SHVAR.lastIndex; continue; } } // a quote inside "${x:-"y"}" closes nothing
        j++;
      }
      continue;
    }
    if (isSpace(c)) { if (again === open.length) { first = true; again = -1; } i++; continue; }
    const math = top === "m" || top === "p";
    if (pattern) { // "status | list)" opens a case branch: its words are no command
      pattern = false; SH_PATTERN.lastIndex = i;
      if (!math && c !== 35 && SH_PATTERN.test(line)) { const end = SH_PATTERN.lastIndex; push(i, end - 1, "string"); push(end - 1, end, "punctuation"); i = end; first = true; continue; }
    }
    if (c === 35 && !math) { push(i, n, "comment"); i = n; break; } // "#": a word never starts here with one, so it is a comment
    if (c === 39) {
      const end = line.indexOf("'", i + 1);
      if (end < 0) { push(i, n, "string"); open.push("'"); i = n; break; }
      push(i, end + 1, "string"); i = end + 1; first = false; continue;
    }
    if (c === 34) { push(i, i + 1, "string"); open.push('"'); i++; first = false; continue; }
    if (c === 36) {
      const d = line.charCodeAt(i + 1);
      if (d === 40 && line.charCodeAt(i + 2) === 40) { push(i, i + 1, "operator"); push(i + 1, i + 3, "keyword"); open.push("m"); i += 3; first = false; continue; }
      if (d === 40) { push(i, i + 2, "operator"); open.push("("); i += 2; first = true; continue; }
      if (d === 39) { // $'…' with backslash escapes
        let j = i + 2;
        while (j < n && line.charCodeAt(j) !== 39) j += line.charCodeAt(j) === 92 ? 2 : 1;
        if (j >= n) { push(i, n, "string"); open.push("$"); i = n; break; }
        push(i, j + 1, "string"); i = j + 1; first = false; continue;
      }
      SHVAR.lastIndex = i;
      if (SHVAR.test(line)) { push(i, SHVAR.lastIndex, "constant"); i = SHVAR.lastIndex; first = false; continue; }
      i++; continue;
    }
    if (c === 96) { push(i, i + 1, "operator"); if (top === "`") { open.pop(); first = false; } else { open.push("`"); first = true; } i++; continue; }
    if (c === 40) {
      if (math) { open.push("p"); push(i, i + 1, "punctuation"); i++; continue; }
      if ((first || name === "v") && line.charCodeAt(i + 1) === 40) { push(i, i + 2, "keyword"); open.push("m"); i += 2; first = false; name = ""; continue; } // (( n > 1 )), for ((…))
      const array = line.charCodeAt(i - 1) === 61; // NAME=( … )
      push(i, i + 1, "punctuation"); open.push(array ? "a" : "("); first = !array; i++; continue;
    }
    if (c === 41) {
      if (top === "m" && line.charCodeAt(i + 1) === 41) { push(i, i + 2, "keyword"); open.pop(); i += 2; first = false; continue; }
      push(i, i + 1, "punctuation"); i++;
      if (top === "(" || top === "a" || top === "p") { open.pop(); first = false; } else if (!math) first = true; // no "(" before it: the end of a case pattern
      continue;
    }
    if (c === 59) { // ";" ends a command, ";;" a case branch
      const two = line.charCodeAt(i + 1) === 59;
      push(i, i + (two ? 2 : 1), two ? "operator" : "punctuation"); i += two ? 2 : 1;
      first = top !== "a" && !math; decl = false; name = ""; wantIn = ""; pattern = two; continue;
    }
    if (c === 60 && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60 && !math) {
      SH_HERE.lastIndex = i;
      const m = SH_HERE.exec(line);
      if (m) { push(i, SH_HERE.lastIndex, "keyword"); here = { h: m[3] ?? m[5], raw: Boolean(m[2] || m[4]), tabs: m[1] === "-" }; i = SH_HERE.lastIndex; continue; }
    }
    if (c === 60 || c === 62 || c === 38 || isDigit(c)) { // redirections: 2>&1, >>file, <<<"$x", &>log
      SH_REDIR.lastIndex = i;
      if (!math && SH_REDIR.test(line)) { push(i, SH_REDIR.lastIndex, "operator"); i = SH_REDIR.lastIndex; continue; }
    }
    if (c === 124 || c === 38) { // | || |& & &&: another command follows
      const d = line.charCodeAt(i + 1), two = d === c || (c === 124 && d === 38);
      push(i, i + (two ? 2 : 1), "operator"); i += two ? 2 : 1;
      first = top !== "a" && !math; decl = false; continue;
    }
    if (c === 123 && (i + 1 >= n || isSpace(line.charCodeAt(i + 1)))) { push(i, i + 1, "punctuation"); i++; first = true; continue; } // "{ list; }"
    if (c === 125) { push(i, i + 1, "punctuation"); i++; first = false; continue; }
    if (c === 92 && i === n - 1) { goesOn = !first; i++; continue; } // "\" at the end: the command goes on in the next line
    SH_WORD.lastIndex = i;
    if (!SH_WORD.test(line)) { i++; continue; }
    let end = SH_WORD.lastIndex;
    const w = line.slice(i, end);
    if (math) { if (SH_NUMBER.test(w)) push(i, end, "number"); i = end; continue; }
    if (top === "a") { i = end; continue; }
    if (first || decl) { // NAME=value, NAME+=value, NAME[i]=value
      SH_ASSIGN.lastIndex = i;
      if (SH_ASSIGN.test(line) && SH_ASSIGN.lastIndex <= end) {
        const eq = SH_ASSIGN.lastIndex;
        push(i, eq - 1 - (line.charCodeAt(eq - 2) === 43 ? 1 : 0), "constant"); push(eq - 1 - (line.charCodeAt(eq - 2) === 43 ? 1 : 0), eq, "operator");
        if (eq < end && SH_NUMBER.test(line.slice(eq, end))) push(eq, end, "number");
        if (first && eq === end) again = open.length; // a quoted value or "$(…)" follows
        i = end; continue; // still at a command: "LANG=C sort"
      }
    }
    if (first) {
      first = false;
      if (w === "[[" || w === "[") push(i, end, "keyword");
      else if (w === "!") { push(i, end, "operator"); first = true; }
      else if (SH_KW.has(w)) {
        push(i, end, "keyword");
        if (SH_GOES_ON.has(w)) first = true;
        else if (SH_DECL.has(w)) decl = true;
        else if (w === "function") name = "f";
        else if (w === "for" || w === "select") { name = "v"; wantIn = "for"; }
        else if (w === "case") wantIn = "case";
      } else {
        SH_FN.lastIndex = end;
        if (SH_FN.test(line)) { push(i, end, "function", true); push(end, SH_FN.lastIndex, "punctuation"); end = SH_FN.lastIndex; first = true; } // name() {
        else push(i, end, "function", true);
      }
    } else if (name) { push(i, end, name === "f" ? "function" : "constant", name === "f"); first = name === "f"; name = ""; }
    else if (w === "in" && wantIn) { push(i, end, "keyword"); pattern = wantIn === "case"; wantIn = ""; }
    else if (w === "]]" || w === "]") push(i, end, "keyword");
    else if (decl && SH_NAME.test(w)) push(i, end, "constant"); // local name
    else if (SH_OPTION.test(w) && (i === 0 || isSpace(line.charCodeAt(i - 1)))) { const eq = w.indexOf("="); push(i, eq < 0 ? end : i + eq, "type"); }
    else if (SH_NUMBER.test(w)) push(i, end, "number");
    else if (SH_TEST.test(w)) push(i, end, "operator");
    i = end;
  }
  const s = open.join("");
  if (here) return { spans, state: { ...here, s } };
  return { spans, state: s || goesOn ? { s, k: goesOn } : null };
}

// A line of shell inside another language (a Makefile's recipe, a workflow's "run"): the host's own references
// ("$(VAR)", "${{ … }}") are no shell. refs(line, from, own) pushes their spans to `own` and returns their ranges
// [[start, end]]; the shell scanner sees a plain word in each range's place, and what it says about those stretches
// gives way to the host's spans. Returns the shell's state for the next line.
function hostShell(line, from, state, spans, refs) {
  const own = [], ranges = refs(line, from, own);
  if (!ranges.length) return shell(line, state, from, spans).state;
  let masked = "", at = 0;
  for (const [a, b] of ranges) { masked += line.slice(at, a) + "\u0001".repeat(b - a); at = b; }
  const got = [], out = shell(masked + line.slice(at), state, from, got).state, first = spans.length;
  let r = 0;
  for (const s of got) {
    let a = s.start;
    while (r < ranges.length && ranges[r][1] <= a) r++;
    for (let k = r; k < ranges.length && ranges[k][0] < s.end; k++) { if (ranges[k][0] > a) spans.push({ ...s, start: a, end: ranges[k][0] }); a = Math.max(a, ranges[k][1]); }
    if (a < s.end) spans.push(a === s.start ? s : { ...s, start: a });
  }
  spans.push(...own);
  const tail = spans.splice(first).sort((x, y) => x.start - y.start);
  spans.push(...tail);
  return out;
}

// Make. A line is a directive, an assignment, a rule (targets, ":", what they need) or, indented, a recipe line: shell
// with make's references in it. The diff view draws a tab as spaces, so any indented line that is neither a directive
// nor an assignment in make's spelling counts as a recipe.
// state: {m: "v"} a line that ended in "\" goes on as a value, {m: "r", sh} a recipe line goes on (sh: the shell's own
// state), {m: "d"} inside define … endef.
const MAKE_DIR = words("include -include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override private undefine vpath");
const MAKE_FN = words("shell wildcard patsubst subst filter filter-out sort word words wordlist firstword lastword dir notdir suffix basename addsuffix addprefix join realpath abspath if or and foreach call value eval origin flavor error warning info strip findstring file let intcmp");
const MAKE_WORD = /-?[a-z]+(?=[ \t]|$)/y, MAKE_NAME = /[a-z-]+(?=[ \t,])/y;
const MAKE_ASSIGN = /[ \t]*([A-Za-z_.][\w.\/-]*|\$[({][^)}]*[)}])([ \t]*)(::?:?=|[?+!]=|=)/y;
const MAKE_RULE = /[ \t]*((?:[^:=#\s$]|\$[({][^)}]*[)}]|\$.)(?:[^:=#$]|\$[({][^)}]*[)}]|\$.)*?)[ \t]*(::?)(?!=)/y;
// One "$…" of make at i (line[i] is "$"): its spans go to out, the index after it comes back (i: none here).
// "$(VAR)", "${VAR}", "$@", "$(fn args)" with the function's name and the references in its arguments. "$$" is a "$"
// for the shell: in a recipe only the first one is make's.
function makeRef(line, i, n, out, recipe) {
  const d = line.charCodeAt(i + 1);
  if (d === 36) { out.push({ start: i, end: recipe ? i + 1 : i + 2, kind: "operator" }); return recipe ? i + 1 : i + 2; }
  if (d === 40 || d === 123) {
    const close = d === 40 ? 41 : 125;
    let depth = 1, j = i + 2;
    for (; j < n && depth; j++) { const c = line.charCodeAt(j); if (c === d) depth++; else if (c === close) depth--; }
    const inner = depth ? j : j - 1;
    MAKE_NAME.lastIndex = i + 2;
    const fn = MAKE_NAME.test(line) && MAKE_NAME.lastIndex < inner && MAKE_FN.has(line.slice(i + 2, MAKE_NAME.lastIndex)) ? MAKE_NAME.lastIndex : 0;
    if (!fn) { out.push({ start: i, end: j, kind: "variable" }); return j; }
    out.push({ start: i, end: i + 2, kind: "variable" }, { start: i + 2, end: fn, kind: "function" });
    if (line.startsWith("shell", i + 2)) shell(line.slice(0, inner), null, fn, out); // $(shell git describe): a command
    else makeText(line, fn, inner, out, null);
    if (!depth) out.push({ start: inner, end: j, kind: "variable" });
    return j;
  }
  if (i + 1 < n && !isSpace(d)) { out.push({ start: i, end: i + 2, kind: "variable" }); return i + 2; } // $@ $< $^ $* $? $x
  return i;
}
// Text of make from a to b where the references stand out; base: the kind of the text between them (null: none).
function makeText(line, a, b, out, base) {
  let at = a;
  for (let j = line.indexOf("$", a); j >= 0 && j < b; j = line.indexOf("$", j)) {
    const tmp = [], end = makeRef(line, j, b, tmp, false);
    if (end <= j) { j++; continue; }
    if (base && j > at) out.push({ start: at, end: j, kind: base });
    for (const s of tmp) out.push(s);
    at = j = end;
  }
  if (base && b > at) out.push({ start: at, end: b, kind: base });
}
const makeRefs = (line, from, own) => {
  const ranges = [];
  for (let j = line.indexOf("$", from); j >= 0; j = line.indexOf("$", j)) {
    const end = makeRef(line, j, line.length, own, true);
    if (end <= j) j++; else { ranges.push([j, end]); j = line.charCodeAt(j + 1) === 36 ? j + 2 : end; } // "$$": the second "$" is the shell's
  }
  return ranges;
};
function make(line, state) {
  const n = line.length, spans = [], push = (start, end, kind) => { if (end > start) spans.push({ start, end, kind }); };
  const cont = n > 0 && line.charCodeAt(n - 1) === 92;
  // A value: text with references, up to a comment.
  const value = (from) => {
    let hash = line.indexOf("#", from);
    while (hash > 0 && line.charCodeAt(hash - 1) === 92) hash = line.indexOf("#", hash + 1);
    makeText(line, from, hash < 0 ? n : hash, spans, null);
    if (hash >= 0) push(hash, n, "comment");
  };
  const recipe = (from, sh) => {
    let i = from;
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    const at = i;
    while (i < n && (line.charCodeAt(i) === 64 || line.charCodeAt(i) === 45 || line.charCodeAt(i) === 43)) i++; // @ - + before the command
    push(at, i, "operator");
    const out = hostShell(line, i, sh, spans, makeRefs);
    return { spans, state: out || cont ? { m: "r", sh: out } : null }; // "\" at the end: the recipe line goes on, whatever the shell makes of it
  };
  const assign = (from) => { // NAME = value, NAME := value, NAME ?= value, NAME += value
    MAKE_ASSIGN.lastIndex = from;
    const m = MAKE_ASSIGN.exec(line);
    if (!m) return null;
    const end = MAKE_ASSIGN.lastIndex, op = end - m[3].length, name = op - m[2].length - m[1].length;
    return { m, end, op, name };
  };
  const assigned = (a) => { push(a.name, a.name + a.m[1].length, "variable"); push(a.op, a.end, "operator"); value(a.end); return { spans, state: cont ? { m: "v" } : null }; };
  if (state?.m === "d") { // the body of define … endef
    if (line.trim() === "endef") { push(0, n, "keyword"); return { spans, state: null }; }
    makeText(line, 0, n, spans, null);
    return { spans, state };
  }
  if (state?.m === "r") return recipe(0, state.sh);
  if (state?.m === "v") { value(0); return { spans, state: cont ? state : null }; }
  let i = 0;
  while (i < n && isSpace(line.charCodeAt(i))) i++;
  if (i === n) return { spans, state: null };
  if (line.charCodeAt(i) === 35) { push(i, n, "comment"); return { spans, state: null }; }
  MAKE_WORD.lastIndex = i;
  let w = MAKE_WORD.test(line) ? line.slice(i, MAKE_WORD.lastIndex) : "";
  if (MAKE_DIR.has(w)) {
    let j = MAKE_WORD.lastIndex;
    push(i, j, "keyword");
    if (w === "else") { MAKE_WORD.lastIndex = j + 1; if (MAKE_WORD.test(line) && MAKE_DIR.has(line.slice(j + 1, MAKE_WORD.lastIndex))) { push(j + 1, MAKE_WORD.lastIndex, "keyword"); j = MAKE_WORD.lastIndex; } } // else ifeq (…)
    if (w === "define") { push(j + 1, n, "variable"); return { spans, state: { m: "d" } }; }
    const a = w === "export" || w === "override" || w === "private" || w === "unexport" ? assign(j) : null;
    if (a) return assigned(a);
    value(j);
    return { spans, state: cont ? { m: "v" } : null };
  }
  const a = assign(0);
  // Indented, "NAME = value" needs make's spelling (a space before "=" or ":=", "?=", "+="): "X=1 cmd" is shell.
  if (a && (i === 0 || a.m[3] !== "=" || a.m[2])) return assigned(a);
  if (i > 0) return recipe(i, null);
  MAKE_RULE.lastIndex = 0;
  const r = MAKE_RULE.exec(line);
  if (!r) { value(0); return { spans, state: cont ? { m: "v" } : null }; }
  const colon = MAKE_RULE.lastIndex - r[2].length, tEnd = r[1].length; // the targets start at 0: the line is not indented
  for (let s = 0; s < tEnd;) { // each target: a special one (.PHONY) is a keyword, a name or a pattern a function
    while (s < tEnd && isSpace(line.charCodeAt(s))) s++;
    let e = s;
    while (e < tEnd && !isSpace(line.charCodeAt(e))) e++;
    if (e > s) { if (line.charCodeAt(s) === 46 && /^\.[A-Z_]+$/.test(line.slice(s, e))) push(s, e, "keyword"); else makeText(line, s, e, spans, "function"); }
    s = e;
  }
  push(colon, MAKE_RULE.lastIndex, "operator");
  const own = assign(MAKE_RULE.lastIndex); // prog: CFLAGS += -g
  if (own) return assigned(own);
  const semi = line.indexOf(";", MAKE_RULE.lastIndex), hash = line.indexOf("#", MAKE_RULE.lastIndex);
  if (semi >= 0 && (hash < 0 || semi < hash)) { // target: what it needs ; a command on the same line
    makeText(line, MAKE_RULE.lastIndex, semi, spans, null); push(semi, semi + 1, "punctuation");
    return recipe(semi + 1, null);
  }
  value(MAKE_RULE.lastIndex);
  return { spans, state: cont ? { m: "v" } : null };
}

// YAML, line by line. state: null; {b: column, run, sh} inside a block scalar ("|", ">"): every line indented deeper
// than column b is its text (run: a workflow's script, colored as shell, sh: the shell's own state); {q: quote code}
// inside a quoted scalar that goes on. flavor: "workflow" (GitHub Actions: its keys, "uses: owner/repo@ref", "run" and
// "if") or "spring" ("#{…}" in a value). Values are colored for what they are as a whole (a number, true, null);
// other plain text stays plain, with "${NAME}" and "${{ … }}" standing out.
const Y_KEY = /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?=[ \t]*:)|(?:[^\s?:,\[\]{}#&*!|>'"%@`-](?:[^:#]|:(?!\s|$)|(?<=\S)#)*?|-(?=\S)(?:[^:#]|:(?!\s|$))*?)(?=[ \t]*:(?:\s|$))/y;
const Y_NAME = /[^\s,\[\]{}]+/y, Y_BLOCK = /[|>][+-]?\d?[+-]?(?=[ \t]*(?:#.*)?$)/y, Y_FLOW = /[^,\[\]{}#\s](?:[^,\[\]{}#:]|:(?!\s|$)|(?<=\S)#)*/y;
const Y_NUMBER = /^(?:[-+]?(?:\d[\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?|[-+]?\.\d+|0x[\da-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const Y_BOOL = words("true false yes no on off True False Yes No On Off TRUE FALSE YES NO ON OFF"), Y_NULL = words("null Null NULL ~");
const GHA_KEYS = words("name on jobs steps uses with run env needs if permissions strategy matrix runs-on secrets concurrency defaults outputs inputs services container environment timeout-minutes continue-on-error shell working-directory id push pull_request pull_request_target workflow_dispatch workflow_call workflow_run schedule cron branches branches-ignore tags tags-ignore paths paths-ignore types group cancel-in-progress fail-fast max-parallel include exclude runs using main pre post description required default type options image ports volumes credentials release issues");
const GHA_CTX = words("github env vars job jobs steps runner secrets strategy matrix needs inputs");
const GHA_ID = /[A-Za-z_][\w-]*/y, GHA_OP = /[=!<>]=|&&|\|\||[!<>]/y;
// A GitHub Actions expression from a to b: contexts (github, secrets, matrix), functions, strings, numbers, operators.
function ghaExpr(line, a, b, out) {
  for (let i = a, at = a - 1; i < b;) {
    i = forward(i, at); at = i;
    if (i >= b) break;
    const c = line.charCodeAt(i);
    if (c === 39) { let j = i + 1; while (j < b && (line.charCodeAt(j) !== 39 || line.charCodeAt(++j) === 39)) j++; out.push({ start: i, end: Math.min(j, b), kind: "string" }); i = Math.min(j, b); continue; }
    if (isDigit(c)) { let j = i; while (j < b && (isDigit(line.charCodeAt(j)) || line.charCodeAt(j) === 46)) j++; out.push({ start: i, end: j, kind: "number" }); i = j; continue; }
    GHA_ID.lastIndex = i;
    if (GHA_ID.test(line) && GHA_ID.lastIndex <= b) {
      const e = GHA_ID.lastIndex, w = line.slice(i, e), member = line.charCodeAt(i - 1) === 46;
      const kind = line.charCodeAt(e) === 40 ? "function" : member ? null : GHA_CTX.has(w) ? "variable" : w === "true" || w === "false" ? "boolean" : w === "null" ? "constant" : null;
      if (kind) out.push({ start: i, end: e, kind });
      i = e; continue;
    }
    GHA_OP.lastIndex = i;
    if (GHA_OP.test(line) && GHA_OP.lastIndex <= b) { out.push({ start: i, end: GHA_OP.lastIndex, kind: "operator" }); i = GHA_OP.lastIndex; continue; }
    i++;
  }
}
// The placeholders of a text from a to b: "${{ expression }}", "${NAME:default}" and, with spel, "#{…}". Their spans go
// to out, the text between them in `base` (null: none); with ranges, each placeholder's [start, end] is added to it.
function holes(line, a, b, out, base, spel, ranges) {
  let at = a;
  for (let j = a; j < b - 1; j++) {
    const c = line.charCodeAt(j);
    if ((c !== 36 && !(spel && c === 35)) || line.charCodeAt(j + 1) !== 123) continue;
    const expr = c === 36 && line.charCodeAt(j + 2) === 123, close = line.indexOf(expr ? "}}" : "}", j + 2);
    if (close < 0 || close >= b) continue;
    const end = close + (expr ? 2 : 1);
    if (base && j > at) out.push({ start: at, end: j, kind: base });
    if (expr) { out.push({ start: j, end: j + 3, kind: "operator" }); ghaExpr(line, j + 3, close, out); out.push({ start: close, end, kind: "operator" }); }
    else out.push({ start: j, end, kind: "variable" });
    ranges?.push([j, end]);
    at = end; j = end - 1;
  }
  if (base && b > at) out.push({ start: at, end: b, kind: base });
}
const ghaRefs = (line, from, own) => { const ranges = []; holes(line, from, line.length, own, null, false, ranges); return ranges; };
function yaml(line, state, flavor) {
  const n = line.length, spans = [], push = (start, end, kind) => { if (end > start) spans.push({ start, end, kind }); };
  const workflow = flavor === "workflow", spel = flavor === "spring";
  let i = 0, keyCol = 0, key = "";
  while (i < n && line.charCodeAt(i) === 32) i++;
  // A plain scalar from a to e: a number, a boolean or null as a whole; else its placeholders.
  const scalar = (a, e) => {
    const w = line.slice(a, e);
    if (Y_NUMBER.test(w)) push(a, e, "number");
    else if (Y_BOOL.has(w)) push(a, e, "boolean");
    else if (Y_NULL.has(w)) push(a, e, "constant");
    else if (workflow && key === "if" && !w.includes("${{")) ghaExpr(line, a, e, spans);
    else if (workflow && key === "uses" && w.includes("@")) { const at = w.lastIndexOf("@"); push(a + at, a + at + 1, "operator"); push(a + at + 1, e, "constant"); } // owner/repo@ref
    else holes(line, a, e, spans, null, spel, null);
  };
  // A key of a flow collection ("{a: 1, b: 2}"): after "{" and ",".
  const flowKey = (from) => {
    let j = from;
    while (j < n && isSpace(line.charCodeAt(j))) j++;
    Y_KEY.lastIndex = j;
    if (!Y_KEY.test(line)) return from;
    push(j, Y_KEY.lastIndex, "function");
    j = line.indexOf(":", Y_KEY.lastIndex);
    push(j, j + 1, "punctuation");
    return j + 1;
  };
  // What follows a key or a "- ": scalars, quotes, anchors, tags, a flow collection, a comment. Returns the state.
  const value = (from) => {
    let depth = 0;
    for (let j = from, at = from - 1; j < n;) {
      j = forward(j, at); at = j;
      if (j >= n) break;
      const c = line.charCodeAt(j);
      if (isSpace(c)) { j++; continue; }
      if (c === 35 && (j === 0 || isSpace(line.charCodeAt(j - 1)))) { push(j, n, "comment"); return null; }
      if (c === 34 || c === 39) {
        let e = j + 1;
        for (; e < n; e++) { const d = line.charCodeAt(e); if (d === 92 && c === 34) e++; else if (d === c) { if (c === 39 && line.charCodeAt(e + 1) === 39) e++; else break; } }
        if (e >= n) { holes(line, j, n, spans, "string", spel, null); return { q: c }; }
        holes(line, j, e + 1, spans, "string", spel, null); j = e + 1; continue;
      }
      if (c === 38 || c === 42 || c === 33) { // &anchor, *alias, !Tag
        Y_NAME.lastIndex = j + 1;
        const e = Y_NAME.test(line) ? Y_NAME.lastIndex : j + 1;
        push(j, e, c === 33 ? "type" : "constant"); j = e; continue;
      }
      if ((c === 124 || c === 62) && !depth) {
        Y_BLOCK.lastIndex = j;
        if (Y_BLOCK.test(line)) {
          push(j, Y_BLOCK.lastIndex, "operator");
          const hash = line.indexOf("#", Y_BLOCK.lastIndex);
          if (hash >= 0) push(hash, n, "comment");
          return workflow && key === "run" ? { b: keyCol, run: 1, sh: null } : { b: keyCol };
        }
      }
      if (c === 91 || c === 123) { push(j, j + 1, "punctuation"); depth++; j = flowKey(j + 1); continue; }
      if (c === 93 || c === 125) { push(j, j + 1, "punctuation"); depth--; j++; continue; }
      if (c === 44 && depth > 0) { push(j, j + 1, "punctuation"); j = flowKey(j + 1); continue; }
      let e;
      if (depth > 0) { Y_FLOW.lastIndex = j; e = Y_FLOW.test(line) ? Y_FLOW.lastIndex : j + 1; }
      else { e = line.indexOf(" #", j); if (e < 0) e = n; }
      while (e > j && isSpace(line.charCodeAt(e - 1))) e--;
      if (e === j) { j++; continue; }
      if (workflow && key === "run" && !depth) return hostShell(line, j, null, spans, ghaRefs) && null; // run: one line of shell
      scalar(j, e); j = e;
    }
    return null;
  };
  if (state?.q) { // a quoted scalar from the line before
    let e = 0;
    for (; e < n; e++) { const d = line.charCodeAt(e); if (d === 92 && state.q === 34) e++; else if (d === state.q) { if (state.q === 39 && line.charCodeAt(e + 1) === 39) e++; else break; } }
    if (e >= n) { holes(line, 0, n, spans, "string", spel, null); return { spans, state }; }
    holes(line, 0, e + 1, spans, "string", spel, null);
    return { spans, state: value(e + 1) };
  }
  if (state?.b !== undefined) { // a block scalar's text: deeper than its key, or an empty line
    if (i === n) return { spans, state };
    if (i > state.b) {
      if (!state.run) { holes(line, i, n, spans, "string", spel, null); return { spans, state }; }
      const sh = hostShell(line, i, state.sh, spans, ghaRefs);
      return { spans, state: sh === state.sh ? state : { ...state, sh } };
    }
  }
  if (i === n) return { spans, state: null };
  if (line.charCodeAt(i) === 35) { push(i, n, "comment"); return { spans, state: null }; }
  if (i === 0 && (line.startsWith("---") || line.startsWith("...")) && (n === 3 || isSpace(line.charCodeAt(3)))) { push(0, 3, "punctuation"); return { spans, state: value(3) }; }
  if (i === 0 && line.charCodeAt(0) === 37) { push(0, n, "keyword"); return { spans, state: null }; } // %YAML 1.2
  keyCol = i;
  while (line.charCodeAt(i) === 45 && (i + 1 >= n || isSpace(line.charCodeAt(i + 1)))) { // "- " opens a list entry
    push(i, i + 1, "operator"); keyCol = i; i++;
    while (i < n && isSpace(line.charCodeAt(i))) i++;
  }
  Y_KEY.lastIndex = i;
  if (Y_KEY.test(line)) {
    const e = Y_KEY.lastIndex;
    key = line.slice(i, e); keyCol = i;
    push(i, e, key === "<<" ? "operator" : workflow && GHA_KEYS.has(key) ? "keyword" : "function");
    i = line.indexOf(":", e);
    push(i, i + 1, "punctuation"); i++;
  }
  return { spans, state: value(i) };
}

// key=value files (.properties, .ini, .cfg, .conf, .editorconfig): comments ("#", "!", ";"), "[section]", the key up
// to "=", ":" or a space with its dots apart, the value as text with "${…}", "#{…}" and "\uXXXX" standing out; a
// value that is a number or a boolean as a whole is colored as one. state {k: 1}: a line that ended in "\" goes on.
const P_KEY = /(?:[^\s=:\\]|\\.)+/y, P_ESC = /\\(?:u[\da-fA-F]{4}|.)/y;
function properties(line, state) {
  const n = line.length, spans = [], push = (start, end, kind) => { if (end > start) spans.push({ start, end, kind }); };
  let tail = n, i = 0;
  while (tail > 0 && line.charCodeAt(tail - 1) === 92) tail--;
  const cont = (n - tail) % 2 === 1;
  const text = (a, b) => { // the value's text, its escapes and placeholders apart
    let at = a;
    for (let j = a; j < b; j++) {
      const c = line.charCodeAt(j);
      let end = 0, kind = "variable";
      if (c === 92) { P_ESC.lastIndex = j; if (P_ESC.test(line)) { end = P_ESC.lastIndex; kind = "string.escape"; } }
      else if ((c === 36 || c === 35) && line.charCodeAt(j + 1) === 123) { const close = line.indexOf("}", j + 2); if (close >= 0 && close < b) end = close + 1; }
      if (!end) continue;
      push(at, j, "string"); push(j, end, kind); at = end; j = end - 1;
    }
    push(at, b, "string");
  };
  while (i < n && isSpace(line.charCodeAt(i))) i++;
  if (state?.k) { text(i, n); return { spans, state: cont ? state : null }; }
  if (i === n) return { spans, state: null };
  const c = line.charCodeAt(i);
  if (c === 35 || c === 33 || c === 59) { push(i, n, "comment"); return { spans, state: null }; }
  if (c === 91 && line.indexOf("]", i) > 0) { const e = line.indexOf("]", i) + 1; push(i, e, "keyword"); if (line.indexOf("#", e) >= 0) push(line.indexOf("#", e), n, "comment"); return { spans, state: null }; }
  P_KEY.lastIndex = i;
  if (!P_KEY.test(line)) return { spans, state: null };
  const ke = P_KEY.lastIndex;
  for (let s = i; s < ke;) { const dot = line.indexOf(".", s), e = dot < 0 || dot >= ke ? ke : dot; push(s, e, "function"); if (e < ke) push(e, e + 1, "punctuation"); s = e + 1; }
  let j = ke;
  while (j < n && isSpace(line.charCodeAt(j))) j++;
  if (line.charCodeAt(j) === 61 || line.charCodeAt(j) === 58) { push(j, j + 1, "operator"); j++; while (j < n && isSpace(line.charCodeAt(j))) j++; }
  const w = line.slice(j).trimEnd();
  if (Y_NUMBER.test(w)) push(j, j + w.length, "number");
  else if (w === "true" || w === "false") push(j, j + w.length, "boolean");
  else text(j, n);
  return { spans, state: cont ? { k: 1 } : null };
}

// TOML: "[table]" and "[[array]]" heads, keys (a word before "="), strings (""" and ''' over lines), numbers and
// dates, booleans, comments. state {end}: inside a multi-line string.
const T_WORD = /[^\s,\[\]{}=#"']+/y, T_NUMBER = /^[+-]?(?:\d|inf$|nan$)/;
function toml(line, state) {
  const n = line.length, spans = [], push = (start, end, kind) => { if (end > start) spans.push({ start, end, kind }); };
  let i = 0;
  if (state?.end) {
    const e = line.indexOf(state.end);
    if (e < 0) { push(0, n, "string"); return { spans, state }; }
    push(0, e + 3, "string"); i = e + 3;
  } else {
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    if (line.charCodeAt(i) === 91) { const e = line.lastIndexOf("]", line.includes("#") ? line.indexOf("#") : n); if (e > i) { push(i, e + 1, "type"); i = e + 1; } } // [table], [[array]]
  }
  for (let at = i - 1; i < n;) {
    i = forward(i, at); at = i;
    if (i >= n) break;
    const c = line.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 35) { push(i, n, "comment"); break; }
    if (c === 34 || c === 39) {
      const q = line[i], multi = line.startsWith(q + q + q, i);
      if (multi) { const e = line.indexOf(q + q + q, i + 3); if (e < 0) { push(i, n, "string"); return { spans, state: { end: q + q + q } }; } push(i, e + 3, "string"); i = e + 3; continue; }
      let j = i + 1;
      while (j < n && line[j] !== q) j += c === 34 && line[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, n);
      let k = end; while (k < n && isSpace(line.charCodeAt(k))) k++;
      push(i, end, line.charCodeAt(k) === 61 ? "function" : "string"); i = end; continue; // "a key" = …
    }
    if (c === 61) { push(i, i + 1, "operator"); i++; continue; }
    T_WORD.lastIndex = i;
    if (!T_WORD.test(line)) { push(i, i + 1, "punctuation"); i++; continue; }
    const e = T_WORD.lastIndex, w = line.slice(i, e);
    let k = e; while (k < n && isSpace(line.charCodeAt(k))) k++;
    if (line.charCodeAt(k) === 61) push(i, e, "function");
    else if (w === "true" || w === "false") push(i, e, "boolean");
    else if (T_NUMBER.test(w)) push(i, e, "number");
    i = e;
  }
  return { spans, state: null };
}

const DOCKER = /^(\s*)(FROM|RUN|CMD|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|ENTRYPOINT|USER|LABEL|VOLUME|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL|MAINTAINER)\b/i;
// An instruction's rest is a command after RUN, CMD, ENTRYPOINT and SHELL, and NAME=value pairs after ENV, ARG and
// LABEL; the others take arguments (a path, a port, an image): no word of them is a command. "--from=build" and
// "--mount=…" right after the instruction are its options.
const DOCKER_CMD = words("run cmd entrypoint shell env arg label"), DOCKER_FLAGS = /(?:[ \t]+--[\w-]+(?:=\S+)?)+/y, DOCKER_SUB = /[ \t]+(CMD|NONE|RUN|COPY|ADD)\b/iy;
const SH_ARGS = { s: "", k: true }; // the shell scanner's state for "arguments go on": the next word is no command
function dockerfile(line, state) {
  if (state?.cont) { const r = shell(line, state.args ? SH_ARGS : null, 0, []); return { spans: r.spans, state: /\\\s*$/.test(line) ? state : null }; }
  if (/^\s*#/.test(line)) return { spans: [{ start: 0, end: line.length, kind: "comment" }], state: null };
  const m = DOCKER.exec(line);
  if (!m) return { spans: [], state: null };
  const spans = [{ start: m[1].length, end: m[0].length, kind: "keyword" }];
  let from = m[0].length, word = m[2].toLowerCase();
  DOCKER_FLAGS.lastIndex = from;
  if (DOCKER_FLAGS.test(line)) { spans.push({ start: from + 1, end: DOCKER_FLAGS.lastIndex, kind: "type" }); from = DOCKER_FLAGS.lastIndex; }
  DOCKER_SUB.lastIndex = from;
  const sub = word === "healthcheck" || word === "onbuild" ? DOCKER_SUB.exec(line) : null; // HEALTHCHECK CMD …, ONBUILD RUN …
  if (sub) { spans.push({ start: DOCKER_SUB.lastIndex - sub[1].length, end: DOCKER_SUB.lastIndex, kind: "keyword" }); from = DOCKER_SUB.lastIndex; word = sub[1].toLowerCase(); }
  const args = !DOCKER_CMD.has(word), as = word === "from" ? / AS /i.exec(line) : null;
  shell(as ? line.slice(0, as.index) : line, args ? SH_ARGS : null, from, spans);
  if (as) spans.push({ start: as.index + 1, end: as.index + 3, kind: "keyword" });
  return { spans, state: !/\\\s*$/.test(line) ? null : args ? { cont: 1, args: 1 } : { cont: 1 } };
}

// Markdown: front matter, headings, fences (highlighted in the fence's language), quotes, lists, tables, inline code,
// emphasis, links. Link spans carry `href`.
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
function markdown(line, state) {
  const n = line.length, spans = [];
  if (state?.fm) { // front matter
    if (/^(---|\.\.\.)\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    return { spans: yaml(line, null, "").spans, state };
  }
  if (state?.fence) {
    const m = FENCE.exec(line);
    if (m && m[2][0] === state.fence[0] && m[2].length >= state.fence.length && !m[3]) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    if (!state.lang) return { spans: [{ start: 0, end: n, kind: "string" }], state };
    const r = tokenize(line, state.lang, state.inner);
    return { spans: r.spans, state: { ...state, inner: r.state } };
  }
  if (state === null && /^---\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: { fm: 1 } };
  const fence = FENCE.exec(line);
  if (fence) {
    spans.push({ start: 0, end: n, kind: "punctuation" });
    return { spans, state: { fence: fence[2], lang: fence[3] ? langOf(`x.${fence[3].toLowerCase()}`) ?? FENCE_LANG[fence[3].toLowerCase()] ?? null : null, inner: null } };
  }
  const h = /^\s{0,3}#{1,6}(\s|$)/.exec(line);
  if (h) return { spans: [{ start: 0, end: n, kind: "keyword" }], state: "md" };
  if (/^\s{0,3}>/.test(line)) { spans.push({ start: 0, end: line.indexOf(">") + 1, kind: "comment" }); inline(line, line.indexOf(">") + 1, spans); return { spans, state: "md" }; }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: "md" };
  const li = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?/.exec(line);
  let from = 0;
  if (li) { spans.push({ start: li[1].length, end: li[1].length + li[2].length, kind: "operator" }); from = li[0].length; if (li[4]) spans.push({ start: from - li[4].length, end: from - 1, kind: "constant" }); }
  inline(line, from, spans);
  return { spans, state: "md" };
}
const FENCE_LANG = { typescript: "js", javascript: "js", python: "python", golang: "go", rust: "rust", terraform: "hcl", shell: "shell", console: "shell", shellscript: "shell", make: "make", makefile: "make", yml: "yaml", dotenv: "shell", ini: "properties", docker: "dockerfile" };

const INLINE = /(`+)(.+?)\1|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\[[^\]]*\]|<(https?:\/\/[^>\s]+)>|(?<!\w)(\*\*|__)(?=\S)(.+?\S)\7(?!\w)|(?<!\w)(\*|_)(?=\S)(.+?\S)\9(?!\w)|(\|)|https?:\/\/[^\s)>\]]+/g;
function inline(line, from, spans) {
  INLINE.lastIndex = from;
  for (let m; (m = INLINE.exec(line));) {
    if (!m[0]) { INLINE.lastIndex++; continue; } // an empty match would be found again at the same place
    const s = m.index, e = s + m[0].length;
    if (m[1]) spans.push({ start: s, end: e, kind: "string" });
    else if (m[4] !== undefined) {
      const textEnd = s + m[0].indexOf("](") + 1;
      spans.push({ start: s, end: textEnd, kind: "function", ref: true, href: m[4] });
      spans.push({ start: textEnd, end: e, kind: "string", ref: true, href: m[4] });
    } else if (m[5]) spans.push({ start: s, end: e, kind: "function" });
    else if (m[6]) spans.push({ start: s, end: e, kind: "string", ref: true, href: m[6] });
    else if (m[7]) spans.push({ start: s, end: e, kind: "type" });
    else if (m[9]) spans.push({ start: s, end: e, kind: "constant" });
    else if (m[11]) spans.push({ start: s, end: e, kind: "punctuation" });
    else spans.push({ start: s, end: e, kind: "string", ref: true, href: m[0] });
  }
}

// Diff rows -> spans per row, with one state per side: context and "+" rows continue the new side, context and "-"
// the old one. "@" (hunk header) rows reset both, since the lines between hunks are unknown.
// ponytail: a block comment opened in hidden lines starts uncolored; carrying it would need the full file.
const memo = new Map();
export function highlightRows(rows, lang, key = null) {
  if (!lang) return rows.map(() => EMPTY);
  const k = key === null ? null : `${key}\0${lang}\0${rows.length}\0${hashRows(rows)}`;
  if (k !== null && memo.has(k)) return memo.get(k);
  const out = highlightStep(highlightJob(rows, lang), Infinity);
  if (k !== null) { if (memo.size > 400) memo.delete(memo.keys().next().value); memo.set(k, out); }
  return out;
}
// The same highlighting a slice at a time, for files too big for one script slice (Herdr stops one after ~50 ms):
// highlightStep tokenizes for about `ms`, keeps its place in the job, and returns the spans once the last row is done
// (null until then). Old and new sides carry their own state, as in a diff.
export const highlightJob = (rows, lang) => ({ rows, lang, i: 0, olds: null, news: null, out: new Array(rows.length) });
export function highlightStep(job, ms = 10) {
  if (!job.lang) return job.rows.map(() => EMPTY);
  const end = Date.now() + ms;
  for (; job.i < job.rows.length; job.i++) {
    const r = job.rows[job.i];
    if (r.kind === "@") { job.olds = job.news = null; job.out[job.i] = EMPTY; }
    else if (r.kind === "-") { const t = tokenize(r.text ?? "", job.lang, job.olds); job.olds = t.state; job.out[job.i] = t.spans; }
    else {
      const t = tokenize(r.text ?? "", job.lang, job.news); job.news = t.state; job.out[job.i] = t.spans;
      if (r.kind !== "+") job.olds = tokenize(r.text ?? "", job.lang, job.olds).state; // context: both sides see it
    }
    if ((job.i & 31) === 31 && Date.now() > end) { job.i++; return null; }
  }
  return job.out;
}
/** The memoized result of highlightRows, or undefined when it still has to be computed (never tokenizes). */
export function cachedRows(rows, lang, key) {
  if (!lang) return rows.map(() => EMPTY);
  return memo.get(`${key}\0${lang}\0${rows.length}\0${hashRows(rows)}`);
}
/** Whole file (full-file view): spans per line. */
export const highlightLines = (lines, lang, key = null) => highlightRows(lines.map((text) => ({ kind: "+", text })), lang, key);
const EMPTY = Object.freeze([]);
function hashRows(rows) {
  let h = 0x811c9dc5;
  for (const r of rows) { const t = r.kind + (r.text ?? ""); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); h = Math.imul(h ^ 10, 0x01000193); }
  return (h >>> 0).toString(16);
}

// Colors: the theme's ANSI palette (tuned for t.background by the theme's author), each checked for contrast; a
// fixed One Dark / GitHub Light color replaces any that falls under 3:1.
const DARK = { keyword: "#c678dd", string: "#98c379", comment: "#7f848e", function: "#61afef", type: "#e5c07b", number: "#d19a66",
  constant: "#56b6c2", boolean: "#d19a66", operator: "#abb2bf", punctuation: "#8b929e", variable: "#e06c75", "string.escape": "#56b6c2" };
const LIGHT = { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", function: "#8250df", type: "#953800", number: "#0550ae",
  constant: "#0550ae", boolean: "#0550ae", operator: "#57606a", punctuation: "#57606a", variable: "#953800", "string.escape": "#0a3069" };
const FROM_THEME = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi6", constant: "ansi6",
  boolean: "ansi6", operator: "muted", punctuation: "muted", variable: "ansi1", "string.escape": "ansi14" };
let colorMemo = null;
export function colors(t, bg = t.background) {
  const key = `${bg}${t.foreground}${t.ansi1}${t.ansi2}${t.ansi3}${t.ansi4}${t.ansi5}${t.ansi6}${t.dim}${t.muted}`;
  if (colorMemo?.key === key) return colorMemo.c;
  const dark = luminance(bg) < 0.35, fixed = dark ? DARK : LIGHT, c = { plain: t.foreground ?? (dark ? "#d4d4d4" : "#1f2328") };
  for (const [name, from] of Object.entries(FROM_THEME)) {
    const v = t[from];
    c[name] = v && /^#[0-9a-f]{6}/i.test(v) && contrast(v, bg) >= (name === "comment" ? 2.5 : 3) ? v.slice(0, 7) : fixed[name];
  }
  colorMemo = { key, c };
  return c;
}
/** Colors for EditorState.new({syntax}) so the full-file view matches the diff. */
export const editorSyntax = (t) => { const { plain, ...rest } = colors(t); return rest; };
function luminance(hex) {
  if (!/^#[0-9a-f]{6}/i.test(hex ?? "")) return 0;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** Spans -> runs covering the whole text: [{start, end, text, color, span?}]. Neighbours with the same color merge;
 *  a `ref` span stays its own run (it gets its own element for hover and click). */
export function runs(text, spans, c) {
  const out = [];
  const add = (start, end, color, span) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (!span && last && !last.span && last.color === color) { last.end = end; last.text = text.slice(last.start, end); return; }
    out.push({ start, end, text: text.slice(start, end), color, span });
  };
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    add(at, s.start, c.plain);
    add(s.start, s.end, c[s.kind] ?? c.plain, s.ref ? s : null);
    at = s.end;
  }
  add(at, text.length, c.plain);
  return out;
}

/** gpui children for one line. `div` is gpui-kit's (passed in so this module stays pure); `decorate(el, run, i)` may
 *  wrap or extend ref runs (id, hover, click, HoverCard). */
export function renderLine(div, text, spans, c, decorate = null) {
  if (!spans.length) return [div().flex_none().whitespace_nowrap().text_color(c.plain).child(text)];
  return runs(text, spans, c).map((r, i) => {
    const el = div().flex_none().whitespace_nowrap().text_color(r.color).child(r.text);
    return r.span && decorate ? decorate(el, r, i) : el;
  });
}

/** The clickable span at a UTF-16 offset (or null). For lists that can't hold per-token handlers (gpui virtual lists):
 *  offset = floor((press.x - codeLeft) / charWidth) in a monospaced row. */
export const refAt = (spans, offset) => spans.find((s) => s.ref && s.start <= offset && offset < s.end) ?? null;
