// "Infrastructure changes" on the Architecture page: which resources a PR adds, changes, removes or may replace, and
// what depends on them. Static and pure: no model, no terraform or cloudformation call, no network. The files at the
// PR head and the PR's own patch (a file before the PR is its head with the patch applied backwards) → the resources
// of both sides → their difference → cards and edges → arch.js archLayout, drawn by stack.js archView.
// Two small readers, neither a full parser. What a reader does not understand is "changed" without details or is
// named as not read, never guessed:
// - Terraform (.tf, .tfvars): block heads, bracket depth with strings, templates, heredocs and comments, the arguments
//   and nested blocks of a block's top level as text, references by pattern in code (not in what a string says).
//   One folder is one module: its unchanged files are read too (review.js loadInfra), so a resource in a file the PR
//   does not touch that refers to a changed or removed one shows.
// - CloudFormation and SAM (YAML by indentation under its top-level keys, or JSON): Resources with Type and the top
//   level of Properties, references by !Ref, !GetAtt, ${…} and DependsOn. No anchors, flow mappings or tabs.
import { archQuick, markRoom, ARCH, FIT } from "./arch.js";

export const INFRA_LINES = 4; // changed arguments on a card
// More changed resources or more references than this, and lines between the cards stop answering anything: the
// section is then a list of cards by file (infraDense), what stands out first, a card's references on demand.
export const INFRA_DENSE = { cards: 12, edges: 15, perFile: 48 };
const NOTE_CH = 36; // the characters of a card's line in one row
const TF = /\.tf$/, TFVARS = /\.tfvars$/, CFN = /\.(ya?ml|json|template)$/;
export const isIac = (path) => TF.test(path) || TFVARS.test(path) || CFN.test(path);
// Whether a file of the patch ({path, lines, head?}) is one this picture reads: Terraform by its name; YAML or JSON
// only when it is a template. Any YAML or JSON may be one: only one that names Resources is read. Without its text
// at the head, its patch or its name (template.yaml, …stack….json) has to say so.
export function isInfraFile(f) {
  if (TF.test(f.path) || TFVARS.test(f.path)) return true;
  const named = /(^|\/)(template|[^/]*(stack|cloudformation|cfn|sam)[^/]*)\.(ya?ml|json)$|\.template$/i.test(f.path);
  return CFN.test(f.path) && ((f.lines ?? []).some((l) => /Resources|AWS::/.test(l)) || (typeof f.head === "string" ? f.head.includes("Resources") : named));
}
export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const squash = (x) => String(x).replace(/\s+/g, " ").trim(), unq = (x) => String(x).replace(/^(["'])(.*)\1$/, "$2");

// ---- the two sides of a changed file

const patchSide = (lines, sign) => { const out = []; let body = false; for (const l of lines) { if (l.startsWith("@@")) body = true; else if (body && (l[0] === sign || l[0] === " ")) out.push(l.slice(1)); } return out.join("\n"); };
// The file before the PR: its text at the head with the patch (pr.js splitPatch's lines) applied backwards. null when
// the patch does not fit this text (another head).
export function baseText(head, lines) {
  const src = head.split("\n"), out = [];
  let at = 0, body = false;
  for (const l of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) { const to = Number(m[1]) - (m[2] === "0" ? 0 : 1); if (to < at || to > src.length) return null; for (; at < to; at++) out.push(src[at]); body = true; continue; } // a loop: a file's lines as arguments of one call overflow the stack
    if (!body || l[0] === "\\") continue;
    if (l[0] === "-") { out.push(l.slice(1)); continue; }
    if (src[at] !== l.slice(1)) return null;
    if (l[0] === " ") out.push(src[at]);
    at++;
  }
  return [...out, ...src.slice(at)].join("\n");
}
// f: a file of the patch with `head`, its text at the PR head when it was read → {head, base} (null: no file on that
// side), or null when the head is needed and missing or the patch does not fit it.
// ponytail: a patch GitHub cut (no hunks for a huge file) reads as "nothing changed in this file".
export function sidesOf(f) {
  if (f.status === "added") return { head: f.head ?? patchSide(f.lines, "+"), base: null };
  if (f.status === "deleted") return { head: null, base: patchSide(f.lines, "-") };
  const base = typeof f.head === "string" ? baseText(f.head, f.lines) : null;
  return base === null ? null : { head: f.head, base };
}

// ---- Terraform

const liner = (s) => { const nl = []; for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) nl.push(i); return (i) => { let a = 0, b = nl.length; while (a < b) { const m = (a + b) >> 1; if (nl[m] < i) a = m + 1; else b = m; } return a + 1; }; };
// A file of the PR may be written to break the reader, so nothing in it follows the file's own depth or size without
// a limit: strings in templates in strings and blocks in blocks are followed DEEP levels down (real code has a
// handful; deeper reads as "not understood"), and a file over MAX_BYTES is named as not read.
const DEEP = 40, MAX_BYTES = 2000000;
// The quote that closes the string opened at i (a template ${…} or %{…} may hold strings of its own); -1: none on its
// line, or nested deeper than DEEP (deep: how many strings and templates this one is inside).
function strEnd(s, i, deep = 0) {
  if (deep > DEEP) return -1;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === '"') return j;
    else if (c === "\n") return -1;
    else if ((c === "$" || c === "%") && s[j + 1] === "{" && s[j - 1] !== c) { j = tplEnd(s, j + 1, deep + 1); if (j < 0) return -1; }
  }
  return -1;
}
// The brace that closes the template whose "{" is at i.
function tplEnd(s, i, deep = 0) {
  for (let j = i + 1, d = 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') { j = strEnd(s, j, deep + 1); if (j < 0) return -1; } else if (c === "{") d++; else if (c === "}" && --d === 0) return j;
  }
  return -1;
}
const HEREDOC = /<<-?([A-Za-z_][\w-]*)[ \t]*\r?\n/y;
// Where a heredoc's closing marker ends (the heredoc's text starts at i); -1: it never closes.
function hereEnd(s, i, mark) {
  for (let a = i; a <= s.length;) { let b = s.indexOf("\n", a); if (b < 0) b = s.length; if (s.slice(a, b).trim() === mark) return b; if (b >= s.length) return -1; a = b + 1; }
  return -1;
}
// What starts at i and ends before hi: with `line` an expression (to the newline at bracket depth 0), else the bracket
// that closes the one at i. → {end, cuts: the comments in it, here: it holds a heredoc}, or null when it does not end.
function span(s, i, hi, line) {
  const cuts = [];
  let depth = 0, here = false;
  for (let j = i; j < hi; j++) {
    const c = s[j];
    if (c === '"') { j = strEnd(s, j); if (j < 0 || j >= hi) return null; }
    else if (c === "#" || (c === "/" && s[j + 1] === "/")) { let n = s.indexOf("\n", j); if (n < 0 || n > hi) n = hi; cuts.push([j, n]); j = n - 1; }
    else if (c === "/" && s[j + 1] === "*") { const n = s.indexOf("*/", j + 2); if (n < 0 || n + 2 > hi) return null; cuts.push([j, n + 2]); j = n + 1; }
    else if (c === "<" && s[j + 1] === "<") { HEREDOC.lastIndex = j; const m = HEREDOC.exec(s), e = m ? hereEnd(s, HEREDOC.lastIndex, m[1]) : 0; if (e < 0 || e > hi) return null; if (m) { here = true; j = e - 1; } else j++; }
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (--depth === 0 && !line) return { end: j, cuts, here }; if (depth < 0) return null; }
    else if (c === "\n" && line && depth === 0) return { end: j, cuts, here };
  }
  return line && depth === 0 ? { end: hi, cuts, here } : null;
}
// An argument's value as text, to compare and to show: without comments; over several lines without its line breaks
// and indentation, except a heredoc, whose text counts as written.
function valueText(s, a, sp) {
  let out = "", at = a;
  for (const [x, y] of sp.cuts) { out += s.slice(at, x); at = y; }
  out += s.slice(at, sp.end);
  return sp.here || !out.trim().includes("\n") ? out.trim() : squash(out);
}
const WS = /\s*/y;
// Past the white space and the comments from i; -1: a /* that never closes (asked once, so a file of them is read
// in one pass: the pattern this replaces looked for the end again from every line).
function skip(s, i) {
  for (;;) {
    WS.lastIndex = i; WS.exec(s); i = WS.lastIndex;
    if (s[i] === "#" || (s[i] === "/" && s[i + 1] === "/")) { const n = s.indexOf("\n", i); if (n < 0) return s.length; i = n; }
    else if (s[i] === "/" && s[i + 1] === "*") { const n = s.indexOf("*/", i + 2); if (n < 0) return -1; i = n + 2; }
    else return i;
  }
}
const KEY = /([A-Za-z_][\w.-]*|"[^"\n]*")[ \t]*/y, LABELS = /((?:(?:"[^"\n]*"|[A-Za-z_][\w-]*(?![\w-]))[ \t]*)*)\{/y; // (?!…): a name is taken whole, so a long line without "{" fails at once
// A block's body between lo and hi: its arguments [{name, text, line}] and its blocks [{type, labels, line, end, lo,
// hi: its own body, from}]. ok false: something in it is neither.
function hclBody(s, lo, hi, lineAt) {
  const attrs = [], blocks = [];
  let ok = true, i = lo;
  while (i < hi) {
    i = skip(s, i);
    if (i < 0) { ok = false; break; }
    if (i >= hi) break;
    KEY.lastIndex = i;
    const k = KEY.exec(s), at = k ? KEY.lastIndex : i;
    if (k && s[at] === "=" && s[at + 1] !== "=") {
      const sp = span(s, at + 1, hi, true);
      if (!sp) { ok = false; break; }
      attrs.push({ name: unq(k[1]), text: valueText(s, at + 1, sp), line: lineAt(i) }); i = sp.end; continue;
    }
    LABELS.lastIndex = at;
    const l = k ? LABELS.exec(s) : null, open = LABELS.lastIndex - 1, sp = l ? span(s, open, hi, false) : null;
    if (l && !sp) { ok = false; break; }
    if (l) { blocks.push({ type: unq(k[1]), labels: [...l[1].matchAll(/"([^"\n]*)"|([\w-]+)/g)].map((m) => m[1] ?? m[2]), line: lineAt(i), end: lineAt(sp.end), lo: open + 1, hi: sp.end, from: i }); i = sp.end + 1; continue; }
    ok = false;
    const n = s.indexOf("\n", i); i = n < 0 || n > hi ? hi : n + 1;
  }
  return { attrs, blocks, ok };
}
// A Terraform file → {items: its blocks as entities, moved: [[from, to]], imports: [to], dropped: [from] (removed
// blocks), ok: every line of its top level was a block or an argument}. An entity: {addr, kind, type, name, file,
// line, end, args: Map(name → {text, line, block: how many nested blocks of that head}), ok, raw}.
export function readTerraform(text, file) {
  const s = String(text ?? ""), lineAt = liner(s), top = hclBody(s, 0, s.length, lineAt), items = [], moved = [], imports = [], dropped = [];
  let ok = top.ok;
  const canon = (lo, hi, deep = 0) => { if (deep > DEEP) return null; // blocks in blocks without end: not understood
    const b = hclBody(s, lo, hi, lineAt), inner = b.blocks.map((x) => [x, canon(x.lo, x.hi, deep + 1)]);
    return b.ok && inner.every(([, c]) => c !== null) ? [...b.attrs.map((a) => `${a.name} = ${a.text}`), ...inner.map(([x, c]) => `${[x.type, ...x.labels.map((q) => `"${q}"`)].join(" ")} {\n${c}\n}`)].join("\n") : null; };
  const entity = (b, kind, addr, type, name) => {
    const body = hclBody(s, b.lo, b.hi, lineAt), args = new Map();
    let fine = body.ok;
    for (const a of body.attrs) args.set(a.name, { text: a.text, line: a.line });
    for (const x of body.blocks) { const key = [x.type, ...x.labels].join(" "), c = canon(x.lo, x.hi), had = args.get(key); if (c === null) fine = false;
      args.set(key, { text: `${had?.block ? `${had.text}\n` : ""}{\n${c}\n}`, line: had?.line ?? x.line, block: (had?.block ?? 0) + 1 }); }
    return { addr, kind, type, name, file, line: b.line, end: b.end, args, ok: fine, raw: squash(s.slice(b.from, b.hi)) };
  };
  for (const b of top.blocks) {
    const [l0, l1] = b.labels;
    if (b.type === "resource" && l1) items.push(entity(b, "resource", `${l0}.${l1}`, l0, l1));
    else if (b.type === "data" && l1) items.push(entity(b, "data", `data.${l0}.${l1}`, l0, l1));
    else if (b.type === "module" && l0) items.push(entity(b, "module", `module.${l0}`, "module", l0));
    else if (b.type === "variable" && l0) items.push(entity(b, "variable", `var.${l0}`, "variable", l0));
    else if (b.type === "output" && l0) items.push(entity(b, "output", `output.${l0}`, "output", l0));
    else if (b.type === "provider" && l0) { const e = entity(b, "provider", `provider.${l0}`, "provider", l0), alias = e.args.get("alias"); if (alias) e.addr = e.name = `${e.addr}.${unq(alias.text)}`; else e.name = e.addr; items.push(e); }
    else if (b.type === "terraform") items.push(entity(b, "terraform", `terraform block of ${file.slice(file.lastIndexOf("/") + 1)}`, "terraform", "terraform block"));
    else if (b.type === "locals") { const body = hclBody(s, b.lo, b.hi, lineAt); if (!body.ok || body.blocks.length) ok = false;
      for (const a of body.attrs) items.push({ addr: `local.${a.name}`, kind: "local", type: "local", name: a.name, file, line: a.line, end: a.line, args: new Map([["value", { text: a.text, line: a.line }]]), ok: true, raw: a.text }); }
    else if (b.type === "moved" || b.type === "import" || b.type === "removed") { const a = Object.fromEntries(hclBody(s, b.lo, b.hi, lineAt).attrs.map((x) => [x.name, x.text.replace(/\[[^\]]*\]/g, "")]));
      if (b.type === "moved" && a.from && a.to) moved.push([a.from, a.to]); else if (b.type === "import" && a.to) imports.push(a.to); else if (b.type === "removed" && a.from) dropped.push(a.from); }
    // ponytail: other block types (check, ephemeral) are not shown.
  }
  if (TFVARS.test(file)) for (const a of top.attrs) items.push({ addr: `${file.slice(file.lastIndexOf("/") + 1)}: ${a.name}`, kind: "value", type: "value", name: a.name, file, line: a.line, end: a.line, args: new Map([["value", { text: a.text, line: a.line }]]), ok: true, raw: a.text });
  return { items, moved, imports, dropped, ok };
}
// An argument's code without what its strings and heredocs say: of those only the templates (${…}) stay.
function hclCode(x) {
  let out = "";
  const tpls = (a, b) => { for (let j = a; j < b; j++) if ((x[j] === "$" || x[j] === "%") && x[j + 1] === "{" && x[j - 1] !== x[j]) { const e = tplEnd(x, j + 1); if (e < 0 || e > b) return; out += ` ${hclCode(x.slice(j + 2, e))} `; j = e; } };
  for (let i = 0; i < x.length; i++) {
    if (x[i] === '"') { const e = strEnd(x, i); if (e < 0) break; tpls(i + 1, e); i = e; }
    else if (x[i] === "<" && x[i + 1] === "<") { HEREDOC.lastIndex = i; const m = HEREDOC.exec(x); if (!m) { out += x[i]; continue; } let e = hereEnd(x, HEREDOC.lastIndex, m[1]); if (e < 0) e = x.length; tpls(HEREDOC.lastIndex, e); i = e - 1; }
    else out += x[i];
  }
  return out;
}
// aws_x.y, data.aws_x.y, module.m, var.v, local.l where code names them (a resource type has an underscore).
const TF_REF = /(?<![\w.-])(data\.[a-z0-9_]+\.[A-Za-z_][\w-]*|(?:module|var|local)\.[A-Za-z_][\w-]*|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*)/g;

// ---- CloudFormation and SAM

const YKEY = /^(["']?)([A-Za-z0-9_][\w.:/-]*?)\1:(?:[ \t]+(.*))?$/, indentOf = (l) => l.length - l.trimStart().length;
// The keys of a block mapping in lines[lo, hi): [{name, value: the text after its colon, line, lo, hi: its body}].
// ok false: a line at the keys' indentation is no plain "key:" (a flow mapping, a merge key, a tab).
function yamlKids(lines, lo, hi) {
  const kids = [];
  let ok = true, n = -1;
  for (let i = lo; i < hi; i++) {
    const l = lines[i], t = l.trim();
    if (!t || t === "---") continue;
    if (/^ *\t/.test(l)) { ok = false; continue; }
    const ind = indentOf(l), cur = kids[kids.length - 1];
    if (t[0] === "#" && (n < 0 || ind <= n)) continue; // a comment between keys
    if (n < 0) n = ind;
    const m = ind === n ? YKEY.exec(t) : null;
    if (m) { if (cur) cur.hi = i; kids.push({ name: m[2], value: (m[3] ?? "").trim(), line: i + 1, lo: i + 1, hi }); }
    else if (cur && (ind > n || (ind === n && t[0] === "-" && !cur.value))) continue; // its body, or a list written at its key's indentation
    else ok = false;
  }
  return { kids, ok };
}
// A key's value as text: what follows the colon and its body without the indentation, blank lines and comments
// between keys. (A comment inside a value counts: it may be a script's line.)
function yamlText(lines, k) {
  const own = indentOf(lines[k.line - 1]), body = lines.slice(k.lo, k.hi).filter((l) => l.trim() && !(l.trim()[0] === "#" && indentOf(l) <= own)), cut = body.reduce((m, l) => Math.min(m, indentOf(l)), Infinity); // not Math.min(...): a value of 200 000 lines overflows the stack as arguments
  const first = /["']/.test(k.value) ? k.value : k.value.replace(/(^|\s+)#.*$/, "");
  return [first, ...body.map((l) => l.slice(cut).trimEnd())].filter(Boolean).join("\n");
}
const CFN_TYPE = /^(AWS|Custom|Alexa)::/, SECTIONS = { Parameters: "parameter", Outputs: "output", Conditions: "condition", Mappings: "mapping", Globals: "globals" };
// A template → {items, sam}, or null when the text is no CloudFormation template. Entities as readTerraform's; a
// resource's args are its Properties' top level and its own attributes (DependsOn, DeletionPolicy, …).
export function readCloudFormation(text, file) {
  const s = String(text ?? "");
  if (/^\s*\{/.test(s)) return cfnJson(s, file);
  const lines = s.split("\n").map((l) => l.replace(/\r$/, "")), top = yamlKids(lines, 0, lines.length), R = top.kids.find((k) => k.name === "Resources"), items = [];
  if (!R) return null;
  const end = (k) => { let e = k.hi; while (e > k.lo && !lines[e - 1].trim()) e--; return Math.max(e, k.line); }, block = (k) => (lines.slice(k.lo, k.hi).some((l) => l.trim()) ? 1 : 0);
  const arg = (k) => ({ text: yamlText(lines, k), line: k.line, block: block(k) });
  for (const r of yamlKids(lines, R.lo, R.hi).kids) {
    const body = yamlKids(lines, r.lo, r.hi), args = new Map();
    let ok = body.ok && !r.value, type = "";
    for (const k of body.kids) {
      if (k.name === "Type") type = unq(yamlText(lines, k));
      else if (k.name === "Properties") { const p = yamlKids(lines, k.lo, k.hi); if (!p.ok || k.value) ok = false; for (const x of p.kids) args.set(x.name, arg(x)); }
    }
    for (const k of body.kids) if (k.name !== "Type" && k.name !== "Properties") args.set(args.has(k.name) ? `${k.name} (attribute)` : k.name, arg(k));
    items.push({ addr: r.name, kind: "resource", type, name: r.name, file, line: r.line, end: end(r), args, ok, raw: yamlText(lines, r) });
  }
  const tr = top.kids.find((k) => k.name === "Transform");
  if (!top.kids.some((k) => k.name === "AWSTemplateFormatVersion") && !tr && !items.some((x) => CFN_TYPE.test(x.type))) return null;
  for (const sec of top.kids.filter((k) => SECTIONS[k.name])) for (const k of yamlKids(lines, sec.lo, sec.hi).kids) {
    const inner = yamlKids(lines, k.lo, k.hi), kind = SECTIONS[sec.name];
    items.push({ addr: sec.name === "Parameters" ? k.name : `${sec.name}.${k.name}`, kind, type: kind, name: k.name, file, line: k.line, end: end(k), ok: inner.ok,
      args: inner.ok && inner.kids.length ? new Map(inner.kids.map((x) => [x.name, arg(x)])) : new Map([["value", arg(k)]]), raw: yamlText(lines, k) });
  }
  if (tr) items.push({ addr: "Transform", kind: "transform", type: "transform", name: "Transform", file, line: tr.line, end: end(tr), ok: true, args: new Map([["value", arg(tr)]]), raw: yamlText(lines, tr) });
  return { items, sam: Boolean(tr && /Serverless/.test(yamlText(lines, tr))) };
}
// ponytail: a JSON template's lines come from the first `"Name":` after its section's key, and a resource ends where
// its pretty-printed text would; exact for the usual formatting only.
function cfnJson(s, file) {
  let doc;
  try { doc = JSON.parse(s); } catch { return null; }
  if (!doc || typeof doc.Resources !== "object" || Array.isArray(doc.Resources) || !doc.Resources) return null;
  const lineAt = liner(s), items = [], text = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)), arg = (v, line) => ({ text: text(v), line, block: v !== null && typeof v === "object" ? 1 : 0 });
  const place = (sec, name) => { const from = Math.max(0, s.search(new RegExp(`"${sec}"\\s*:`))), at = s.slice(from).search(new RegExp(`"${name.replace(/[^\w]/g, "\\$&")}"\\s*:`)); return lineAt(from + Math.max(0, at)); };
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  for (const [name, r] of Object.entries(doc.Resources)) {
    const line = place("Resources", name), args = new Map(Object.entries(obj(r?.Properties)).map(([k, v]) => [k, arg(v, line)]));
    for (const [k, v] of Object.entries(obj(r))) if (k !== "Type" && k !== "Properties") args.set(args.has(k) ? `${k} (attribute)` : k, arg(v, line));
    items.push({ addr: name, kind: "resource", type: String(r?.Type ?? ""), name, file, line, end: line + JSON.stringify(r ?? null, null, 1).split("\n").length - 1, args, ok: Boolean(r) && typeof r === "object", raw: JSON.stringify(r) });
  }
  if (!("AWSTemplateFormatVersion" in doc) && !("Transform" in doc) && !items.some((x) => CFN_TYPE.test(x.type))) return null;
  for (const [sec, kind] of Object.entries(SECTIONS)) for (const [name, v] of Object.entries(obj(doc[sec]))) { const line = place(sec, name), inner = Object.entries(obj(v));
    items.push({ addr: sec === "Parameters" ? name : `${sec}.${name}`, kind, type: kind, name, file, line, end: line, ok: true, args: inner.length ? new Map(inner.map(([k, x]) => [k, arg(x, line)])) : new Map([["value", arg(v, line)]]), raw: JSON.stringify(v) }); }
  if ("Transform" in doc) items.push({ addr: "Transform", kind: "transform", type: "transform", name: "Transform", file, line: place("Transform", "Transform"), end: 1, ok: true, args: new Map([["value", arg(doc.Transform, 1)]]), raw: JSON.stringify(doc.Transform) });
  return { items, sam: /Serverless/.test(JSON.stringify(doc.Transform ?? "")) };
}
// !Ref X, Ref: X, !GetAtt X.Attr, Fn::GetAtt: [X, Attr], ${X} and ${X.Attr} (in YAML or JSON text).
const CFN_REFS = [/(?:!Ref\s+|\bRef["']?\s*:\s*)["']?([A-Za-z0-9]+)(?![\w:])/g, /(?:!GetAtt\s+|Fn::GetAtt["']?\s*:\s*)(?:\[\s*|-\s*)?["']?([A-Za-z0-9]+)/g, /\$\{([A-Za-z0-9]+)(?:\.[\w.]+)?\}/g];

// ---- the difference

// A value is never written out when its argument's name or its own text looks like a secret; nor when it is a block,
// has several lines or is long (then the diff shows it better).
const SECRET = /pass(word|wd|phrase)|secret|token|key|credential|private/i, SECRET_VALUE = /passw|secret|token|credential|private.?key/i;
function changesOf(b, h) {
  if (!b.ok || !h.ok) return b.raw === h.raw ? [] : [{ name: null, how: "changed", line: h.line, text: "Changed; this block is not read in detail" }];
  const out = b.type === h.type ? [] : [{ name: "Type", how: "changed", line: h.line, text: `Type: ${b.type} → ${h.type}` }];
  for (const name of new Set([...h.args.keys(), ...b.args.keys()])) {
    const x = b.args.get(name), y = h.args.get(name);
    if (x?.text === y?.text) continue;
    const how = !x ? "added" : !y ? "removed" : "changed", hide = SECRET.test(name) || [x, y].some((v) => v && (v.block || v.text.includes("\n") || v.text.length > 60 || SECRET_VALUE.test(v.text)));
    const blocks = (x?.block > 1 || y?.block > 1) && x?.block !== y?.block ? ` (${x?.block ?? 0} → ${y?.block ?? 0} blocks)` : "";
    out.push({ name, how, line: y?.line ?? h.line, text: `${name}: ${hide ? `${how}${blocks}` : how === "changed" ? `${x.text} → ${y.text}` : how === "added" ? `added (${y.text})` : `removed (was ${x.text})`}` });
  }
  return out;
}
// "May be replaced": only for arguments known to force a new resource. A small honest list, not a provider schema:
// Terraform's name and identifier arguments, and count or for_each coming or going (the address changes);
// CloudFormation's Type and its custom names (…Name, …Identifier). Everything else is "changed".
export const REPLACE_TF = new Set(["name", "name_prefix", "bucket", "function_name", "identifier", "family"]);
const replaceWhy = (e, changes, fmt) => (e.kind !== "resource" ? null
  : changes.find((c) => c.name && (fmt === "tf" ? REPLACE_TF.has(c.name) || (/^(count|for_each)$/.test(c.name) && c.how !== "changed") : c.name === "Type" || /(Name|Identifier)$/.test(c.name)))?.name ?? null);

const CARD = new Set(["resource", "data", "module"]), NOTICE = new Set(["provider", "terraform", "transform"]);
const refsOf = (e, fmt, known) => {
  const out = new Map(), add = (id, name) => { if (known.has(id) && id !== e.addr) out.set(id, [...new Set([...(out.get(id) ?? []), name])]); };
  for (const [name, a] of e.ok ? e.args : [["", { text: e.raw }]]) {
    if (fmt === "tf") for (const m of hclCode(a.text).matchAll(TF_REF)) add(m[1], name);
    else if (name === "DependsOn") for (const id of a.text.match(/[A-Za-z0-9]+/g) ?? []) add(id, name);
    else for (const re of CFN_REFS) for (const m of a.text.matchAll(re)) add(m[1], name);
  }
  return out;
};

// files: the patch's files [{path, status, from, lines, head: the text at the PR head when it was read}]; others:
// [{path, text}], unchanged Terraform files of the same folders at the head. → null when the PR has no infrastructure
// code, else {groups: [{id, label, kind}], cards, edges: [{from, to, label, status}], rows, notices, unread: [{path,
// why}], kinds, counts: {added, changed, replaced, removed}, total}.
// A card (a resource, data source or module that changed, or an unchanged one a reference connects to a changed one):
// {id, group, addr, kind, type, name, file, line, end, status: added | changed | replaced | removed | unchanged,
// changes: [{name, how, line, text}], why: the argument that may force a new resource, was: its address before a moved
// block, imported, kept: a removed block names it, still: who still refers to it though it is removed, uses: [{addr,
// status}] changed variables, locals or parameters it reads, deps: the addresses it refers to}.
// rows: changed variables, locals, outputs, tfvars values, parameters … with usedBy; notices: changed provider,
// terraform (backend, versions) and Transform blocks.
export function infraModel(files, others = []) {
  const stacks = new Map(), unread = [], kinds = new Set();
  const stack = (id, label, kind, fmt) => { if (!stacks.has(id)) stacks.set(id, { id, label, kind, fmt, base: new Map(), head: new Map(), moved: [], imports: [], dropped: [] }); return stacks.get(id); };
  const tfStack = (path) => stack(`tf:${dirOf(path)}`, dirOf(path) || "Repository root", "Terraform", "tf");
  for (const f of files ?? []) {
    const tf = TF.test(f.path) || TFVARS.test(f.path);
    if (!isInfraFile(f)) continue; // a template without its text at the head is named as not read, below
    const sides = sidesOf(f), from = f.from ?? f.path;
    if (tf) kinds.add("Terraform");
    if (!sides) { unread.push({ path: f.path, why: typeof f.head === "string" ? "the patch does not fit the file at the PR head" : "the file at the PR head is not loaded" }); if (!tf) kinds.add("CloudFormation"); continue; }
    if ((sides.head?.length ?? 0) > MAX_BYTES || (sides.base?.length ?? 0) > MAX_BYTES) { unread.push({ path: f.path, why: "it is too large to read here" }); continue; }
    if (tf) {
      const h = sides.head === null ? null : readTerraform(sides.head, f.path), b = sides.base === null ? null : readTerraform(sides.base, from);
      if ((h && !h.ok) || (b && !b.ok)) { unread.push({ path: f.path, why: "the reader does not understand a part of it" }); continue; }
      if (h) { const g = tfStack(f.path); for (const e of h.items) g.head.set(e.addr, e); g.moved.push(...h.moved); g.imports.push(...h.imports); g.dropped.push(...h.dropped); }
      if (b) { const g = tfStack(from); for (const e of b.items) g.base.set(e.addr, e); }
    } else {
      const h = sides.head === null ? null : readCloudFormation(sides.head, f.path), b = sides.base === null ? null : readCloudFormation(sides.base, f.path);
      if (!h && !b) continue;
      kinds.add("CloudFormation");
      const g = stack(`cfn:${f.path}`, f.path, h?.sam || b?.sam ? "SAM" : "CloudFormation", "cfn");
      for (const e of h?.items ?? []) g.head.set(e.addr, e);
      for (const e of b?.items ?? []) g.base.set(e.addr, e);
    }
  }
  const own = new Set((files ?? []).flatMap((f) => [f.path, f.from]));
  for (const o of others ?? []) {
    const g = stacks.get(`tf:${dirOf(o.path)}`), r = g && TF.test(o.path) && !own.has(o.path) ? readTerraform(o.text, o.path) : null;
    if (r?.ok) for (const e of r.items) { if (!g.head.has(e.addr)) g.head.set(e.addr, e); if (!g.base.has(e.addr)) g.base.set(e.addr, e); }
  }
  const cards = [], rows = [], notices = [], edges = [], groups = [];
  for (const g of [...stacks.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const from = new Map(g.moved.filter(([a, b]) => g.base.has(a) && g.head.has(b) && !g.head.has(a)).map(([a, b]) => [b, a])), gone = new Set(from.values());
    const known = new Set([...g.base.keys(), ...g.head.keys()]), ents = [], id = (addr) => `${g.id}|${addr}`;
    for (const [addr, h] of g.head) {
      const b = g.base.get(from.get(addr) ?? addr), changes = b ? changesOf(b, h) : [], why = b ? replaceWhy(h, changes, g.fmt) : null, was = from.get(addr) ?? null;
      ents.push({ ...h, id: id(addr), group: g.id, status: !b ? "added" : why ? "replaced" : changes.length || was ? "changed" : "unchanged", changes, why, was, imported: !b && g.imports.includes(addr), refs: refsOf(h, g.fmt, known) });
    }
    for (const [addr, b] of g.base) if (!g.head.has(addr) && !gone.has(addr)) ents.push({ ...b, id: id(addr), group: g.id, status: "removed", changes: [], why: null, was: null, kept: g.dropped.includes(addr), refs: refsOf(b, g.fmt, known) });
    const by = new Map(ents.map((e) => [e.addr, e])), live = ents.filter((e) => e.status !== "removed"), users = (addr) => live.filter((e) => e.refs.has(addr));
    const touched = new Set(ents.filter((e) => e.status !== "unchanged").flatMap((e) => [e.addr, e.was])), renamed = new Map([...from].map(([now, old]) => [old, now]));
    for (const e of ents) {
      e.still = e.status === "removed" ? users(e.addr).map((u) => u.addr) : [];
      const old = e.was ? users(e.was).map((u) => u.addr) : [];
      if (old.length) e.still = old; // a moved block renames the resource, not who refers to it
      e.uses = e.status === "removed" ? [] : [...e.refs.keys()].map((a) => by.get(a)).filter((x) => x && !CARD.has(x.kind) && (x.status === "changed" || x.status === "removed")).map((x) => ({ addr: x.addr, status: x.status }));
      e.deps = [...e.refs.keys()].filter((a) => CARD.has((by.get(a) ?? g.base.get(a))?.kind));
    }
    const near = new Set(ents.filter((e) => CARD.has(e.kind) && e.status !== "unchanged").flatMap((e) => [...e.refs.keys()])); // what a changed card refers to
    const shown = ents.filter((e) => CARD.has(e.kind) && (e.status !== "unchanged" || near.has(e.addr) || [...e.refs.keys()].some((a) => touched.has(a)))).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const on = new Set(shown.map((e) => e.addr));
    for (const e of shown) for (const [to, names] of e.refs) if (on.has(renamed.get(to) ?? to)) edges.push({ from: e.id, to: id(renamed.get(to) ?? to), label: names.filter(Boolean).join(", "), status: e.status === "added" ? "new" : e.status === "removed" ? "removed" : "unchanged" });
    cards.push(...shown);
    for (const e of ents) {
      if (CARD.has(e.kind) || e.status === "unchanged" || (e.status === "added" && !g.base.size)) continue; // a new stack's own variables and provider are no change to one
      (NOTICE.has(e.kind) ? notices : rows).push({ ...e, usedBy: users(e.addr).filter((u) => CARD.has(u.kind)).map((u) => u.addr) });
    }
    if (shown.length) groups.push({ id: g.id, label: g.label, kind: g.kind });
  }
  if (!cards.length && !rows.length && !notices.length && !unread.length) return null;
  const counts = Object.fromEntries(["added", "changed", "replaced", "removed"].map((k) => [k, cards.filter((c) => c.status === k).length]));
  return { groups, cards, edges, rows, notices, unread, kinds: [...kinds], counts,
    total: cards.filter((c) => c.status !== "unchanged").length + rows.length + notices.length };
}

// ---- words: the same on the page and in the Markdown

const STATE = { added: "added", changed: "changed", replaced: "may be replaced", removed: "removed", unchanged: "unchanged" };
const names = (list, max = 3) => `${list.slice(0, max).join(", ")}${list.length > max ? ` and ${list.length - max} more` : ""}`;
// What the picture comes from and does not know (the line under the section's title).
export function infraSource(model) {
  const tf = model.kinds.includes("Terraform"), cfn = model.kinds.includes("CloudFormation") || !tf;
  return `Derived from the diff; ${[tf && "no terraform plan was run", cfn && "no change set was created"].filter(Boolean).join(" and ")}, so replacements and computed values are estimates.`;
}
export function infraSummary(model) {
  const n = model.cards.filter((c) => c.status !== "unchanged").length, rest = model.cards.length - n, parts = Object.entries(model.counts).filter(([, k]) => k).map(([k, c]) => `${c} ${STATE[k]}`);
  return [n ? `${n} ${n === 1 ? "resource" : "resources"}: ${parts.join(", ")}.` : "No resource itself changes.", rest ? `${rest} unchanged ${rest === 1 ? "one is" : "ones are"} directly connected to what changed.` : ""].filter(Boolean).join(" ");
}
// A card's lines under its text: what stands out first (a long one takes two rows), then its changed arguments (at
// most `max`, one row each, with their line in the diff). → [{text, rows, bad, estimate, at}]
export function cardLines(c, max = INFRA_LINES) {
  const out = [];
  // Names as the cards' titles have them: an address with its type does not fit a card (the Markdown table has them).
  const short = (addr) => addr.slice(addr.lastIndexOf(".") + 1);
  if (c.still?.length) out.push({ text: `${c.was ? "Its old name is still used by" : "Still referenced by"} ${names(c.still.map(short))}`, bad: true });
  if (c.was) out.push({ text: `Renamed from ${short(c.was)} by a moved block` });
  if (c.imported) out.push({ text: "An import block adopts an existing resource" });
  if (c.kept) out.push({ text: "A removed block names it, see its lifecycle" });
  if (c.why) out.push({ text: c.why === "Type" ? "A new Type replaces the resource" : /^(count|for_each)$/.test(c.why) ? `Its address changes with ${c.why}, which usually replaces it` : `A changed ${c.why} usually forces a new resource`, estimate: true });
  for (const u of c.uses ?? []) out.push({ text: `Uses ${u.addr}, which ${u.status === "removed" ? "was removed" : "changed"}`, bad: u.status === "removed" });
  out.push(...(c.changes ?? []).slice(0, max).map((x) => ({ text: x.text, at: `${c.file}:${x.line}` })));
  if ((c.changes ?? []).length > max) out.push({ text: `and ${c.changes.length - max} more` });
  for (const l of out) l.rows = !l.at && l.text.length > NOTE_CH ? 2 : 1;
  return out;
}
export const noticeText = (n) => `${n.kind === "transform" ? "Transform" : n.addr} ${STATE[n.status]} in ${n.file}:${n.line}${n.changes.length ? `: ${n.changes.map((c) => c.text).join("; ")}` : ""}`;
export const rowText = (r) => [`${r.addr} ${STATE[r.status]}`, ...r.changes.map((c) => (c.name === "value" ? c.text.replace(/^value: /, "") : c.text)).filter((x) => x !== STATE[r.status]), r.usedBy.length ? `${r.status === "removed" ? "still used by" : "used by"} ${names(r.usedBy, 6)}` : ""].filter(Boolean).join(" · ");

// ---- the picture

// The model as arch.js archLayout reads it: {groups, nodes, edges}. Only for a section that is not dense (isDense):
// with many resources there is no picture with lines, so nothing here has to fold cards into one.
export function infraArch(model) {
  // A card's place is a row of its own, the file's name with its line and never wrapped (its folder is the frame's
  // title or in the tooltip): in the description a long path was broken in the middle of the file's name.
  // Its title is the type and the name, the type first: Terraform resources of one thing often share a name (a bucket,
  // its policy, its lifecycle), and with the name alone as the title they read as the same card several times. Each
  // part fits a line of the title (the whole address is the tooltip).
  const node = (c) => ({ id: c.id, label: `${clip(typeTitle(c), ARCH.TITLE_CH)} · ${clip(c.name, ARCH.TITLE_CH - 2)}`, description: "", evidence: c.addr, group: c.group, type: c.type, at: `${c.file}:${c.line}`, status: c.status === "added" ? "new" : c.status,
    source: c.status === "unchanged" ? "existing" : undefined, word: c.status === "replaced" ? "MAY BE REPLACED" : undefined, dashed: c.status === "replaced",
    lines: [{ text: `${baseOf(c.file)}:${c.line}`, tip: `${c.file}:${c.line}`, at: `${c.file}:${c.line}`, place: true, rows: 1 }, ...cardLines(c)] });
  const seen = new Set(), edges = [];
  for (const e of model.edges) { const k = `${e.from}>${e.to}`; if (e.from === e.to || seen.has(k)) continue; seen.add(k); edges.push(e); }
  return { groups: model.groups, nodes: model.cards.map(node), edges };
}
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }, sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
// The findings whose line lies inside a resource's block, as arch.js archMarks gives them ({nodes, edges}).
export function infraMarks(model, findings) {
  const nodes = new Map();
  for (const f of findings ?? []) {
    const c = model.cards.find((x) => x.status !== "removed" && f.file && sameFile(x.file, f.file) && f.line >= x.line && f.line <= x.end);
    if (!c) continue;
    const k = c.id, m = nodes.get(k) ?? { findings: [], n: 0, breaks: 0, severity: f.severity };
    m.findings.push(f); m.n++;
    if ((RANK[f.severity] ?? 9) < (RANK[m.severity] ?? 9)) m.severity = f.severity;
    nodes.set(k, m);
  }
  return { nodes, edges: new Map() };
}
// ---- many resources: cards by file instead of a graph

const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A type without its provider: "aws_s3_bucket" → "s3_bucket", "AWS::SQS::Queue" → "SQS::Queue"; a type of one word stays. */
export const shortType = (type) => (type.startsWith("AWS::") ? type.slice(5) : /^[a-z0-9]+_./.test(type) ? type.slice(type.indexOf("_") + 1) : type);
const typeTitle = (c) => `${c.kind === "data" ? "data " : ""}${shortType(c.type)}`;
/** The section is a list by file, not a graph: more changed resources or more references than a picture with lines can show. */
export const isDense = (model) => model.cards.filter((c) => c.status !== "unchanged").length > INFRA_DENSE.cards || model.edges.length > INFRA_DENSE.edges;
export const denseText = () => `More than ${INFRA_DENSE.cards} resources or ${INFRA_DENSE.edges} references: they stand by file with what stands out first, and no lines are drawn.`;
// What stands out comes first: a card with a finding (the worst first), one that is still referenced though removed
// or uses something removed, then may be replaced, removed, changed, added, unchanged; among equals by line.
const STATE_RANK = { replaced: 2, removed: 3, changed: 4, added: 5, unchanged: 6 };
/**
 * The model for the list: {groups: [{file, dir, base, kind, types: [[type, n]], cards, more: cards left out}], refs:
 * Map(card id → {to: [{id, label}], from: [{id, label}]}), names: Map(card id → address), uniform: the one state all
 * changed cards share or null, marks: infraMarks}. A card: {id, name, type: its type without the provider (the card's
 * title: resources often share a name), status, line, at, lines: cardLines, mark: its findings or null, to, from: how
 * many it refers to and how many refer to it}. Pure.
 */
export function infraDense(model, findings = []) {
  const marks = infraMarks(model, findings), refs = new Map(model.cards.map((c) => [c.id, { to: [], from: [] }])), kind = new Map(model.groups.map((g) => [g.id, g.kind]));
  for (const e of model.edges) { if (e.from === e.to || !refs.has(e.from) || !refs.has(e.to)) continue; refs.get(e.from).to.push({ id: e.to, label: e.label }); refs.get(e.to).from.push({ id: e.from, label: e.label }); }
  const rank = (c) => { const m = marks.nodes.get(c.id); return m ? [0, RANK[m.severity] ?? 9] : c.still?.length || (c.uses ?? []).some((u) => u.status === "removed") ? [1, 0] : [STATE_RANK[c.status] ?? 6, 0]; };
  const by = new Map();
  for (const c of model.cards) by.set(c.file, [...(by.get(c.file) ?? []), c]);
  const groups = [...by].map(([file, list]) => {
    const sorted = list.map((c) => ({ c, r: rank(c) })).sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.c.line - b.c.line), types = new Map();
    for (const c of list) types.set(typeTitle(c), (types.get(typeTitle(c)) ?? 0) + 1);
    return { file, dir: file.slice(0, file.lastIndexOf("/") + 1), base: baseOf(file), kind: kind.get(list[0].group) ?? "", best: sorted[0].r, types: [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), more: Math.max(0, sorted.length - INFRA_DENSE.perFile),
      // ponytail: at most perFile cards of a file are drawn (the rest is counted, the Markdown table has all); page them if a file ever has more that matter.
      cards: sorted.slice(0, INFRA_DENSE.perFile).map(({ c }) => ({ id: c.id, name: c.name, type: typeTitle(c), status: c.status, line: c.line, at: `${c.file}:${c.line}`, lines: cardLines(c), mark: marks.nodes.get(c.id) ?? null, to: refs.get(c.id).to.length, from: refs.get(c.id).from.length })) };
  }).sort((a, b) => a.best[0] - b.best[0] || a.best[1] - b.best[1] || a.file.localeCompare(b.file));
  const states = new Set(model.cards.filter((c) => c.status !== "unchanged").map((c) => c.status));
  return { groups, refs, names: new Map(model.cards.map((c) => [c.id, c.addr])), uniform: states.size === 1 ? [...states][0] : null, marks };
}
/** A chosen card's references in words: "x refers to 2: a (role), b. 1 refers to it: c (function_name)." */
export function denseRefs(dense, id) {
  const r = dense.refs.get(id), name = (x) => `${dense.names.get(x.id) ?? x.id}${x.label ? ` (${x.label})` : ""}`;
  if (!r) return "";
  return `${dense.names.get(id) ?? id} ${r.to.length ? `refers to ${r.to.length}: ${r.to.map(name).join(", ")}` : "refers to nothing in this PR"}. ${r.from.length ? `${r.from.length} ${r.from.length === 1 ? "refers" : "refer"} to it: ${r.from.map(name).join(", ")}` : "Nothing in this PR refers to it"}.`;
}

// → {arch, marks, args, L}: one layout with a row per line of a card and the room its finding mark takes. args: what
// the layout got, for the search for a better layout after the frame (stack.js laidOut, arch.js layoutJob). L is what a
// frame can afford (arch.js archQuick); lay: false leaves it to the caller (the review lays a big picture out after
// the frame).
export function infraPicture(model, findings = [], fit = false, lay = true) {
  const arch = infraArch(model), marks = infraMarks(model, findings), w = (fit ? FIT : ARCH).W - 20;
  const args = [arch, "diff", (n) => (n.lines ?? []).reduce((k, l) => k + l.rows, 0) + (marks.nodes.has(n.id) ? markRoom(marks.nodes.get(n.id), w).rows : 0), fit, { labels: true }];
  return { arch, marks, args, ...(lay ? { L: archQuick(...args) } : {}) };
}

// ---- Copy as Markdown: the section's lines. table(head, rows) and flow(picture, opts) are markdown.js's own (its
// table and mermaidFlow), handed in so this file stays below it.
// A text from the PR in the copied Markdown: one line, as a code span. Pasted into GitHub, a code span is inert: no
// mention notifies anyone, no image is fetched, no heading or fence starts, whatever a name or a value in the PR says.
const mdCode = (x) => { const s = squash(x ?? "").replace(/`/g, "'"); return s ? `\`${s}\`` : ""; };
export function infraMd(model, { table, flow, findings = [], h = "##" } = {}) {
  if (!model) return [];
  const arch = infraArch(model), marks = infraMarks(model, findings), card = new Map(model.cards.map((c) => [c.id, c]));
  const nodes = arch.nodes.map((n) => { const c = card.get(n.id); return { id: n.id, group: n.group, status: n.status === "replaced" ? "changed" : n.status,
    label: `${c.kind === "data" ? "data " : ""}${c.type} ${c.name}${c.status === "replaced" ? ", may be replaced" : ""}${c.still?.length ? ", still referenced" : ""}` }; });
  const own = marks.nodes, found = (c) => { const m = own.get(c.id); return m ? `${m.severity}: ${m.findings.map((f) => squash(f.title)).join("; ")}` : ""; };
  const notes = (c) => cardLines(c, 0).filter((l) => !/^and \d+ more$/.test(l.text)).map((l) => l.text);
  return [`${h} Infrastructure changes (${model.total})`, "", infraSource(model), "",
    ...(model.notices.length ? [...model.notices.map((n) => `- ${mdCode(noticeText(n))}`), ""] : []),
    // Many resources: no flowchart (its lines would say as little as the page's); the table names what each depends on.
    ...(model.cards.length ? [...(isDense(model) ? [`${infraSummary(model)} ${denseText()}`, ""]
      : [`${infraSummary(model)} A card's class in the diagram is its state; an arrow points at what a resource refers to.`, "", ...flow({ groups: arch.groups, nodes, edges: arch.edges }, { systems: true, marks }), ""]),
      ...table(["Resource", "State", "Changed arguments", "Depends on", "Where", "Unresolved findings"], model.cards.map((c) => [mdCode(`${c.kind === "data" ? "data " : ""}${c.type} ${c.name}`), [STATE[c.status], mdCode(notes(c).join("; "))].filter(Boolean).join("; "), mdCode(c.changes.map((x) => x.text).join("; ")), mdCode(c.deps.join(", ")), mdCode(`${c.file}:${c.line}`), found(c)]))] : []),
    ...(model.rows.length ? [`${h}# Variables, outputs and other values (${model.rows.length})`, "", ...model.rows.map((r) => `- ${mdCode(rowText(r))} (${mdCode(`${r.file}:${r.line}`)})`), ""] : []),
    ...(model.unread.length ? [...model.unread.map((u) => `- ${mdCode(unreadText(u))}`), ""] : [])];
}
export const unreadText = (u) => `${u.path} is not in the picture: ${u.why}.`;
