// "Schema changes" on the Architecture page: what a PR changes about tables, columns, keys and relations, and what of
// it may be risky for data that is in use. Static and pure: no model, no database, nothing is run. The migration and
// model files of the PR head and the PR's own patch (a file before the PR is its head with the patch applied
// backwards) → what each side's files say, as steps (create a table, add a column, …) → the tables of both sides →
// their difference → cards and relations → arch.js archLayout, drawn by stack.js archView.
// Three small readers, none a full parser. What a reader does not understand is "changed, details not read" or is
// named as not read, never guessed:
// - SQL (readSql): CREATE TABLE, ALTER TABLE … ADD / DROP / ALTER / MODIFY / CHANGE / RENAME, ADD CONSTRAINT …
//   PRIMARY KEY / UNIQUE / FOREIGN KEY, CREATE [UNIQUE] INDEX [CONCURRENTLY], DROP TABLE / INDEX, RENAME TO. That
//   covers plain migration folders, Flyway (V…__*.sql), Liquibase's formatted SQL, golang-migrate (…up.sql; the
//   …down.sql only says that a way back exists), goose and dbmate (up to their "down" mark) and a dump such as
//   Rails' structure.sql. The files of one folder are one series, read in the order of their names; the ones the PR
//   does not touch are the state before it (review.js loadSchema reads them from the checkout).
// - Alembic (readAlembic): the op.… calls of upgrade(), in the order of the revisions.
// - Prisma (readPrisma): the models of a schema.prisma, both sides of the one file.
// Not read: Django and Rails migrations, Liquibase changelogs in XML, YAML or JSON, JPA entities, DynamoDB tables in
// Terraform or CloudFormation, views, types, triggers and data changes.
import { archQuick, markRoom, ARCH, FIT } from "./arch.js";
import { sidesOf, dirOf } from "./infra.js"; // a file before the PR: its head with the patch applied backwards

export const SCHEMA_MAX = 20, SCHEMA_ROWS = 12; // tables before one area becomes one card; rows on a card
const MAX_BYTES = 400000; // a larger file (a dump of a big database) is named as not read
// The folder whose files are one series of migrations (…/migrations/<name>/migration.sql: the folder above).
export const seriesOf = (path) => (/(^|\/)migration\.sql$/i.test(path) ? dirOf(dirOf(path)) : dirOf(path));
const squash = (x) => String(x).replace(/\s+/g, " ").trim();
const kindOf = (f) => (/\.prisma$/i.test(f.path) ? "prisma" : /\.sql$/i.test(f.path) ? "sql"
  : /\.py$/.test(f.path) && (/(^|\/)versions\/[^/]+$/.test(f.path) || (f.lines ?? []).some((l) => /\bdown_revision\b/.test(l))) ? "alembic" : null);
// Sources that hold a schema and have no reader here: named under the picture when it shows.
const NO_READER = [[/(^|\/)migrations\/\d+\w*\.py$/, "Django migrations are not read"], [/(^|\/)db\/(migrate\/[^/]+|schema)\.rb$/, "Rails migrations in Ruby are not read"],
  [/changelog[^/]*\.(xml|ya?ml|json)$/i, "Liquibase changelogs in XML, YAML or JSON are not read"]];
const noReader = (f) => NO_READER.find(([re]) => re.test(f.path))?.[1] ?? (/\.(java|kt)$/.test(f.path) && (f.lines ?? []).some((l) => /^[+-]\s*@(Entity|Table|Column|JoinColumn)\b/.test(l)) ? "JPA entities are not read" : null);
/** The files of a patch (pr.js splitPatch) this picture is about. */
export const schemaFiles = (patch) => (patch ?? []).filter((f) => !f.binary && (kindOf(f) || noReader(f)));
/** What review.js reads from the checkout for them: {specs: for git ls-files, keep(path): of the files listed, the ones wanted}. */
export function schemaWants(files) {
  const dirs = new Map();
  for (const f of files) { const k = kindOf(f); if (k === "sql") dirs.set(seriesOf(f.path), ".sql"); else if (k === "alembic") dirs.set(dirOf(f.path), ".py"); }
  const want = files.filter((f) => kindOf(f) && f.status !== "added" && f.status !== "deleted").map((f) => f.path);
  return { specs: [...[...dirs].map(([d, ext]) => `${d ? `${d}/` : ""}*${ext}`), ...want], keep: (p) => want.includes(p) || [...dirs].some(([d, ext]) => p.endsWith(ext) && (ext === ".sql" ? seriesOf(p) : dirOf(p)) === d) };
}

// ---- SQL

const UP_MARK = /^--\s*(\+goose\s+Up|\+migrate\s+Up|migrate:up)\b/i, DOWN_MARK = /^--\s*(\+goose\s+Down|\+migrate\s+Down|migrate:down)\b/i;
// SQL text → {sts: its statements [{toks: [{k: w word | q quoted name | s string | n number | p sign, t, line}], line,
// end}], marked: it has an "up" mark, down: it has a "down" mark (what follows that is not read)}.
// ponytail: '' is the only escape in a string (no backslash), names are ASCII unless quoted.
export function sqlStatements(text) {
  const s = String(text ?? ""), sts = [], WORD = /[A-Za-z_][\w$]*/y, NUM = /\d[\w.]*/y, DOLLAR = /\$([A-Za-z_]\w*)?\$/y;
  let toks = [], line = 1, i = 0, marked = false, down = false;
  const nl = (a, b) => { for (let j = a; j < b; j++) if (s.charCodeAt(j) === 10) line++; };
  const flush = () => { if (toks.length) sts.push({ toks, line: toks[0].line, end: toks[toks.length - 1].line }); toks = []; };
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") { line++; i++; }
    else if (c === " " || c === "\t" || c === "\r") i++;
    else if (c === "-" && s[i + 1] === "-") {
      let n = s.indexOf("\n", i); if (n < 0) n = s.length;
      const note = s.slice(i, n);
      if (UP_MARK.test(note)) marked = true; else if (DOWN_MARK.test(note)) { down = true; break; }
      i = n;
    }
    else if (c === "/" && s[i + 1] === "*") { let n = s.indexOf("*/", i + 2); n = n < 0 ? s.length : n + 2; nl(i, n); i = n; }
    else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < s.length; j++) if (s[j] === c) { if (s[j + 1] === c) j++; else break; }
      toks.push({ k: c === "'" ? "s" : "q", t: c === "'" ? s.slice(i, j + 1) : s.slice(i + 1, j).replaceAll(c + c, c), line });
      nl(i, j); i = j + 1;
    }
    else if (c === "$") {
      DOLLAR.lastIndex = i; const m = DOLLAR.exec(s);
      if (!m) { toks.push({ k: "p", t: c, line }); i++; continue; }
      let e = s.indexOf(m[0], DOLLAR.lastIndex); e = e < 0 ? s.length : e + m[0].length;
      toks.push({ k: "s", t: "$$", line }); nl(i, e); i = e; // a function's body: one string
    }
    else if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") { WORD.lastIndex = i; toks.push({ k: "w", t: WORD.exec(s)[0], line }); i = WORD.lastIndex; }
    else if (c >= "0" && c <= "9") { NUM.lastIndex = i; toks.push({ k: "n", t: NUM.exec(s)[0], line }); i = NUM.lastIndex; }
    else if (c === ";") { flush(); i++; }
    else { toks.push({ k: "p", t: c, line }); i++; }
  }
  flush();
  return { sts, marked, down };
}
// Tokens as one text, the same however the source spaced them: "numeric(10, 2)", "'x'::text", "timestamp with time zone".
function glue(toks) {
  let out = "", prev = null, unary = false;
  for (const x of toks) {
    const t = x.k === "w" ? x.t.toLowerCase() : x.k === "q" ? `"${x.t}"` : x.t;
    const tight = !out || unary || /^[([\],.):]/.test(t) || /[([.:]$/.test(out);
    unary = x.k === "p" && (t === "-" || t === "+") && (!prev || (prev.k === "p" && prev.t !== ")"));
    out += tight ? t : ` ${t}`; prev = x;
  }
  return out;
}
const isName = (x) => Boolean(x) && (x.k === "w" || x.k === "q");
// A reader over a statement's tokens. W(k): the k-th next token as a keyword (a word in capitals, a sign as it is,
// "" for a string, a number or a quoted name; null at the end).
function cursor(toks) {
  let i = 0;
  const W = (k = 0) => { const x = toks[i + k]; return !x ? null : x.k === "w" ? x.t.toUpperCase() : x.k === "p" ? x.t : ""; };
  const eat = (...ws) => (ws.every((w, k) => W(k) === w) ? ((i += ws.length), true) : false);
  return { W, eat, any: (...ws) => ws.some((w) => eat(w)), done: () => i >= toks.length, tok: () => toks[i], skip: () => { i++; }, rest: () => toks.slice(i),
    // A name, with its schema when it is not the default one: lower case unless it was quoted.
    name() {
      const parts = [];
      while (isName(toks[i])) { parts.push(toks[i].k === "w" ? toks[i].t.toLowerCase() : toks[i].t); i++; if (W() === "." && isName(toks[i + 1])) i++; else break; }
      if (parts.length > 1 && /^(public|dbo)$/.test(parts[0])) parts.shift();
      return parts.length ? parts.join(".") : null;
    },
    // The tokens between the bracket at the cursor and the one that closes it; null when there is none.
    group() {
      if (W() !== "(") return null;
      for (let j = i, d = 0; j < toks.length; j++) { const w = toks[j].k === "p" ? toks[j].t : ""; if (w === "(") d++; else if (w === ")" && --d === 0) { const g = toks.slice(i + 1, j); i = j + 1; return g; } }
      return null;
    } };
}
const splitTop = (toks) => { const out = [[]]; let d = 0; for (const x of toks) { if (x.k === "p" && x.t === "(") d++; else if (x.k === "p" && x.t === ")") d--; if (x.k === "p" && x.t === "," && d === 0) out.push([]); else out[out.length - 1].push(x); } return out.filter((p) => p.length); };
// (a, b DESC, email(20), lower(c)) → the plain column names; an expression is null.
const colNames = (g) => splitTop(g ?? []).map((it) => {
  if (!isName(it[0])) return null;
  const len = it[1]?.k === "p" && it[1].t === "(" && it[2]?.k === "n" && it[3]?.t === ")"; // MySQL: the first n characters
  return it.slice(len ? 4 : 1).some((r) => r.k === "p") ? null : it[0].k === "w" ? it[0].t.toLowerCase() : it[0].t;
});
const plain = (cols) => cols.length > 0 && cols.every(Boolean);
const STOP = new Set(["NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "CONSTRAINT", "GENERATED", "COLLATE", "AUTO_INCREMENT", "AUTOINCREMENT", "COMMENT", "ON", "AS", "STORED", "VIRTUAL", "FIRST", "AFTER", "USING", "KEY"]);
// The tokens up to the next word that starts something else (outside brackets), as text.
const upTo = (c) => { const out = []; for (let d = 0; !c.done(); c.skip()) { const w = c.W(); if (d === 0 && STOP.has(w)) break; if (w === "(") d++; else if (w === ")") d--; out.push(c.tok()); } return glue(out); };
// "name type attributes…" → a column {name, type, notNull, default, pk, unique, ref: {table, cols}, line}; null without a name.
// default is the expression as text, or what gives the column a value by itself ("identity", "sequence", …).
function colDef(toks) {
  const c = cursor(toks), name = c.name();
  if (!name) return null;
  const col = { name, type: upTo(c) || null, notNull: false, default: null, pk: false, unique: false, ref: null, line: toks[0].line };
  while (!c.done()) {
    if (c.eat("NOT", "NULL")) col.notNull = true;
    else if (c.eat("NULL")) col.notNull = false;
    else if (c.eat("DEFAULT")) { if (!c.eat("NULL")) col.default = upTo(c) || "set"; }
    else if (c.eat("PRIMARY", "KEY")) { col.pk = true; col.notNull = true; }
    else if (c.eat("UNIQUE")) { col.unique = true; c.eat("KEY"); }
    else if (c.eat("REFERENCES")) col.ref = { table: c.name(), cols: colNames(c.group()).filter(Boolean) };
    else if (c.eat("GENERATED")) { c.eat("ALWAYS"); c.eat("BY", "DEFAULT"); c.eat("AS"); col.default = c.eat("IDENTITY") ? "identity" : "generated"; }
    else if (c.any("AUTO_INCREMENT", "AUTOINCREMENT")) col.default = "auto increment";
    else if (c.eat("CONSTRAINT")) c.name();
    else if (c.eat("ON")) { c.skip(); if (c.eat("SET")) c.skip(); else if (!c.eat("NO", "ACTION")) c.skip(); } // ON DELETE SET NULL is no NULL of the column
    else if (c.W() === "(") { if (!c.group()) c.skip(); }
    else c.skip();
  }
  if (!col.default && /^(small|big)?serial\d?$/.test(col.type ?? "")) col.default = "sequence";
  if (col.ref && !col.ref.table) col.ref = null;
  return col;
}
const HEADS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE", "LIKE", "FULLTEXT", "SPATIAL", "KEY", "INDEX"]);
// A table's constraint (in CREATE TABLE or after ADD) → {kind: pk | unique | fk | index | check, cols, name, ref,
// refCols}; null when it is not read.
function constraintOf(toks) {
  const c = cursor(toks);
  let name = c.eat("CONSTRAINT") ? c.name() : null;
  if (c.eat("PRIMARY", "KEY")) { const cols = colNames(c.group()); return plain(cols) ? { kind: "pk", cols } : null; }
  if (c.eat("UNIQUE")) { c.any("KEY", "INDEX"); if (c.W() !== "(") name = c.name() ?? name; const cols = colNames(c.group()); return plain(cols) ? { kind: "unique", cols, name } : null; }
  if (c.eat("FOREIGN", "KEY")) {
    if (c.W() !== "(") c.name();
    const cols = colNames(c.group());
    if (!c.eat("REFERENCES")) return null;
    const ref = c.name(), refCols = colNames(c.group());
    return plain(cols) && ref && refCols.every(Boolean) ? { kind: "fk", cols, ref, refCols, name } : null;
  }
  if (c.eat("CHECK")) return { kind: "check" };
  if (c.any("KEY", "INDEX")) { if (c.W() !== "(") name = c.name(); const cols = colNames(c.group()); return plain(cols) ? { kind: "index", cols, name, unique: false } : null; }
  return null;
}
// One entry of CREATE TABLE's list or what follows ADD: a column, a constraint, or null (not read). A column may be
// called key or index (then what follows is a type, not a list of columns).
function entryOf(toks) {
  const w = cursor(toks).W(), k = HEADS.has(w) ? constraintOf(toks) : undefined;
  if (k === undefined || (k === null && (w === "KEY" || w === "INDEX"))) { const col = colDef(toks); return col ? { col } : null; }
  return k;
}
// Kinds of object a statement is named for as not read; the rest (schemas, extensions, roles, data) are no part of a table's shape.
const NOTED = new Set(["VIEW", "MATERIALIZED", "TYPE", "DOMAIN", "SEQUENCE", "TRIGGER"]);
/**
 * SQL → {ops: the steps in the order written, skipped: [{what, line}] statements about the schema that are not read,
 * marked, down (sqlStatements)}. A step: {op, table, line, end, …}:
 * create {cols, pk, uniques, fks, indexes, ifNotExists, vague: its columns are not all read, raw} · drop ·
 * renameTable {to} · addCol {col} · dropCol {name} · alterCol {name, set: {type, notNull, default}} ·
 * renameCol {name, to} · pk {cols} · unique {cols, name} · fk {cols, ref, refCols, name} ·
 * index {name, cols, unique, concurrently} · dropIndex {name} · dropConstraint {name} · vague {text}.
 */
export function readSql(text) {
  const { sts, marked, down } = sqlStatements(text), ops = [], skipped = [];
  for (const st of sts) {
    const c = cursor(st.toks), at = { line: st.line, end: st.end }, note = (verb) => { if (NOTED.has(c.W())) skipped.push({ what: `${verb} ${c.W()}${c.W() === "MATERIALIZED" ? " VIEW" : ""}`, line: st.line }); };
    if (c.eat("CREATE")) {
      let unique = false, temp = false;
      for (;;) { if (c.eat("OR", "REPLACE") || c.any("GLOBAL", "LOCAL", "UNLOGGED")) continue; if (c.any("TEMP", "TEMPORARY")) { temp = true; continue; } if (c.eat("UNIQUE")) { unique = true; continue; } break; }
      if (c.eat("TABLE")) { if (!temp) ops.push(...createTable(c, st)); }
      else if (c.eat("INDEX")) {
        const concurrently = c.eat("CONCURRENTLY"); c.eat("IF", "NOT", "EXISTS");
        const name = c.W() === "ON" ? null : c.name(), on = c.eat("ON"); c.eat("ONLY");
        const table = on ? c.name() : null; if (c.eat("USING")) c.skip();
        const g = c.group();
        if (table && g) ops.push({ op: "index", table, name, cols: colNames(g), unique, concurrently, ...at }); else skipped.push({ what: "CREATE INDEX", line: st.line });
      } else note("CREATE");
    } else if (c.eat("ALTER")) { if (c.eat("TABLE")) ops.push(...alterTable(c)); else note("ALTER"); }
    else if (c.eat("DROP")) {
      if (c.eat("TABLE")) { c.eat("IF", "EXISTS"); for (const it of splitTop(c.rest())) { const table = cursor(it).name(); if (table) ops.push({ op: "drop", table, ...at }); } }
      else if (c.eat("INDEX")) { c.eat("CONCURRENTLY"); c.eat("IF", "EXISTS"); for (const it of splitTop(c.rest())) { const a = cursor(it), name = a.name(); if (name) ops.push({ op: "dropIndex", name: name.slice(name.lastIndexOf(".") + 1), table: a.eat("ON") ? a.name() : null, ...at }); } }
      else note("DROP");
    } else if (c.eat("RENAME", "TABLE")) for (const it of splitTop(c.rest())) { const a = cursor(it), table = a.name(), to = a.eat("TO") ? a.name() : null; if (table && to) ops.push({ op: "renameTable", table, to, ...at }); }
    // Everything else (INSERT, UPDATE, SET, COMMENT ON, GRANT …) leaves the tables' shape as it is.
  }
  return { ops, skipped, marked, down };
}
function createTable(c, st) {
  const ifNotExists = c.eat("IF", "NOT", "EXISTS"), table = c.name(), g = table ? c.group() : null;
  if (!table) return [];
  const op = { op: "create", table, cols: [], pk: null, uniques: [], fks: [], indexes: [], ifNotExists, vague: !g, line: st.line, end: st.end }; // no list: AS SELECT, PARTITION OF, LIKE
  for (const item of splitTop(g ?? [])) {
    const e = entryOf(item), line = item[0].line;
    if (!e) op.vague = true;
    else if (e.col) op.cols.push(e.col);
    else if (e.kind === "pk") op.pk = e.cols;
    else if (e.kind === "unique") op.uniques.push({ cols: e.cols, name: e.name, line });
    else if (e.kind === "fk") op.fks.push({ cols: e.cols, ref: e.ref, refCols: e.refCols, name: e.name, line });
    else if (e.kind === "index") op.indexes.push({ cols: e.cols, name: e.name, unique: false, line });
  }
  if (op.vague) op.raw = glue(st.toks);
  return [op];
}
function alterTable(c) {
  c.eat("IF", "EXISTS"); c.eat("ONLY");
  const table = c.name(), ops = [];
  if (!table) return ops;
  if (c.W() === "*") c.skip();
  for (const act of splitTop(c.rest())) {
    const a = cursor(act), at = { table, line: act[0].line, end: act[act.length - 1].line }, vague = () => ops.push({ op: "vague", ...at, text: squash(act.slice(0, 4).map((x) => x.t).join(" ")).toLowerCase() });
    if (a.eat("ADD")) {
      a.eat("COLUMN"); a.eat("IF", "NOT", "EXISTS");
      const e = entryOf(a.rest());
      if (!e) vague(); else if (e.col) ops.push({ op: "addCol", ...at, col: e.col }); else if (e.kind !== "check") ops.push({ ...e, op: e.kind, ...at });
    } else if (a.eat("DROP")) {
      if (a.eat("CONSTRAINT") || a.eat("FOREIGN", "KEY")) { a.eat("IF", "EXISTS"); ops.push({ op: "dropConstraint", ...at, name: a.name() }); }
      else if (a.eat("PRIMARY", "KEY")) ops.push({ op: "pk", ...at, cols: [] });
      else if (a.any("INDEX", "KEY")) ops.push({ op: "dropIndex", ...at, name: a.name() });
      else { a.eat("COLUMN"); a.eat("IF", "EXISTS"); const name = a.name(); if (name) ops.push({ op: "dropCol", ...at, name }); else vague(); }
    } else if (a.eat("ALTER")) {
      a.eat("COLUMN");
      const name = a.name(), set = (s) => ops.push({ op: "alterCol", ...at, name, set: s });
      if (!name) vague();
      else if (a.eat("TYPE") || a.eat("SET", "DATA", "TYPE")) set({ type: upTo(a) || null });
      else if (a.eat("SET", "NOT", "NULL")) set({ notNull: true });
      else if (a.eat("DROP", "NOT", "NULL")) set({ notNull: false });
      else if (a.eat("SET", "DEFAULT")) set({ default: a.eat("NULL") ? null : upTo(a) || "set" });
      else if (a.eat("DROP", "DEFAULT")) set({ default: null });
      else vague();
    } else if (a.any("MODIFY", "CHANGE")) { // MySQL: the column's whole definition again; CHANGE has its old name first
      const change = act[0].t.toUpperCase() === "CHANGE"; a.eat("COLUMN");
      const old = change ? a.name() : null, col = colDef(a.rest());
      if (!col || (change && !old)) { vague(); continue; }
      if (change && old !== col.name) ops.push({ op: "renameCol", ...at, name: old, to: col.name });
      ops.push({ op: "alterCol", ...at, name: col.name, set: { type: col.type, notNull: col.notNull, default: col.default } });
    } else if (a.eat("RENAME")) {
      if (a.eat("TO")) { const to = a.name(); if (to) ops.push({ op: "renameTable", ...at, to }); else vague(); }
      else if (!a.any("CONSTRAINT", "INDEX", "KEY")) { a.eat("COLUMN"); const name = a.name(), to = a.eat("TO") ? a.name() : null; if (name && to) ops.push({ op: "renameCol", ...at, name, to }); else vague(); }
    } else if (!a.any("OWNER", "VALIDATE")) vague();
  }
  return ops;
}
const sqlDialect = (text) => (/\bENGINE\s*=|\bAUTO_INCREMENT\b|`/i.test(text) ? "mysql" : /\bAUTOINCREMENT\b|\bPRAGMA\b/i.test(text) ? "sqlite" : /\b(CONCURRENTLY|BIGSERIAL|SERIAL|JSONB|TIMESTAMPTZ)\b|::|\$\$/i.test(text) ? "postgresql" : null);

// ---- Alembic

const liner = (s) => { const nl = []; for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) nl.push(i); return (i) => { let a = 0, b = nl.length; while (a < b) { const m = (a + b) >> 1; if (nl[m] < i) a = m + 1; else b = m; } return a + 1; }; };
// Where the Python string that starts at i ends (after its closing quote); -1: it does not.
function pyStrEnd(s, i) {
  const q = s[i];
  if (s.startsWith(q.repeat(3), i)) { const e = s.indexOf(q.repeat(3), i + 3); return e < 0 ? -1 : e + 3; }
  for (let j = i + 1; j < s.length; j++) { if (s[j] === "\\") j++; else if (s[j] === q) return j + 1; else if (s[j] === "\n") return -1; }
  return -1;
}
// The call whose bracket is at i → {pos: [{text, at}], kw: {name: text}, end: its closing bracket}; null: it does not close.
function pyCall(s, i) {
  const pos = [], kw = {};
  let depth = 0, cur = "", at = -1;
  const put = () => { const t = cur.trim(), m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(t); if (m) kw[m[1]] = m[2]; else if (t) pos.push({ text: t, at }); cur = ""; at = -1; };
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "#") { const n = s.indexOf("\n", j); j = (n < 0 ? s.length : n) - 1; continue; }
    if (c === '"' || c === "'") { const e = pyStrEnd(s, j); if (e < 0) return null; if (at < 0) at = j; cur += s.slice(j, e); j = e - 1; continue; }
    if ("([{".includes(c)) { if (depth++ === 0) continue; }
    else if (")]}".includes(c)) { if (--depth === 0) { put(); return { pos, kw, end: j }; } }
    else if (c === "," && depth === 1) { put(); continue; }
    if (at < 0 && c.trim()) at = j;
    cur += c;
  }
  return null;
}
// A plain string literal's text; null for anything else (a name, an f-string, a call).
const pyStr = (x) => { const m = /^[rRuUbB]?(?:'''([\s\S]*)'''|"""([\s\S]*)"""|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")$/.exec(String(x ?? "").trim()); return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\\(['"\\])/g, "$1") : null; };
const pyList = (x) => { const t = String(x ?? "").trim(), r = /^[[(]/.test(t) ? pyCall(t, 0) : null, out = r?.pos.map((p) => pyStr(p.text)); return out?.length && out.every((v) => v !== null) ? out : null; };
const pyBool = (x) => (x === "True" ? true : x === "False" ? false : null);
const saCall = (text, names) => { const m = new RegExp(`^(?:\\w+\\.)*(${names})\\s*\\(`).exec(text), call = m ? pyCall(text, m[0].length - 1) : null; return call ? { name: m[1], ...call } : null; };
const saType = (x) => squash(x).replace(/^(?:\w+\.)+/, "").replace(/\b(?:length|precision|scale)\s*=\s*/g, "").replace(/\(\s*\)$/, "");
const saDefault = (x) => pyStr(x) ?? pyStr(/^(?:\w+\.)*text\s*\(([\s\S]*)\)$/.exec(x)?.[1]) ?? squash(x);
// "members.id" → the table and the column.
const saRef = (x) => (x?.includes(".") ? { table: x.slice(0, x.lastIndexOf(".")), col: x.slice(x.lastIndexOf(".") + 1) } : null);
// sa.Column('name', sa.String(50), sa.ForeignKey('members.id'), nullable=False) → a column as colDef's, with `index`.
function saColumn(text, line) {
  const call = saCall(String(text ?? ""), "Column"), name = call ? pyStr(call.pos[0]?.text) : null;
  if (!name) return null;
  const col = { name, type: null, notNull: false, default: null, pk: pyBool(call.kw.primary_key) === true, unique: pyBool(call.kw.unique) === true, ref: null, line, index: pyBool(call.kw.index) === true };
  for (const p of call.pos.slice(1)) {
    const fk = saCall(p.text, "ForeignKey"), ref = fk ? saRef(pyStr(fk.pos[0]?.text)) : null;
    if (fk) { if (ref) col.ref = { table: ref.table, cols: [ref.col] }; }
    else if (saCall(p.text, "Identity|Sequence|Computed")) col.default = "identity";
    else if (!col.type) col.type = saType(p.text);
  }
  col.notNull = col.pk || pyBool(call.kw.nullable) === false;
  if (call.kw.server_default && call.kw.server_default !== "None") col.default = saDefault(call.kw.server_default); // `default=` is the application's, not the database's
  return col;
}
const OP_QUIET = new Set(["bulk_insert", "get_bind", "get_context", "f", "inline_literal", "run_async", "create_table_comment", "drop_table_comment"]);
/**
 * An Alembic revision → {ops (readSql's steps), skipped, rev, downs: the revisions before it, emptyDown: downgrade()
 * does nothing}; null when the text is no revision. Only what upgrade() says through op.… (and through the name a
 * `with op.batch_alter_table(…) as name:` gives) with literal names is read.
 */
export function readAlembic(text) {
  const src = String(text ?? "");
  if (!/\bdown_revision\b/.test(src)) return null;
  // Comments are blanked, so a call that is commented out is not read; the places stay the same.
  let s = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { const e = pyStrEnd(src, i); if (e < 0) { s += src.slice(i); break; } s += src.slice(i, e); i = e - 1; }
    else if (c === "#") { let n = src.indexOf("\n", i); if (n < 0) n = src.length; s += " ".repeat(n - i); i = n - 1; }
    else s += c;
  }
  const lineAt = liner(s), ops = [], skipped = [], batch = new Map();
  const body = (fn) => { const m = new RegExp(`^def ${fn}\\s*\\([^)]*\\)[^:\\n]*:`, "m").exec(s); if (!m) return null; const from = m.index + m[0].length, next = /\n(?=\S)/.exec(s.slice(from)); return { from, to: next ? from + next.index : s.length }; };
  const up = body("upgrade"), dn = body("downgrade"), CALL = /(?<![\w.])(\w+)\.(\w+)\s*\(/g;
  const tname = (n, kw) => (pyStr(kw.schema) && n ? `${pyStr(kw.schema)}.${n}` : n);
  CALL.lastIndex = up?.from ?? s.length;
  for (let m; (m = CALL.exec(s)) && m.index < up.to;) {
    const [, recv, fn] = m;
    if (recv !== "op" && !batch.has(recv)) continue;
    const call = pyCall(s, CALL.lastIndex - 1), at = { line: lineAt(m.index), end: call ? lineAt(call.end) : 0 }, miss = (why = "with a name that is built in code") => skipped.push({ what: `op.${fn} ${why}`, line: at.line });
    if (!call) { miss("that does not close"); break; }
    CALL.lastIndex = call.end + 1;
    const kw = call.kw, own = { text: JSON.stringify(batch.get(recv) ?? ""), at: m.index };
    // A batch call has no table of its own: it goes where op.…'s has it.
    const pos = recv === "op" ? call.pos : /^(add_column|drop_column|alter_column)$/.test(fn) ? [own, ...call.pos] : [call.pos[0], own, ...call.pos.slice(1)];
    const arg = (k, name) => pos[k]?.text ?? kw[name] ?? null, str = (k, name) => pyStr(arg(k, name)), table = (k, name = "table_name") => tname(str(k, name), kw);
    if (fn === "batch_alter_table") { const t = table(0), as = /^\s*as\s+(\w+)/.exec(s.slice(call.end + 1)); if (t && as) batch.set(as[1], t); else miss(); }
    else if (fn === "create_table") {
      const op = { op: "create", table: table(0), cols: [], pk: null, uniques: [], fks: [], indexes: [], vague: false, ...at };
      if (!op.table) { miss(); continue; }
      for (const p of pos.slice(1)) {
        const col = saColumn(p.text, lineAt(p.at)), k = col ? null : saCall(p.text, "PrimaryKeyConstraint|UniqueConstraint|ForeignKeyConstraint|CheckConstraint"), names = k?.pos.map((x) => pyStr(x.text)) ?? [];
        if (col) { op.cols.push(col); if (col.index) op.indexes.push({ cols: [col.name], name: null, unique: false, line: col.line }); }
        else if (k?.name === "PrimaryKeyConstraint" && plain(names)) op.pk = names;
        else if (k?.name === "UniqueConstraint" && plain(names)) op.uniques.push({ cols: names, name: pyStr(k.kw.name), line: lineAt(p.at) });
        else if (k?.name === "ForeignKeyConstraint") { const cols = pyList(k.pos[0]?.text), refs = pyList(k.pos[1]?.text)?.map(saRef); if (cols && refs?.every(Boolean)) op.fks.push({ cols, ref: refs[0].table, refCols: refs.map((r) => r.col), name: pyStr(k.kw.name), line: lineAt(p.at) }); else op.vague = true; }
        else if (k?.name !== "CheckConstraint") op.vague = true;
      }
      if (op.vague) op.raw = squash(s.slice(m.index, call.end + 1));
      ops.push(op);
    }
    else if (fn === "drop_table") { if (table(0)) ops.push({ op: "drop", table: table(0), ...at }); else miss(); }
    else if (fn === "rename_table") { const t = table(0, "old_table_name"), to = tname(str(1, "new_table_name"), kw); if (t && to) ops.push({ op: "renameTable", table: t, to, ...at }); else miss(); }
    else if (fn === "add_column") {
      const t = table(0), col = saColumn(arg(1, "column"), at.line);
      if (!t || !col) { miss(); continue; }
      ops.push({ op: "addCol", table: t, col, ...at });
      if (col.index) ops.push({ op: "index", table: t, name: null, cols: [col.name], unique: false, concurrently: false, ...at });
    }
    else if (fn === "drop_column") { const t = table(0), name = str(1, "column_name"); if (t && name) ops.push({ op: "dropCol", table: t, name, ...at }); else miss(); }
    else if (fn === "alter_column") {
      const t = table(0), name = str(1, "column_name"), to = pyStr(kw.new_column_name), set = {}, nullable = pyBool(kw.nullable);
      if (!t || !name) { miss(); continue; }
      if (kw.type_) set.type = saType(kw.type_);
      if (nullable !== null) set.notNull = !nullable;
      if ("server_default" in kw) set.default = kw.server_default === "None" ? null : saDefault(kw.server_default);
      if (to) ops.push({ op: "renameCol", table: t, name, to, ...at });
      if (Object.keys(set).length) ops.push({ op: "alterCol", table: t, name: to ?? name, set, ...at });
    }
    else if (fn === "create_index") { const name = str(0, "index_name"), t = table(1), cols = pyList(arg(2, "columns")); if (t) ops.push({ op: "index", table: t, name, cols: cols ?? [null], unique: pyBool(kw.unique) === true, concurrently: pyBool(kw.postgresql_concurrently) === true, ...at }); else miss(); }
    else if (fn === "drop_index") { const name = str(0, "index_name"); if (name) ops.push({ op: "dropIndex", name, table: table(1), ...at }); else miss(); }
    else if (fn === "create_foreign_key") { const t = tname(str(1, "source_table"), { schema: kw.source_schema }), ref = tname(str(2, "referent_table"), { schema: kw.referent_schema }), cols = pyList(arg(3, "local_cols")), refCols = pyList(arg(4, "remote_cols"));
      if (t && ref && cols && refCols) ops.push({ op: "fk", table: t, cols, ref, refCols, name: str(0, "constraint_name"), ...at }); else miss(); }
    else if (fn === "create_unique_constraint" || fn === "create_primary_key") { const t = table(1), cols = pyList(arg(2, "columns")); if (t && cols) ops.push({ op: fn === "create_primary_key" ? "pk" : "unique", table: t, cols, name: str(0, "constraint_name"), ...at }); else miss(); }
    else if (fn === "drop_constraint") { const t = table(1), name = str(0, "constraint_name"); if (t && name) ops.push({ op: "dropConstraint", table: t, name, ...at }); else miss(); }
    else if (fn === "execute") {
      const sql = pyStr(pos[0]?.text) ?? pyStr(saCall(pos[0]?.text ?? "", "text")?.pos[0]?.text);
      if (sql === null) { miss("with a statement that is built in code"); continue; }
      const r = readSql(sql); // its places are the call's
      for (const o of r.ops) ops.push({ ...o, ...at, ...(o.col ? { col: { ...o.col, line: at.line } } : {}), ...(o.cols && o.op === "create" ? { cols: o.cols.map((c) => ({ ...c, line: at.line })) } : {}) });
      skipped.push(...r.skipped.map((x) => ({ ...x, line: at.line })));
    }
    else if (!OP_QUIET.has(fn)) skipped.push({ what: `op.${fn}`, line: at.line });
  }
  const downs = [...(/^down_revision\b[^=\n]*=\s*(.+)$/m.exec(s)?.[1] ?? "").matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  return { ops, skipped, rev: pyStr(/^revision\b[^=\n]*=\s*(.+)$/m.exec(s)?.[1]), downs,
    emptyDown: !dn || /^\s*(?:(?:'''[\s\S]*?'''|"""[\s\S]*?""")\s*)?(?:pass\s*)?$/.test(s.slice(dn.from, dn.to)) };
}

// ---- Prisma

// What follows "@name" in a field's or a model's attributes: the text in its brackets, "" without brackets, null when it is not there.
function prismaAttr(text, name) {
  const m = new RegExp(`@${name.replace(".", "\\.")}(?![\\w.])`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (text[i] !== "(") return "";
  for (let d = 0, j = i; j < text.length; j++) {
    if (text[j] === '"') { for (j++; j < text.length && text[j] !== '"'; j++) if (text[j] === "\\") j++; }
    else if (text[j] === "(") d++;
    else if (text[j] === ")" && --d === 0) return text.slice(i + 1, j);
  }
  return null;
}
const prismaList = (x) => (/\[([^\]]*)\]/.exec(x ?? "")?.[1] ?? "").split(",").map((p) => /^\s*(\w+)/.exec(p)?.[1]).filter(Boolean);
const prismaStr = (x) => /^\s*"((?:[^"\\]|\\.)*)"/.exec(x ?? "")?.[1] ?? null;
/**
 * A Prisma schema → {ops: one create step per model (with `links`: the tables an implicit many-to-many joins it to),
 * provider}. A model the reader does not understand line by line is created `vague`, with its text as `raw`.
 */
export function readPrisma(text) {
  const lines = String(text ?? "").split("\n"), models = [];
  let provider = null, block = null, cur = null;
  lines.forEach((raw, k) => {
    const l = raw.replace(/^((?:[^"/]|"(?:[^"\\]|\\.)*"|\/(?!\/))*)\/\/.*$/, "$1").trim(), line = k + 1;
    if (!block) { const m = /^(model|enum|datasource|generator|type|view)\s+(\w+)\s*\{/.exec(l); if (m && !l.endsWith("}")) { block = m[1]; cur = block === "model" ? { name: m[2], line, fields: [], attrs: [], bad: false, raw: [] } : null; } return; } // a block on one line is closed already
    if (l === "}") { if (cur) models.push({ ...cur, end: line }); block = cur = null; return; }
    if (block === "datasource") provider = /^provider\s*=\s*"(\w+)"/.exec(l)?.[1] ?? provider;
    if (!cur || !l) return;
    cur.raw.push(l);
    const m = l.startsWith("@@") ? null : /^(\w+)\s+((?:\w+\.)?\w+(?:\("[^"]*"\))?)(\[\])?(\?)?\s*((?:@.*)?)$/.exec(l); // after the type only attributes
    if (l.startsWith("@@")) cur.attrs.push(l); else if (m) cur.fields.push({ name: m[1], type: m[2], list: Boolean(m[3]), opt: Boolean(m[4]), attrs: m[5], line }); else cur.bad = true;
  });
  const by = new Map(models.map((m) => [m.name, m])), tableOf = (name) => prismaStr(by.get(name)?.attrs.map((a) => prismaAttr(a, "@map")).find((x) => x !== null)) ?? name;
  const colOf = (model, field) => prismaStr(prismaAttr(by.get(model)?.fields.find((f) => f.name === field)?.attrs ?? "", "map")) ?? field;
  const ops = models.map((m) => {
    const op = { op: "create", table: tableOf(m.name), cols: [], pk: null, uniques: [], fks: [], indexes: [], links: [], vague: m.bad, line: m.line, end: m.end };
    if (m.bad) op.raw = m.raw.join("\n");
    for (const f of m.fields) {
      const other = by.get(f.type), rel = prismaAttr(f.attrs, "relation");
      if (other) { // a relation, not a column: the side with `fields` holds the key
        const cols = prismaList(/fields\s*:\s*(\[[^\]]*\])/.exec(rel ?? "")?.[1]), refCols = prismaList(/references\s*:\s*(\[[^\]]*\])/.exec(rel ?? "")?.[1]);
        if (cols.length && refCols.length) op.fks.push({ cols: cols.map((c) => colOf(m.name, c)), ref: tableOf(f.type), refCols: refCols.map((c) => colOf(f.type, c)), name: null, line: f.line });
        else if (f.list && other.fields.some((o) => o.type === m.name && o.list && !/fields\s*:/.test(prismaAttr(o.attrs, "relation") ?? ""))) op.links.push(tableOf(f.type));
        continue;
      }
      const native = /@db\.(\w+(?:\([^)]*\))?)/.exec(f.attrs)?.[1], def = prismaAttr(f.attrs, "default");
      op.cols.push({ name: prismaStr(prismaAttr(f.attrs, "map")) ?? f.name, type: `${native ?? f.type}${f.list ? "[]" : ""}`, notNull: !f.opt, default: def === null ? null : def || "set",
        pk: prismaAttr(f.attrs, "id") !== null, unique: prismaAttr(f.attrs, "unique") !== null, ref: null, line: f.line });
    }
    for (const a of m.attrs) {
      const cols = (name) => prismaList(prismaAttr(a, name)).map((c) => colOf(m.name, c));
      if (prismaAttr(a, "@id") !== null) op.pk = cols("@id");
      else if (prismaAttr(a, "@unique") !== null) op.uniques.push({ cols: cols("@unique"), name: null, line: m.line });
      else if (prismaAttr(a, "@index") !== null) op.indexes.push({ cols: cols("@index"), name: null, unique: false, line: m.line });
    }
    return op;
  });
  return { ops, skipped: [], provider };
}

// ---- the tables of one side

const newTable = (name, src, op) => ({ name, was: null, cols: new Map(), pk: [], uniques: [], fks: [], indexes: [], links: [], file: src.file, line: op.line ?? 1, end: op.end ?? op.line ?? 1,
  stub: false, partial: false, fresh: false, raw: null, unread: [], places: [], first: null, gone: new Map() });
// One step on the tables so far. st: {tables: Map(name → table), owner: Map(index name → table), drops: Map(name →
// {file, line, end, fresh}), orphans: [text]}; src: {file, fresh: a file the PR adds (its steps are the change),
// inPatch}. A step on a table no file created makes a `stub`: only what the steps say about it is known.
function step(st, op, src) {
  const place = { file: src.file, line: op.line, end: op.end ?? op.line }, mark = (o) => ({ ...o, file: src.file, line: o.line ?? op.line, fresh: src.fresh });
  let T = st.tables.get(op.table);
  const addCol = (c) => {
    T.cols.set(c.name, { name: c.name, type: c.type, notNull: c.notNull || c.pk, default: c.default, was: null, how: "added", sets: {}, file: src.file, line: c.line ?? op.line, fresh: src.fresh });
    if (c.pk) T.pk = [...T.pk, c.name];
    if (c.unique) T.uniques.push(mark({ cols: [c.name], name: null, line: c.line }));
    if (c.ref) T.fks.push(mark({ cols: [c.name], ref: c.ref.table, refCols: c.ref.cols, name: null, line: c.line }));
  };
  if (op.op === "create") {
    if (T && op.ifNotExists) return;
    T = newTable(op.table, src, op); st.tables.set(op.table, T); st.drops.delete(op.table);
    T.partial = Boolean(op.vague); T.raw = op.raw ?? null; T.fresh = src.fresh;
    for (const c of op.cols) addCol(c);
    if (op.pk) { T.pk = op.pk; for (const c of op.pk) if (T.cols.has(c)) T.cols.get(c).notNull = true; }
    T.uniques.push(...op.uniques.map(mark)); T.fks.push(...op.fks.map(mark)); T.links = op.links ?? [];
    for (const x of op.indexes) { T.indexes.push(mark(x)); if (x.name) st.owner.set(x.name, T.name); }
  } else if (op.op === "drop") {
    st.drops.set(op.table, { ...place, fresh: src.fresh, inPatch: src.inPatch });
    if (!T) return;
    st.tables.delete(op.table);
    for (const o of st.tables.values()) o.fks = o.fks.filter((f) => f.ref !== op.table); // as CASCADE would; without it the database refuses
    return;
  } else if (op.op === "dropIndex") {
    const owner = st.tables.get(op.table ?? st.owner.get(op.name));
    if (owner) { owner.indexes = owner.indexes.filter((x) => x.name !== op.name); T = owner; }
    else { if (src.fresh) st.orphans.push({ ...place, text: `index ${op.name} is dropped, and no file that was read says which table it is on` }); return; }
  } else {
    if (!T) { T = newTable(op.table, src, op); T.stub = T.partial = true; st.tables.set(op.table, T); }
    const col = (name, how) => T.cols.get(name) ?? T.cols.set(name, { name, type: null, notNull: false, default: null, was: null, how, sets: {}, file: src.file, line: op.line, fresh: false }).get(name);
    const rename = (list, from, to) => list.map((c) => (c === from ? to : c));
    if (op.op === "addCol") addCol(op.col);
    else if (op.op === "dropCol") {
      const had = T.cols.get(op.name);
      if (src.fresh && !had?.fresh) T.gone.set(had?.was ?? op.name, place);
      T.cols.delete(op.name); T.pk = T.pk.filter((c) => c !== op.name);
      for (const k of ["uniques", "indexes", "fks"]) T[k] = T[k].filter((x) => !x.cols.includes(op.name));
    } else if (op.op === "alterCol") {
      const c = col(op.name, "altered");
      for (const [k, v] of Object.entries(op.set)) { c[k] = v; c.sets[k] = v; }
      if (src.inPatch) { c.file = src.file; c.line = op.line; }
    } else if (op.op === "renameCol") {
      const c = col(op.name, "renamed");
      T.cols.delete(op.name); T.cols.set(op.to, c);
      if (src.fresh && !c.fresh) c.was ??= op.name;
      c.name = op.to; if (src.inPatch) { c.file = src.file; c.line = op.line; }
      T.pk = rename(T.pk, op.name, op.to);
      for (const k of ["uniques", "indexes", "fks"]) for (const x of T[k]) x.cols = rename(x.cols, op.name, op.to);
      for (const o of st.tables.values()) for (const f of o.fks) if (f.ref === T.name) f.refCols = rename(f.refCols, op.name, op.to);
    } else if (op.op === "renameTable") {
      st.tables.delete(op.table); st.tables.set(op.to, T);
      if (src.fresh && !T.fresh) T.was ??= op.table; // a table this PR itself created has no earlier name
      T.name = op.to;
      for (const o of st.tables.values()) { for (const f of o.fks) if (f.ref === op.table) f.ref = op.to; o.links = rename(o.links, op.table, op.to); }
      for (const [k, v] of st.owner) if (v === op.table) st.owner.set(k, op.to);
    } else if (op.op === "pk") { T.pk = op.cols; for (const c of op.cols) if (T.cols.has(c)) T.cols.get(c).notNull = true; }
    else if (op.op === "unique") T.uniques.push(mark({ cols: op.cols, name: op.name ?? null }));
    else if (op.op === "fk") T.fks.push(mark({ cols: op.cols, ref: op.ref, refCols: op.refCols, name: op.name ?? null }));
    else if (op.op === "index") { T.indexes.push(mark({ cols: op.cols, name: op.name ?? null, unique: Boolean(op.unique), concurrently: op.concurrently })); if (op.name) st.owner.set(op.name, T.name); }
    else if (op.op === "dropConstraint") {
      const n = T.uniques.length + T.fks.length;
      T.uniques = T.uniques.filter((x) => x.name !== op.name); T.fks = T.fks.filter((x) => x.name !== op.name);
      if (n === T.uniques.length + T.fks.length) T.unread.push({ ...place, text: `drop constraint ${op.name}` }); // not one that was read by its name
    } else if (op.op === "vague") T.unread.push({ ...place, text: op.text });
  }
  if (src.inPatch) T.places.push(place);
  if (src.fresh) T.first ??= `${src.file}:${op.line}`;
}

// ---- the difference

// A default is never written out when its column's name looks like a secret, nor when it is long.
const SECRET = /pass(word|wd|phrase)|secret|token|key|credential|private/i;
const INT_RANK = { tinyint: 1, smallint: 2, int2: 2, smallinteger: 2, smallserial: 2, mediumint: 3, int: 4, integer: 4, int4: 4, serial: 4, bigint: 5, int8: 5, biginteger: 5, bigserial: 5 };
const FAMILY = (b) => (/^(varchar|character varying|nvarchar|varchar2|string)$/.test(b) ? "text(n)" : /^(numeric|decimal|number)$/.test(b) ? "number(n)" : b);
/** Whether type b surely holds less than type a: a small list of sure cases, everything else is false. */
export function narrower(a, b) {
  const read = (t) => { const m = /^([a-z_ ]+?)\s*(?:\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\))?$/.exec(String(t ?? "").trim().toLowerCase()); return m ? { base: m[1].trim(), n: m[2] ? Number(m[2]) : null, s: m[3] ? Number(m[3]) : null } : null; };
  const x = read(a), y = read(b);
  if (!x || !y) return false;
  if (INT_RANK[x.base] && INT_RANK[y.base]) return INT_RANK[y.base] < INT_RANK[x.base];
  if (FAMILY(x.base) === FAMILY(y.base) && y.n !== null) return x.n === null ? FAMILY(x.base) !== x.base : y.n < x.n || (x.s !== null && y.s !== null && y.s < x.s);
  if (/^(text|clob|longtext|mediumtext)$/.test(x.base)) return FAMILY(y.base) === "text(n)" || /^(char|character|nchar)$/.test(y.base);
  if (/^(timestamp|timestamptz|datetime)/.test(x.base)) return y.base === "date";
  return /^(double precision|float8|double)$/.test(x.base) && /^(real|float4)$/.test(y.base);
}
// own: unique by a constraint of its own (a unique index over it is a row of the card instead).
const flagsOf = (T, name) => ({ pk: T.pk.includes(name), unique: [...T.uniques, ...T.indexes.filter((x) => x.unique)].some((u) => u.cols.length === 1 && u.cols[0] === name), own: T.uniques.find((u) => u.cols.length === 1 && u.cols[0] === name) ?? null,
  fk: T.fks.find((f) => f.cols.includes(name)) ?? null, index: T.indexes.some((x) => x.cols.includes(name)) });
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const shown = (name, v) => (SECRET.test(name) || String(v).length > 30 ? null : v);
const defaultWords = (name, a, b) => { const x = a === null ? null : shown(name, a), y = b === null ? null : shown(name, b);
  return a === null ? `default ${y ?? "value"} added` : b === null ? "default removed" : x !== null && y !== null ? `default ${x} → ${y}` : "default changed"; };
const indexText = (x) => `${x.constraint ? "unique" : x.unique ? "unique index" : "index"}${x.name ? ` ${x.name}` : ""} (${x.cols.map((c) => c ?? "expression").join(", ")})`;

// The tables of one series before (B) and after (H) the PR → its cards and relations (schemaModel says which show).
function diffSeries(s, B, H) {
  const id = (name) => `${s.id}|${name}`, cards = [], ofBase = new Map(), twin = new Map();
  const backT = (n) => H.tables.get(n)?.was ?? n, backC = (t, c) => H.tables.get(t)?.cols.get(c)?.was ?? c;
  const fkKey = (f) => `${f.cols}>${f.ref}(${f.refCols})`, fkBack = (T, f) => `${f.cols.map((c) => backC(T.name, c))}>${backT(f.ref)}(${f.refCols.map((c) => backC(f.ref, c))})`;
  const all = (X) => [...X.uniques.map((u) => ({ ...u, unique: true, constraint: true })), ...X.indexes], ixKey = (x, back = (c) => c) => `${x.unique ? "u" : "i"}(${x.cols.map((c) => (c === null ? "?" : back(c)))})`;
  for (const T of H.tables.values()) {
    const b = B.tables.get(T.was ?? T.name) ?? null, cols = [], met = new Set();
    for (const h of T.cols.values()) {
      const o = b?.cols.get(h.was ?? h.name) ?? null, fl = flagsOf(T, h.name), col = { name: h.name, was: null, type: h.type, notNull: h.notNull, default: h.default, flags: fl, changes: [], narrowed: null, nowNotNull: false, nowUnique: false, at: `${h.file}:${h.line}`, status: "unchanged" };
      if (!o) { // no earlier column is known: added, or (a table only partly known) what the steps did to it
        col.status = h.how === "altered" ? "changed" : h.how === "renamed" ? "renamed" : "added"; col.was = h.was ?? null;
        if (col.status !== "added") { const z = h.sets; col.changes = ["type" in z && `type is now ${z.type ?? "not read"}`, z.notNull === true && "now not null", z.notNull === false && "no longer not null", "default" in z && (z.default === null ? "default removed" : `default ${shown(h.name, z.default) ?? "value"} set`)].filter(Boolean); col.nowNotNull = z.notNull === true; }
      } else {
        met.add(o.name);
        const ofl = flagsOf(b, o.name), ty = (x) => squash(x ?? "").toLowerCase();
        if (o.type && h.type && ty(o.type) !== ty(h.type)) { col.changes.push(`${o.type} → ${h.type}`); if (narrower(o.type, h.type)) col.narrowed = [o.type, h.type]; }
        else if (!o.type !== !h.type) col.changes.push(`type is now ${h.type ?? "not read"}`);
        if (o.notNull !== h.notNull) { col.changes.push(h.notNull ? "now not null" : "no longer not null"); col.nowNotNull = h.notNull; }
        if ((o.default ?? null) !== (h.default ?? null)) col.changes.push(defaultWords(h.name, o.default ?? null, h.default ?? null));
        if (ofl.pk !== fl.pk) col.changes.push(fl.pk ? "now in the primary key" : "no longer in the primary key");
        if (!ofl.own !== !fl.own) { col.changes.push(fl.own ? "now unique" : "no longer unique"); col.nowUnique = Boolean(fl.own); if (fl.own?.fresh) col.at = `${fl.own.file}:${fl.own.line}`; }
        col.was = o.name !== h.name ? o.name : null;
        col.status = col.was ? "renamed" : col.changes.length ? "changed" : "unchanged";
      }
      cols.push(col);
    }
    const where = T.first ?? `${T.file}:${T.line}`;
    for (const o of b?.cols.values() ?? []) if (!met.has(o.name)) { const g = T.gone.get(o.name); cols.push({ name: o.name, was: null, type: o.type, notNull: o.notNull, default: o.default, flags: flagsOf(b, o.name), changes: [], at: g ? `${g.file}:${g.line}` : where, status: "removed" }); }
    for (const [name, g] of T.gone) if (!b?.cols.has(name)) cols.push({ name, was: null, type: null, notNull: false, default: null, flags: {}, changes: [], at: `${g.file}:${g.line}`, status: "removed" });
    // Indexes and unique constraints over several columns (one over a single column is that column's mark).
    const left = b ? all(b) : [], keys = left.map((x) => ixKey(x)), idx = [], dropped = new Set(cols.filter((c) => c.status === "removed").map((c) => c.name));
    for (const x of all(T)) { const k = keys.indexOf(ixKey(x, (c) => backC(T.name, c))); if (k >= 0) { keys.splice(k, 1); left.splice(k, 1); } else idx.push({ ...x, status: "added", text: indexText(x), at: `${x.file}:${x.line}` }); }
    for (const x of left) if (!x.cols.some((c) => dropped.has(c))) idx.push({ ...x, status: "removed", text: indexText(x), at: where });
    const single = (x) => x.constraint && x.cols.length === 1;
    const bfk = new Set((b?.fks ?? []).map(fkKey)), fks = T.fks.map((f) => ({ ...f, isNew: !bfk.has(fkBack(T, f)) }));
    const hfk = new Set(T.fks.map((f) => fkBack(T, f))), lost = (b?.fks ?? []).filter((f) => !hfk.has(fkKey(f)));
    const covered = (f) => [T.pk, ...T.uniques.map((u) => u.cols), ...T.indexes.map((x) => x.cols)].some((list) => f.cols.every((c, k) => list[k] === c));
    const old = (b?.unread ?? []).map((u) => u.text), news = T.unread.filter((u) => { const k = old.indexOf(u.text); if (k >= 0) old.splice(k, 1); return k < 0; });
    const rawChanged = (T.raw ?? null) !== (b?.raw ?? null), links = T.links.filter((l) => !(b?.links ?? []).includes(backT(l))), unlinked = (b?.links ?? []).filter((l) => !T.links.some((x) => backT(x) === l));
    const touched = cols.some((c) => c.status !== "unchanged") || idx.length || fks.some((f) => f.isNew) || lost.length || news.length || rawChanged || links.length || unlinked.length;
    const status = !b ? (T.stub ? "changed" : "added") : T.was && T.was !== T.name ? "renamed" : touched ? "changed" : "unchanged";
    const two = T.fks.length === 2 && sameSet(T.pk, [...T.fks[0].cols, ...T.fks[1].cols]) ? [T.fks[0].ref, T.fks[1].ref] : null;
    const card = { id: id(T.name), group: s.id, name: T.name, was: status === "renamed" ? T.was : null, status, file: T.file, line: T.line, cols, idx: idx.filter((x) => !single(x)), partial: T.partial || Boolean(b?.partial), stub: T.stub && !b,
      unread: news.map((u) => ({ text: u.text, at: `${u.file}:${u.line}` })), rawChanged: rawChanged && Boolean(b), joins: two, places: T.places, size: T.cols.size,
      at: status === "added" ? `${T.file}:${T.line}` : T.first ?? cols.find((c) => c.status !== "unchanged")?.at ?? `${T.file}:${T.line}`,
      fks: fks.map((f) => ({ cols: f.cols, ref: f.ref, refCols: f.refCols, isNew: f.isNew, at: `${f.file}:${f.line}`, indexed: T.partial ? null : covered(f),
        one: T.partial ? null : f.cols.length === 1 ? flagsOf(T, f.cols[0]).unique || sameSet(T.pk, f.cols) : sameSet(T.pk, f.cols) || T.uniques.some((u) => sameSet(u.cols, f.cols)) })),
      lost: lost.map((f) => ({ cols: f.cols, ref: f.ref, refCols: f.refCols })), links, unlinked };
    cards.push(card); twin.set(T.name, card); if (b) ofBase.set(b.name, card);
  }
  const removed = (name, b, d) => { const card = { id: id(name), group: s.id, name, was: null, status: "removed", file: d?.file ?? b?.file, line: d?.line ?? b?.line ?? 1, cols: [], idx: [], partial: !b || b.partial, stub: false, unread: [], rawChanged: false, joins: null,
    places: d?.inPatch ? [{ file: d.file, line: d.line, end: d.end }] : [], size: b?.cols.size ?? 0, at: d ? `${d.file}:${d.line}` : b.file, fks: [], lost: (b?.fks ?? []).map((f) => ({ cols: f.cols, ref: f.ref, refCols: f.refCols })), links: [], unlinked: b?.links ?? [] };
    cards.push(card); ofBase.set(name, card); };
  for (const b of B.tables.values()) if (!ofBase.has(b.name)) removed(b.name, b, H.drops.get(b.name));
  for (const [name, d] of H.drops) if (d.fresh && !ofBase.has(name) && !H.tables.has(name)) removed(name, null, d);
  const edges = [], label = (cols, ...more) => [cols.join(", "), ...more].filter(Boolean).join(", ");
  for (const c of cards) {
    for (const f of c.fks) if (twin.has(f.ref) && f.ref !== c.name) edges.push({ from: c.id, to: twin.get(f.ref).id, cols: f.cols, refCols: f.refCols, how: f.one === null ? "" : f.one ? "1 to 1" : "n to 1", status: f.isNew ? "new" : "unchanged", at: f.at });
    for (const f of c.lost) if (ofBase.has(f.ref) && ofBase.get(f.ref) !== c) edges.push({ from: c.id, to: ofBase.get(f.ref).id, cols: f.cols, refCols: f.refCols, how: "", status: "removed", at: c.at });
    // An implicit many-to-many (Prisma keeps its join table itself): one line for both sides.
    for (const [list, by, status] of [[c.links, twin, "new"], [c.unlinked, ofBase, "removed"]]) for (const l of list) if (by.has(l) && c.name < l) edges.push({ from: c.id, to: by.get(l).id, cols: [], refCols: [], how: "n to m", status, at: c.at });
  }
  for (const T of H.tables.values()) for (const l of T.links) { const a = twin.get(T.name), b = twin.get(l); if (b && T.name < l && !edges.some((e) => e.from === a.id && e.to === b.id && e.how === "n to m")) edges.push({ from: a.id, to: b.id, cols: [], refCols: [], how: "n to m", status: "unchanged", at: a.at }); }
  for (const e of edges) e.label = label(e.cols, e.how, e.status === "new" ? "added" : e.status === "removed" ? "removed" : ""); // a relation's state is a word on its line
  return { cards, edges, orphans: H.orphans };
}

// ---- what may be risky: fixed rules over the difference, worded as "may"; nothing here is a finding of a review

const RISK_ORDER = ["table-dropped", "table-renamed", "column-removed", "column-renamed", "not-null", "narrowed", "unique", "index-blocks", "fk-no-index", "no-down"];
function risksOf(s, cards) {
  const out = [], add = (rule, card, text, at, on = {}) => out.push({ rule, card: card?.id ?? null, text, at, ...on });
  const deploy = "code that is still running during the deploy may";
  for (const c of cards) {
    if (c.status === "removed") { add("table-dropped", c, `Table ${c.name} is dropped: its rows are lost, and ${deploy} still query it.`, c.at, { table: true }); continue; }
    if (c.status === "renamed") add("table-renamed", c, `Table ${c.was} is renamed to ${c.name}: ${deploy} still use the old name.`, c.at, { table: true });
    const existed = c.status !== "added";
    for (const col of c.cols) {
      const on = { col: col.name }, name = `${c.name}.${col.name}`;
      if (col.status === "removed") add("column-removed", c, `Column ${name} is removed: ${deploy} still read or write it.`, col.at, on);
      if (col.status === "renamed" && col.was) add("column-renamed", c, `Column ${c.name}.${col.was} is renamed to ${col.name}: ${deploy} still use the old name.`, col.at, on);
      if (existed && col.status === "added" && col.notNull && col.default === null) add("not-null", c, `Column ${name} is added as NOT NULL without a default: this may fail when the table has rows.`, col.at, on);
      if (col.nowNotNull) add("not-null", c, `Column ${name} becomes NOT NULL: this may fail when rows hold NULL.`, col.at, on);
      if (col.narrowed) add("narrowed", c, `Column ${name} narrows from ${col.narrowed[0]} to ${col.narrowed[1]}: existing values may not fit.`, col.at, on);
      if (col.nowUnique) add("unique", c, `Column ${name} becomes unique: this may fail when existing rows hold duplicates.`, col.at, on);
    }
    const before = new Set(c.cols.filter((x) => x.status !== "added").map((x) => x.name));
    for (const x of c.idx) {
      if (x.status !== "added" || !existed) continue;
      if (x.unique && (c.partial || x.cols.some((n) => before.has(n)))) add("unique", c, `A new ${x.constraint ? "unique constraint" : "unique index"} on ${c.name} (${x.cols.map((n) => n ?? "expression").join(", ")}) may fail when existing rows hold duplicates.`, x.at, { idx: x.text });
      if (x.fresh && x.concurrently === false && !/mysql|sqlite|sqlserver/.test(s.dialect ?? "")) add("index-blocks", c, `${x.name ? `Index ${x.name}` : "An index"} on ${c.name} is created without CONCURRENTLY: on Postgres this may block writes to the table while it builds.`, x.at, { idx: x.text });
    }
    for (const f of c.fks) if (f.isNew && f.indexed === false && !/mysql/.test(s.dialect ?? "")) add("fk-no-index", c, `Foreign key ${c.name} (${f.cols.join(", ")}) has no index that starts with it: deleting from ${f.ref} and joining may scan ${c.name}.`, f.at, { col: f.cols[0] });
  }
  for (const e of s.entries.filter((x) => x.fresh)) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1), up = /^(.*)\.up\.sql$/i.exec(e.path);
    if (up && !s.entries.some((x) => x.path.toLowerCase() === `${up[1]}.down.sql`.toLowerCase())) add("no-down", null, `${name} has no .down.sql next to it: a rollback may not undo this migration.`, e.path);
    else if (s.kind === "SQL" && e.h?.marked && !e.h.down) add("no-down", null, `${name} has no down section: a rollback may not undo this migration.`, e.path);
    else if (s.kind === "Alembic" && e.h?.emptyDown && e.h.ops.length) add("no-down", null, `${name} has an empty downgrade: a rollback may not undo this migration.`, e.path);
  }
  return out;
}

// ---- the model

/**
 * files: the patch's schema files (schemaFiles) [{path, status, from, lines, head: the text at the PR head when it
 * was read}]; others: [{path, text}] the other files of their folders at the head (the migrations before the PR),
 * null while they are not read. → null when no reader found a change, else {groups: [{id, label, kind}], cards,
 * edges: [{from, to, cols, refCols, how: "n to 1" | "1 to 1" | "n to m" | "", label, status, at}], risks: [{rule,
 * card, text, at, col | idx | table}], notes: [text], unread: [{path, why, part}], counts, total}.
 * A card is a table that changed, or an unchanged one a relation connects to a changed one: {id, group, name, was,
 * status: added | changed | renamed | removed | unchanged, file, line, at, cols: [{name, was, type, notNull, default,
 * flags: {pk, unique, fk, index}, status, changes: [text], at}], idx: [{status, text, at}], partial: not all of its
 * columns are known, unread: [{text, at}], joins: [a, b] (a join table), fks, places, size}.
 */
export function schemaModel(files, others = null) {
  for (const g = schemaSteps(files, others); ;) { const r = g.next(); if (r.done) return r.value; }
}
/**
 * The same in steps: a generator that yields after every file read and every series compared, and returns the model.
 * A caller in the window runs it in slices (schema-view.js: Herdr stops a script slice after about 50 ms).
 */
export function* schemaSteps(files, others = null) {
  const series = new Map(), unread = [], notes = [], soft = [];
  const S = (id, label, kind) => series.get(id) ?? series.set(id, { id, label, kind, entries: [], dialect: null }).get(id);
  const of = (kind, path) => (kind === "prisma" ? S(`prisma:${path}`, path, "Prisma") : kind === "alembic" ? S(`alembic:${dirOf(path)}`, dirOf(path) || "Repository root", "Alembic") : S(`sql:${seriesOf(path)}`, seriesOf(path) || "Repository root", "SQL"));
  for (const f of files ?? []) {
    const kind = kindOf(f), sides = kind ? sidesOf(f) : null, sure = kind !== "sql" || (f.lines ?? []).some((l) => /^[+-].*\b(CREATE|ALTER|DROP)\s+(TABLE|(UNIQUE\s+)?INDEX)\b/i.test(l));
    if (!kind) { const why = noReader(f); if (why) soft.push({ path: f.path, why }); continue; }
    if (!sides) { if (sure) unread.push({ path: f.path, why: typeof f.head === "string" ? "the patch does not fit the file at the PR head" : "the file at the PR head is not loaded" }); continue; }
    if ((sides.head?.length ?? 0) > MAX_BYTES || (sides.base?.length ?? 0) > MAX_BYTES) { if (sure) unread.push({ path: f.path, why: "it is too large to read here" }); continue; }
    of(kind, f.path).entries.push({ path: f.path, base: sides.base, head: sides.head, fresh: f.status === "added", inPatch: true });
  }
  const own = new Set((files ?? []).flatMap((f) => [f.path, f.from]));
  for (const o of others ?? []) {
    const kind = /\.sql$/i.test(o.path) ? "sql" : /\.py$/.test(o.path) ? "alembic" : null, s = kind && series.get(kind === "sql" ? `sql:${seriesOf(o.path)}` : `alembic:${dirOf(o.path)}`);
    if (s && !own.has(o.path) && typeof o.text === "string" && o.text.length <= MAX_BYTES) s.entries.push({ path: o.path, base: o.text, head: o.text, fresh: false, inPatch: false });
  }
  // A Prisma schema and the SQL that Prisma wrote from it say the same thing: the schema is drawn.
  for (const s of [...series.values()]) if (s.kind === "Prisma" && series.delete(`sql:${dirOf(s.label) ? `${dirOf(s.label)}/` : ""}migrations`)) notes.push(`${dirOf(s.label) ? `${dirOf(s.label)}/` : ""}migrations is not drawn: ${s.label} describes the same change.`);
  const cards = [], edges = [], risks = [], groups = [];
  for (const s of [...series.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const reader = s.kind === "Prisma" ? readPrisma : s.kind === "Alembic" ? readAlembic : readSql;
    for (const e of s.entries) { e.b = e.base === null ? null : reader(e.base); e.h = e.head === e.base ? e.b : e.head === null ? null : reader(e.head); yield; }
    s.entries = s.entries.filter((e) => e.b || e.h); // a .py file that is no revision
    const texts = s.entries.map((e) => e.head ?? e.base);
    s.dialect = s.kind === "Prisma" ? s.entries[0]?.h?.provider ?? s.entries[0]?.b?.provider ?? null : s.kind === "SQL" ? ["mysql", "sqlite", "postgresql"].find((d) => texts.some((t) => sqlDialect(t) === d)) ?? null : texts.some((t) => /postgresql/.test(t)) ? "postgresql" : null;
    if (s.kind === "Alembic") { // the revisions' own order
      const by = new Map(s.entries.map((e) => [(e.h ?? e.b).rev, e])), depth = (e, seen = new Set()) => e.depth ?? (seen.has(e) ? 0 : (seen.add(e), (e.depth = 1 + Math.max(-1, ...(e.h ?? e.b).downs.map((r) => by.get(r)).filter(Boolean).map((p) => depth(p, seen))))));
      s.entries.sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
    } else s.entries.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
    // A way back (golang-migrate's .down.sql, Flyway's U…) is no step forward.
    const forward = (e) => s.kind !== "SQL" || !(/\.down\.sql$/i.test(e.path) || /(^|\/)U[\d._]+__[^/]*$/.test(e.path));
    const run = (side) => { const st = { tables: new Map(), owner: new Map(), drops: new Map(), orphans: [] }; for (const e of s.entries) if (e[side] && forward(e)) for (const op of e[side].ops) step(st, op, { file: e.path, fresh: e.fresh && side === "h", inPatch: e.inPatch && side === "h" }); return st; };
    const d = diffSeries(s, run("b"), run("h"));
    const live = new Set(d.cards.filter((c) => c.status !== "unchanged").map((c) => c.id)), near = new Set(d.edges.filter((e) => live.has(e.from) || live.has(e.to)).flatMap((e) => [e.from, e.to]));
    const mine = d.cards.filter((c) => live.has(c.id) || near.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)), on = new Set(mine.map((c) => c.id));
    for (const e of s.entries.filter((x) => x.inPatch && x.h?.skipped.length && forward(x))) { const kinds = [...new Set(e.h.skipped.map((x) => x.what))]; soft.push({ path: e.path, part: true, why: `${e.h.skipped.length} ${e.h.skipped.length === 1 ? "statement is" : "statements are"} not read (${kinds.slice(0, 4).join(", ")}${kinds.length > 4 ? ", …" : ""})` }); }
    for (const o of d.orphans) soft.push({ path: o.file, part: true, why: o.text });
    const found = risksOf(s, d.cards.filter((c) => live.has(c.id)));
    if (!mine.length && !found.length) continue;
    if (mine.some((c) => c.stub) && others === null && s.kind !== "Prisma") notes.push(`The earlier migrations of ${s.label} are not loaded yet, so a table shows only what this PR changes.`);
    cards.push(...mine); edges.push(...d.edges.filter((e) => on.has(e.from) && on.has(e.to))); risks.push(...found);
    if (mine.length) groups.push({ id: s.id, label: s.label, kind: s.kind });
    yield;
  }
  if (!cards.length && !risks.length && !unread.length) return null;
  risks.sort((a, b) => RISK_ORDER.indexOf(a.rule) - RISK_ORDER.indexOf(b.rule));
  const counts = Object.fromEntries(["added", "changed", "renamed", "removed"].map((k) => [k, cards.filter((c) => c.status === k).length]));
  return { groups, cards, edges, risks, notes, unread: [...unread, ...soft], counts, total: cards.filter((c) => c.status !== "unchanged").length };
}

// ---- words: the same on the page and in the Markdown

export const SCHEMA_SOURCE = "Derived from the migration and model files in the diff; the database was not asked.";
export const SCHEMA_MARKS = [["PK", "primary key"], ["FK", "foreign key"], ["UQ", "unique"], ["NN", "not null"], ["IX", "index"], ["DF", "default"]];
export const SCHEMA_STATES = [["added", "+"], ["changed", "~"], ["renamed", "→"], ["removed", "−"]]; // a state's sign, next to its word
export function schemaSummary(model) {
  const n = model.total, rest = model.cards.length - n, parts = Object.entries(model.counts).filter(([, k]) => k).map(([k, c]) => `${c} ${k}`);
  return [n ? `${n} ${n === 1 ? "table" : "tables"}: ${parts.join(", ")}.` : "No table itself changes.", rest ? `${rest} unchanged ${rest === 1 ? "one is" : "ones are"} related to what changed.` : ""].filter(Boolean).join(" ");
}
const marksOf = (c) => [c.flags.pk && "PK", c.flags.fk && "FK", c.flags.unique && "UQ", c.notNull && !c.flags.pk && "NN", c.flags.index && "IX", c.default !== null && c.default !== undefined && "DF"].filter(Boolean);
const markWords = (c) => marksOf(c).map((m) => SCHEMA_MARKS.find(([k]) => k === m)[1]);
/** A changed column in words: "varchar(200) → varchar(80), now not null" (with its earlier name first when it was renamed). */
export const colDetail = (c) => [c.was && `was ${c.was}`, ...c.changes].filter(Boolean).join(", ");
/**
 * A card's rows under its head, 18 px each: {kind: "head" (a state's word over its rows) | "col" | "idx" | "note",
 * state, sign, name, type, marks: [PK …], text: what the row says in one line, tip, at, risk: the texts of the risk
 * rules that hold here}. A changed table lists what changed by state and folds the rest; an added one lists its
 * columns; a removed or unchanged one says how many it has. More than `max` rows end in "and n more".
 */
export function cardRows(c, risks = [], max = SCHEMA_ROWS) {
  const mine = risks.filter((r) => r.card === c.id), riskAt = (k, v) => mine.filter((r) => r[k] === v).map((r) => r.text), rows = [], note = (text, more = {}) => rows.push({ kind: "note", text, ...more });
  const colRow = (x, state) => ({ kind: "col", state, sign: state ? SCHEMA_STATES.find(([k]) => k === state)[1] : "", name: x.name, type: x.type ?? "", marks: marksOf(x), at: x.at, risk: riskAt("col", x.name),
    text: state === "changed" || state === "renamed" ? colDetail(x) : "", tip: [`${x.name}${x.type ? ` ${x.type}` : ""}${markWords(x).length ? `: ${markWords(x).join(", ")}` : ""}`, x.flags.fk ? `references ${x.flags.fk.ref}${x.flags.fk.refCols.length ? ` (${x.flags.fk.refCols.join(", ")})` : ""}` : "", colDetail(x)].filter(Boolean).join("\n") });
  const table = riskAt("table", true);
  if (c.status === "removed") note(c.partial ? "Dropped; its columns are not read" : `Dropped with its ${c.size} ${c.size === 1 ? "column" : "columns"}`, { risk: table, at: c.at });
  if (c.was) note(`Renamed from ${c.was}`, { risk: table, at: c.at });
  if (c.joins) note(`Joins ${c.joins[0]} and ${c.joins[1]}, n to m`);
  for (const u of c.unread) note(`Changed, details not read: ${u.text}`, { at: u.at });
  if (c.rawChanged) note("Changed; its definition is not read in detail", { at: c.at });
  if (c.status === "added") rows.push(...c.cols.map((x) => colRow(x, null)), ...c.idx.map((x) => ({ kind: "idx", state: null, sign: "", text: x.text, at: x.at, risk: riskAt("idx", x.text) })));
  else if (c.status !== "removed" && c.status !== "unchanged") {
    for (const [state] of SCHEMA_STATES) {
      const list = [...c.cols.filter((x) => x.status === state).map((x) => colRow(x, state)), ...c.idx.filter((x) => x.status === state).map((x) => ({ kind: "idx", state, sign: SCHEMA_STATES.find(([k]) => k === state)[1], text: x.text, at: x.at, risk: riskAt("idx", x.text) }))];
      if (list.length) rows.push({ kind: "head", state, text: state }, ...list);
    }
  }
  const same = c.cols.filter((x) => x.status === "unchanged").length;
  if (c.status === "unchanged") { rows.push(...c.cols.filter((x) => x.flags.pk || x.flags.fk).map((x) => colRow(x, null))); const k = c.cols.filter((x) => !x.flags.pk && !x.flags.fk).length; if (k) note(`+ ${k} more`); }
  else if (c.partial && c.status !== "removed") note(c.stub ? "Its other columns are not read" : "Not all of its columns are read");
  else if (same && c.status !== "added") note(`+ ${same} unchanged`);
  return rows.length > max ? [...rows.slice(0, max - 1), { kind: "note", text: `and ${rows.length - max + 1} more` }] : rows;
}
export const foldText = (f) => `Over ${SCHEMA_MAX} tables: ${f.cards} tables of ${f.areas} ${f.areas === 1 ? "area" : "areas"} are one card per area.`;
export const unreadText = (u) => (u.part ? `${u.path} is only partly in the picture: ${u.why}.` : `${u.path} is not in the picture: ${u.why}.`);
/** A relation in one line: "loans (member_id) → members (id), n to 1, added". */
export const edgeText = (e, nameOf) => `${nameOf(e.from)}${e.cols.length ? ` (${e.cols.join(", ")})` : ""} → ${nameOf(e.to)}${e.refCols.length ? ` (${e.refCols.join(", ")})` : ""}${e.how ? `, ${e.how}` : ""}${e.status === "new" ? ", added" : e.status === "removed" ? ", removed" : ""}`;

// ---- the picture

const STATUS = { added: "new", renamed: "changed" }; // as arch.js names a card's state
// The area a table belongs to when a big schema is folded: its schema, else its name up to the first underscore.
const areaOf = (name) => (name.includes(".") ? name.slice(0, name.indexOf(".")) : name.includes("_") ? name.slice(0, name.indexOf("_")) : name);
/**
 * The model as arch.js archLayout reads it: {groups, nodes, edges, alias: Map(card id → the card that stands for it),
 * folded: {areas, cards} or null}. Over `max` cards, the tables of one area in a series are one card.
 */
export function schemaArch(model, max = SCHEMA_MAX) {
  const alias = new Map(), nodes = [];
  let folded = null;
  const node = (c) => ({ id: c.id, label: c.name, description: c.at.slice(c.at.lastIndexOf("/") + 1), group: c.group, type: "data", at: c.at, status: STATUS[c.status] ?? c.status, source: c.status === "unchanged" ? "existing" : undefined, rows: cardRows(c, model.risks) });
  if (model.cards.length > max) {
    const by = new Map();
    for (const c of model.cards) { const k = `${c.group}|${areaOf(c.name)}`; by.set(k, [...(by.get(k) ?? []), c]); }
    for (const [key, list] of by) {
      if (list.length < 2) { nodes.push(node(list[0])); continue; }
      const st = [...new Set(list.map((c) => c.status))], live = list.filter((c) => c.status !== "unchanged"), sums = ["added", "changed", "renamed", "removed", "unchanged"].map((k) => [k, list.filter((c) => c.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
      for (const c of list) alias.set(c.id, `fold:${key}`);
      folded = { areas: (folded?.areas ?? 0) + 1, cards: (folded?.cards ?? 0) + list.length };
      const rows = live.map((c) => ({ kind: "col", state: c.status, sign: SCHEMA_STATES.find(([k]) => k === c.status)[1], name: c.name, type: c.status, marks: [], text: "", tip: `${c.name}: ${c.status}`, at: c.at, risk: model.risks.filter((r) => r.card === c.id).map((r) => r.text) }));
      nodes.push({ id: `fold:${key}`, label: `${areaOf(list[0].name)}: ${list.length} tables`, description: sums, group: list[0].group, type: "data", at: (live[0] ?? list[0]).at, status: st.length === 1 ? STATUS[st[0]] ?? st[0] : live.length ? "changed" : "unchanged",
        source: live.length ? undefined : "existing", rows: rows.length > SCHEMA_ROWS ? [...rows.slice(0, SCHEMA_ROWS - 1), { kind: "note", text: `and ${rows.length - SCHEMA_ROWS + 1} more` }] : rows });
    }
  } else nodes.push(...model.cards.map(node));
  const seen = new Set(), edges = [];
  for (const e of model.edges) { const from = alias.get(e.from) ?? e.from, to = alias.get(e.to) ?? e.to, k = `${from}>${to}`; if (from === to || seen.has(k)) continue; seen.add(k); edges.push({ ...e, from, to, label: alias.has(e.from) || alias.has(e.to) ? "" : e.label, evidence: e.at }); }
  return { groups: model.groups, nodes, edges, alias, folded };
}
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }, sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
/** The review's findings whose line lies in a statement or a model that is about a table, as arch.js archMarks gives them. */
export function schemaMarks(model, findings, alias = new Map()) {
  const nodes = new Map();
  for (const f of findings ?? []) {
    const c = f.file ? model.cards.find((x) => x.places.some((p) => sameFile(p.file, f.file) && f.line >= p.line && f.line <= p.end)) : null;
    if (!c) continue;
    const k = alias.get(c.id) ?? c.id, m = nodes.get(k) ?? { findings: [], n: 0, breaks: 0, severity: f.severity };
    m.findings.push(f); m.n++;
    if ((RANK[f.severity] ?? 9) < (RANK[m.severity] ?? 9)) m.severity = f.severity;
    nodes.set(k, m);
  }
  return { nodes, edges: new Map() };
}
/**
 * → {arch, marks, args, L}: one layout with a row per row of a card and the room its finding mark takes. args: what
 * the layout got, for the search for a better one after the frame (stack.js laidOut). L is what a frame can afford
 * (arch.js archQuick); lay: false leaves it to the caller (the review lays a big picture out after the frame).
 */
export function schemaPicture(model, findings = [], fit = false, lay = true) {
  const arch = schemaArch(model), marks = schemaMarks(model, findings, arch.alias), w = (fit ? FIT : ARCH).W - 20;
  const args = [arch, "diff", (n) => (n.rows ?? []).length + (marks.nodes.has(n.id) ? markRoom(marks.nodes.get(n.id), w).rows : 0), fit, { labels: true }];
  return { arch, marks, args, ...(lay ? { L: archQuick(...args) } : {}) };
}

// ---- Copy as Markdown: the section's lines. table(head, rows) is markdown.js's own, handed in so this file stays below it.

// A text from the PR in the copied Markdown: one line, as a code span. Pasted into GitHub, a code span is inert: no
// mention notifies anyone, no image is fetched, no heading or fence starts, whatever a name or a value in the PR says.
const mdCode = (x) => { const s = squash(x ?? "").replace(/`/g, "'"); return s ? `\`${s}\`` : ""; };
// … and inside the Mermaid block: one line, no backtick (a fence would end the block) and no double quote.
const mmText = (x) => squash(x ?? "").replace(/[`"]/g, "'");
const erWord = (x, fallback) => String(x ?? "").replace(/[^A-Za-z0-9_()[\]-]+/g, "_").replace(/^[^A-Za-z_]+/, "") || fallback;
const erName = (x) => String(x).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z_]+/, "") || "table";
/** The tables as a Mermaid erDiagram: a table's and a column's state is a comment, as erDiagram has no classes. */
export function schemaMermaid(model) {
  const name = new Map(model.cards.map((c) => [c.id, erName(c.name)])), out = ["erDiagram"];
  for (const c of model.cards) {
    const cols = c.cols.filter((x) => c.status === "added" || x.status !== "unchanged" || x.flags.pk || x.flags.fk), rest = c.cols.length - cols.length;
    out.push(`  %% ${mmText(c.name)}: ${c.status}${c.was ? `, renamed from ${mmText(c.was)}` : ""}${rest > 0 ? `, ${rest} unchanged columns left out` : ""}`);
    if (!cols.length) { out.push(`  ${name.get(c.id)}`); continue; }
    out.push(`  ${name.get(c.id)} {`);
    for (const x of cols) { const keys = [x.flags.pk && "PK", x.flags.fk && "FK", x.flags.unique && "UK"].filter(Boolean).join(", "), say = c.status === "added" || x.status === "unchanged" ? "" : mmText([x.status, colDetail(x)].filter(Boolean).join(": "));
      out.push(`    ${erWord(x.type, "unknown")} ${erWord(x.name, "column")}${keys ? ` ${keys}` : ""}${say ? ` "${say}"` : ""}`); }
    out.push("  }");
  }
  for (const e of model.edges) out.push(`  ${name.get(e.from)} ${e.how === "n to m" ? "}o" : e.how === "1 to 1" ? "|o" : "}o"}${e.status === "removed" ? ".." : "--"}${e.how === "n to m" ? "o{" : "||"} ${name.get(e.to)} : "${mmText(e.label)}"`);
  return out;
}
export function schemaMd(model, { table, findings = [], h = "##" } = {}) {
  if (!model) return [];
  const arch = schemaArch(model), own = schemaMarks(model, findings).nodes, name = new Map(model.cards.map((c) => [c.id, c.name])), found = (c) => { const m = own.get(c.id); return m ? `${m.severity}: ${m.findings.map((f) => squash(f.title)).join("; ")}` : ""; };
  // Every row a card can show, in full: its state, the column with its type and marks, what changed, the place.
  const rowsOf = (c) => cardRows(c, model.risks, Infinity).filter((r) => r.kind !== "head").map((r) => [mdCode(c.name), c.status, mdCode(r.kind === "col" ? [r.name, r.type, ...r.marks.map((m) => SCHEMA_MARKS.find(([k]) => k === m)[1])].filter(Boolean).join(" ") : ""),
    mdCode(r.kind === "col" ? [r.state, r.text].filter(Boolean).join(": ") : [r.state, r.text].filter(Boolean).join(" ")), r.risk?.length ? "may be risky" : "", mdCode(r.at)]);
  return [`${h} Schema changes (${model.total})`, "", SCHEMA_SOURCE, "",
    ...(model.cards.length ? [`${schemaSummary(model)}${arch.folded ? ` ${foldText(arch.folded)}` : ""} A table's and a column's state is a comment in the diagram; a line points from a foreign key to the table it references.`, "", "```mermaid", ...schemaMermaid(model), "```", "",
      ...table(["Table", "State", "Column", "Change", "Risk", "Where"], model.cards.flatMap(rowsOf)),
      ...(model.cards.some(found) ? [...table(["Table", "Unresolved findings"], model.cards.filter(found).map((c) => [mdCode(c.name), found(c)]))] : []),
      ...(model.edges.length ? [`${h}# Relations (${model.edges.length})`, "", ...model.edges.map((e) => `- ${mdCode(edgeText(e, (id) => name.get(id)))} (${mdCode(e.at)})`), ""] : [])] : []),
    ...(model.notes.length ? [...model.notes.map((n) => `- ${mdCode(n)}`), ""] : []),
    ...(model.unread.length ? [...model.unread.map((u) => `- ${mdCode(unreadText(u))}`), ""] : []),
    ...(model.risks.length ? [`${h}# May be risky for live data (${model.risks.length})`, "", "From fixed rules over the changes above, not from a review.", "", ...model.risks.map((r) => `- ${mdCode(r.text)} (${mdCode(r.at)})`), ""] : [])];
}
