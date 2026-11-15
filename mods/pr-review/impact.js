// The Impact picture of the Architecture page: the functions and classes this PR changes, and who calls them. No
// model: the callers come from the language servers behind lsp_bridge.py (/symbols, /references). Pure, no imports:
// the diff's hunks + each file's symbols + each changed symbol's references -> the model (changed functions with
// their callers, each caller marked) -> cards and calls for arch.js archLayout, and the rows and flowchart of the
// page's Markdown. computeImpact asks the bridge through the `call` it is given, one request at a time.
//
// A caller carries one of three marks: "changed" (its call is on a line this PR adds), "untouched" (its file is in
// the PR, the call is not) and "outside" (its file is not in the PR). A changed function whose declaration lines
// changed has `sig`; a caller of it whose call did not change is the one to look at. Tests are callers too, counted
// apart and never cards. A function this PR adds is in the picture only when something outside the diff uses it.
// Infrastructure code (what infra.js reads: Terraform, CloudFormation and SAM templates) is left to the section
// "Infrastructure changes": its files are neither changed symbols nor callers here, and no server is asked about them.

export const MARKS = {
  outside: { glyph: "◆", word: "not in this PR", group: "Callers not in this PR" },
  untouched: { glyph: "◐", word: "in the diff, call untouched", group: "Callers in the diff, call untouched" },
  changed: { glyph: "○", word: "changed in this PR", group: "Callers changed in this PR" },
};
export const MARK_ORDER = ["outside", "untouched", "changed"];
export const SIG = { glyph: "⚠", word: "signature changed, caller not" };
// ASK: changed symbols asked for their references; FILES: caller files asked for their symbols; MS: the whole computation.
export const MODEL_V = 2; // a kept result of another version is computed again (2: without infrastructure files)
export const LIMITS = { ASK: 60, FILES: 80, MS: 90000 };
// More changed symbols, callers or calls than this, and a picture with lines no longer shows which caller belongs to
// which symbol: the section is then a row per changed symbol with its callers by file (impactDense), what stands out
// first. files: the files of one mark named in a row before "and n more".
export const IMPACT_DENSE = { symbols: 12, callers: 12, calls: 15, files: 8 };

const FUNC = new Set(["function", "method", "constructor"]), TYPES = new Set(["class", "interface", "struct", "enum"]);
// What can be a changed symbol or a caller: functions, types, and a multi-line value (const f = () => …, a table).
const named = (s) => FUNC.has(s.kind) || TYPES.has(s.kind) || (s.end > s.line && ["variable", "constant", "property", "field"].includes(s.kind));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const base = (path) => String(path).split("/").pop();
const ext = (path) => (base(path).includes(".") ? base(path).split(".").pop().toLowerCase() : "");
export const fullName = (s) => (s.container ? `${s.container}.${s.name}` : s.name);

/** Whether a file is a test, by where it lives or how it is named. */
export const isTestPath = (p) => /(^|\/)(tests?|__tests__|specs?|testing|e2e)\//i.test(p)
  || /(^|\/)(test_[^/]*\.py|conftest\.py|[^/]*_test\.(py|go|rs|cc|cpp|c)|[^/]*\.(test|spec)\.[cm]?[jt]sx?|[^/]*Tests?\.(java|kt|cs)|test_[^/]*\.[cm]?js)$/.test(p);

/** Whether a line that names a symbol only imports or re-exports it (no caller). */
export const isImport = (text) => /^\s*(from\s+\S+\s+import\b|import\b|export\s+(\*|\{[^}]*\})\s+from\b|use\s|#\s*include\b|(const|let|var)\s+.*=\s*require\()/.test(text)
  || /^\s*[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*\)?\s*$/.test(text); // one name of an import list that goes over several lines

/**
 * What the diff changes per file (new side): hunks [{path, rows}] with pr.js diffRows rows.
 * -> Map(path -> {added: Set(line), text: Map(line -> text), removed: [{at: the new-side line the removed one stood before, text}]}).
 */
export function fileChanges(hunks) {
  const out = new Map();
  for (const h of hunks ?? []) {
    const f = out.get(h.path) ?? { added: new Set(), text: new Map(), removed: [] };
    let next = 1;
    for (const r of h.rows ?? []) {
      if (r.kind === "@") next = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(r.text)?.[1] ?? next);
      else if (r.kind === "+") { f.added.add(r.n); f.text.set(r.n, r.text); next = r.n + 1; }
      else if (r.kind === " ") next = r.n + 1;
      else if (r.kind === "-") f.removed.push({ at: next, text: r.text });
    }
    out.set(h.path, f);
  }
  return out;
}

/** The innermost function, type or multi-line value around a line, or null (module level). */
export function symbolAt(symbols, line) {
  let best = null;
  for (const s of symbols ?? []) if (named(s) && s.line <= line && line <= s.end && (!best || s.end - s.line <= best.end - best.line)) best = s;
  return best;
}

const idOf = (path, s) => `${path}#${s ? s.nameLine : 0}`;

/**
 * The symbols of one file that the diff changes: an added line inside it, or a removed line that stood in it.
 * -> [{id, path, name, kind, container, line, end, nameLine, character, isNew, sig: null | {old, now}}]
 * isNew: every line of it is added. sig: a line of its declaration (name to the closing bracket of its parameters)
 * changed; old: the removed line that declared it, when the diff has one.
 */
export function changedSymbols(path, symbols, ch) {
  const hit = new Set();
  for (const l of ch.added) { const s = symbolAt(symbols, l); if (s) hit.add(s); }
  // ponytail: a removed line counts for the symbol around the line after it, else the one before it; a line removed
  // right behind a function's last line is counted for that function.
  for (const r of ch.removed) { if (!r.text.trim()) continue; const s = symbolAt(symbols, r.at) ?? symbolAt(symbols, r.at - 1); if (s) hit.add(s); }
  return [...hit].sort((a, b) => a.line - b.line).map((s) => {
    let isNew = true, declared = false;
    for (let l = s.line; l <= s.end; l++) if (!ch.added.has(l)) { isNew = false; break; }
    for (let l = s.nameLine; l <= s.sigEnd; l++) if (ch.added.has(l)) declared = true;
    const now = (ch.text.get(s.nameLine) ?? "").trim(), word = new RegExp(`(^|[^\\w$])${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`); // the name is the PR's text, never a pattern
    const old = ch.removed.find((r) => word.test(r.text) && /[({=:]|\b(def|func|function|class|fn|interface|struct|enum)\b/.test(r.text))?.text.trim() ?? null;
    // ponytail: a one-line function whose body changed reads as a changed declaration (the line is the declaration).
    const sig = !isNew && declared && old !== now ? { old, now } : null;
    return { id: idOf(path, s), path, name: s.name, kind: s.kind, container: s.container ?? "", line: s.line, end: s.end, nameLine: s.nameLine, character: s.character, isNew, sig };
  });
}

/**
 * One changed symbol with the places that use it -> its callers, one per calling function (or per file for calls at
 * module level): [{id, name, kind, path, line, sites: [{line, text, mark}], mark, test}], the declaration's own
 * lines, imports and re-exports left out. symbols: Map(path -> that file's symbols | undefined when not asked).
 */
export function callersOf(fn, references, symbols, changes) {
  const by = new Map();
  for (const r of references ?? []) {
    if (r.path === fn.path && r.line >= fn.line && r.line <= fn.end) continue; // itself
    if (isImport(r.text ?? "")) continue;
    const ch = changes.get(r.path), s = symbolAt(symbols.get(r.path), r.line);
    let mark = "outside";
    if (ch) { mark = "untouched"; for (let l = r.line; l <= (r.end ?? r.line); l++) if (ch.added.has(l)) mark = "changed"; }
    const id = idOf(r.path, s), c = by.get(id) ?? { id, name: s ? fullName(s) : null, kind: s?.kind ?? "module", path: r.path, line: r.line, sites: [], mark, test: isTestPath(r.path) };
    c.sites.push({ line: r.line, text: r.text ?? "", mark });
    if (mark === "untouched" && c.mark === "changed") c.mark = "untouched"; // one call left as it was is the one to look at
    by.set(id, c);
  }
  const rank = (c) => (c.test ? 3 : 0) + MARK_ORDER.indexOf(c.mark);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * The changed functions that only follow another one: every line this PR adds in them is a call to a function that
 * existed before and changed too (total(items) became total(items, rate)). They are callers with the mark "changed",
 * not changed functions of their own: their callers are not asked about. -> Set of ids
 * refs: Map(id -> {references}) of every changed symbol.
 */
export function adaptedOnly(changed, refs, changes) {
  const pass = (skip) => new Set(changed.filter((f) => {
    if (f.isNew || f.sig) return false;
    const ch = changes.get(f.path), inside = (l) => l >= f.line && l <= f.end, lines = [...ch.added].filter(inside);
    // ponytail: more lines removed than added means something else went too; then it stays a changed function.
    if (!lines.length || ch.removed.filter((r) => r.text.trim() && inside(r.at)).length > lines.length) return false;
    const spans = changed.filter((g) => g !== f && !g.isNew && !skip.has(g.id)).flatMap((g) => (refs.get(g.id)?.references ?? [])
      .filter((r) => r.path === f.path && inside(r.line) && !isImport(r.text ?? "")).map((r) => [r.line, r.end ?? r.line]));
    return lines.every((l) => spans.some(([a, b]) => l >= a && l <= b));
  }).map((f) => f.id));
  return pass(pass(new Set())); // one that follows a function that itself only follows stays a changed function
}

/**
 * Asks the bridge and builds the model. call(endpoint, body) -> the bridge's answer (defs.js call); hunks: the PR's
 * (pr.js hunksOf with rows); supported(path): whether a language server exists for it; infra(path): an infrastructure
 * file, left out (counted in model.infra); onStep(done, of).
 * -> {status: "ok", model} | {status: "starting" | "error", message}. Never throws for a bridge answer.
 * model: {v, servers: [names], uncovered: [{ext, files}], failed: [messages], functions: [{...changedSymbols' fields,
 *   callers, outside: uses outside the checkout, more: uses past the bridge's limit, error}], skipped, ms}
 */
export async function computeImpact({ call, root, hunks, supported, infra = () => false, limits = LIMITS, now = Date.now, onStep = () => {} }) {
  const t0 = now(), changes = fileChanges(hunks), symbols = new Map(), servers = new Set(), failed = new Set(), noServer = new Map();
  const late = () => now() - t0 > limits.MS;
  // A file's symbols, asked once: a list, or undefined when there is no server for it or the server failed.
  const symbolsOf = async (path) => {
    if (symbols.has(path)) return { status: "ok" };
    if (!supported(path)) { symbols.set(path, undefined); return { status: "unsupported" }; }
    const r = await call("/symbols", { root, path });
    if (r.status === "starting") return r;
    if (r.status === "ok") { symbols.set(path, r.symbols ?? []); if (r.server) servers.add(r.server); }
    else { symbols.set(path, undefined); if (r.status === "unsupported") return r; failed.add(r.message || `The language server did not answer for ${path}`); }
    return r;
  };
  const changed = [];
  let infraFiles = 0;
  for (const [path, ch] of changes) {
    if (!ch.added.size && !ch.removed.length) continue;
    if (infra(path)) { infraFiles++; continue; }
    if (!supported(path)) { noServer.set(ext(path), (noServer.get(ext(path)) ?? 0) + 1); continue; }
    const r = await symbolsOf(path);
    if (r.status === "starting") return { status: "starting", message: r.message };
    if (symbols.get(path) && !isTestPath(path)) changed.push(...changedSymbols(path, symbols.get(path), ch)); // a changed test has no callers to follow
  }
  // What existed before goes first (its callers were written against the old code), a changed declaration ahead.
  const order = (f) => (f.isNew ? 2 : f.sig ? 0 : 1), asked = [...changed].sort((a, b) => order(a) - order(b)).slice(0, limits.ASK), refs = new Map();
  let done = 0, skipped = changed.length - asked.length;
  for (const fn of asked) {
    onStep(done++, asked.length);
    if (late()) { skipped++; continue; }
    const r = await call("/references", { root, path: fn.path, line: fn.nameLine, character: fn.character });
    if (r.status === "starting") return { status: "starting", message: r.message };
    refs.set(fn.id, r.status === "ok" ? { ...r, references: (r.references ?? []).filter((x) => !infra(x.path)) } : { references: [], error: r.message || r.status });
  }
  const files = [...new Set([...refs.values()].flatMap((r) => (r.references ?? []).map((x) => x.path)))].filter((p) => !symbols.has(p)).slice(0, limits.FILES);
  for (const path of files) { if (late()) break; const r = await symbolsOf(path); if (r.status === "starting") return { status: "starting", message: r.message }; }
  const adapted = adaptedOnly(changed, refs, changes);
  const functions = changed.filter((fn) => refs.has(fn.id) && !adapted.has(fn.id)).map((fn) => { const r = refs.get(fn.id);
    return { ...fn, callers: callersOf(fn, r.references, symbols, changes), outside: r.outside ?? 0, more: r.more ?? 0, ...(r.error ? { error: r.error } : {}) }; })
    .filter((fn) => !fn.isNew || fn.callers.some((c) => c.mark !== "changed"))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  if (!servers.size && failed.size && !functions.length) return { status: "error", message: [...failed][0] };
  return { status: "ok", model: { v: MODEL_V, infra: infraFiles, servers: [...servers].sort(), uncovered: [...noServer].map(([e, n]) => ({ ext: e, files: n })).sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext)),
    failed: [...failed], functions, skipped, ms: now() - t0 } };
}

/** Counts over the model: changed functions, callers (each calling function once; tests apart, and a changed
 *  function that calls another one is no caller here, it is a card of its own) per mark, the ones that call a changed
 *  declaration with an unchanged call (risky), test callers. */
export function impactTotals(model) {
  const seen = new Map(), tests = new Set(), centre = new Set((model?.functions ?? []).map((f) => f.id));
  for (const fn of model?.functions ?? []) for (const c of fn.callers) {
    if (c.test) { tests.add(c.id); continue; }
    if (centre.has(c.id)) continue;
    const x = seen.get(c.id) ?? { mark: c.mark, risky: false };
    if (MARK_ORDER.indexOf(c.mark) < MARK_ORDER.indexOf(x.mark)) x.mark = c.mark;
    if (fn.sig && c.mark !== "changed") x.risky = true;
    seen.set(c.id, x);
  }
  const of = (m) => [...seen.values()].filter((x) => x.mark === m).length;
  return { functions: (model?.functions ?? []).length, callers: seen.size, outside: of("outside"), untouched: of("untouched"), changed: of("changed"),
    risky: [...seen.values()].filter((x) => x.risky).length, tests: tests.size };
}

// "functions" when every changed symbol is one, else "symbols" (classes, tables).
const noun = (model) => ((model?.functions ?? []).every((f) => FUNC.has(f.kind)) ? "function" : "symbol");
/** "n tests call it" for a changed function's card. */
export const testsLine = (fn) => { const n = fn.callers.filter((c) => c.test).length; return n ? `${plural(n, "test")} ${n === 1 ? "calls" : "call"} it` : "no test calls it"; };

/** The lines over the picture: {title, source: where it is from and what it does not know, lead: what it says}. */
export function impactLines(model) {
  const T = impactTotals(model), n = noun(model), outside = (model.functions ?? []).reduce((s, f) => s + (f.outside ?? 0), 0), more = (model.functions ?? []).reduce((s, f) => s + (f.more ?? 0), 0);
  const errors = [...new Set((model.functions ?? []).filter((f) => f.error).map((f) => f.error))];
  const source = [
    model.servers?.length ? `Callers the language server found (${model.servers.join(", ")}), direct ones only.` : null,
    model.servers?.length ? "Dynamic calls, reflection, removed functions, other repositories and languages without a server are not in it." : null,
    model.uncovered?.length || model.infra ? `Not covered: ${[model.uncovered?.length && `${plural(model.uncovered.reduce((s, u) => s + u.files, 0), "file")} without a language server (${model.uncovered.map((u) => (u.ext ? `.${u.ext}` : "no extension")).join(", ")})`,
      model.infra && `${plural(model.infra, "infrastructure file")}: see Infrastructure changes`].filter(Boolean).join("; ")}.` : null,
    ...(model.failed ?? []), ...errors.map((e) => `A search did not finish: ${e}`),
    model.skipped ? `${plural(model.skipped, `changed ${n}`)} ${model.skipped === 1 ? "was" : "were"} not asked for callers (limit reached).` : null,
    outside ? `${plural(outside, "use")} outside the checkout or in vendored code ${outside === 1 ? "is" : "are"} not shown.` : null,
    more ? `${plural(more, "more use")} past the limit per ${n} ${more === 1 ? "is" : "are"} not shown.` : null].filter(Boolean);
  const lead = !T.functions ? (model.servers?.length ? "This PR changes no function or class that existed before, and nothing outside the diff uses what it adds." : "No language server covers the files of this PR.")
    : !T.callers ? `The language server found no caller of the changed ${n}${T.functions === 1 ? "" : "s"}${T.tests ? " outside the tests" : ""}.`
      : T.outside ? `${plural(T.outside, "caller")} of the changed code ${T.outside === 1 ? "is" : "are"} not in this PR.${T.risky ? ` ${T.risky === 1 ? "One caller keeps" : `${T.risky} callers keep`} an unchanged call to a ${n} whose signature changed.` : ""}`
        : `Every caller the language server found is in this PR's diff.${T.untouched ? ` ${T.untouched === 1 ? "One of them has" : `${T.untouched} of them have`} a call this PR does not touch.` : ""}${T.risky ? ` ${T.risky === 1 ? "One caller keeps" : `${T.risky} callers keep`} an unchanged call to a ${n} whose signature changed.` : ""}`;
  return { title: "Impact", dense: isDense(model) ? denseText() : null, counts: `${plural(T.functions, `changed ${n}`)}, ${plural(T.callers, "caller")}, ${plural(T.tests, "test")}`, source, lead, totals: T };
}

/**
 * The model as cards and calls for arch.js archLayout: the changed functions in one frame, their callers (tests
 * aside) in a frame per mark, a call from each caller to what it calls. A card has `rows` [{glyph, text, tip, tone}]
 * (drawn under its text; the layout keeps a line each) and `at` (path:line, the click's place). Its place is its first
 * row, the file's name with the line and never wrapped (the whole path is the row's tooltip): as the description a
 * long path was broken in the middle of the file's name. Only for a model that is not dense (isDense): with many
 * callers there is no picture, so nothing here sums cards up. -> {groups, nodes, edges}
 */
export function impactArch(model) {
  const fns = model?.functions ?? [], centre = new Set(fns.map((f) => f.id)), callers = new Map();
  const place = (path, line, more = "") => ({ glyph: "", text: `${base(path)}:${line}${more}`, tone: "muted", tip: `${path}:${line}`, place: true });
  for (const fn of fns) for (const c of fn.callers) {
    if (c.test || centre.has(c.id)) continue; // a changed function that calls another one is its own card
    const b = callers.get(c.id) ?? { c, mark: c.mark, to: new Set(), risky: false };
    if (MARK_ORDER.indexOf(c.mark) < MARK_ORDER.indexOf(b.mark)) b.mark = c.mark;
    b.to.add(fn.id); if (fn.sig && c.mark !== "changed") b.risky = true;
    callers.set(c.id, b);
  }
  const nodes = fns.map((fn) => ({ id: fn.id, label: fullName(fn), description: "", group: "changed", status: fn.isNew ? "new" : "changed", type: fn.kind, at: `${fn.path}:${fn.nameLine}`,
    rows: [place(fn.path, fn.nameLine), fn.sig && { glyph: SIG.glyph, text: "signature changed", tone: "warn", tip: fn.sig.old ? `Before: ${fn.sig.old}\nNow: ${fn.sig.now}` : `Now: ${fn.sig.now}` },
      { glyph: "", text: testsLine(fn), tone: "muted" },
      !fn.callers.some((c) => !c.test) && { glyph: "", text: fn.callers.length ? "no other caller found" : "no caller found", tone: "muted" }].filter(Boolean) }));
  const edges = [];
  for (const fn of fns) for (const c of fn.callers) if (!c.test && centre.has(c.id) && c.id !== fn.id) edges.push({ from: c.id, to: fn.id });
  for (const { c, mark, to, risky } of callers.values()) {
    nodes.push({ id: `c:${c.id}`, group: `m:${mark}`, type: c.kind, at: `${c.path}:${c.line}`, label: c.name ?? `${base(c.path)}, top level`, description: "",
      evidence: c.sites.map((x) => `${x.line}: ${x.text}`).join("\n"),
      rows: [place(c.path, c.line, c.sites.length > 1 ? ` and ${plural(c.sites.length - 1, "more call")}` : ""), { glyph: MARKS[mark].glyph, text: MARKS[mark].word, tone: mark === "outside" ? "strong" : "muted", mark }, risky && { glyph: SIG.glyph, text: SIG.word, tone: "warn" }].filter(Boolean) });
    for (const id of to) edges.push({ from: `c:${c.id}`, to: id });
  }
  const groups = [...MARK_ORDER.map((m) => ({ id: `m:${m}`, label: `${MARKS[m].glyph} ${MARKS[m].group}`, kind: String(nodes.filter((n) => n.group === `m:${m}`).length) })),
    { id: "changed", label: `Changed ${noun(model)}s`, kind: String(fns.length) }];
  return { groups, nodes, edges };
}

// ---- many callers: a row per changed symbol instead of a picture

/** The section is rows, not a picture: more changed symbols, callers or calls than a picture with lines can show. */
export function isDense(model) {
  const fns = model?.functions ?? [], centre = new Set(fns.map((f) => f.id)), callers = new Set();
  let calls = 0;
  for (const fn of fns) for (const c of fn.callers) { if (c.test || c.id === fn.id) continue; calls++; if (!centre.has(c.id)) callers.add(c.id); }
  return fns.length > IMPACT_DENSE.symbols || callers.size > IMPACT_DENSE.callers || calls > IMPACT_DENSE.calls;
}
export const denseText = () => `More than ${IMPACT_DENSE.symbols} changed symbols, ${IMPACT_DENSE.callers} callers or ${IMPACT_DENSE.calls} calls: each changed symbol is a row with its callers by file, what stands out first, and no lines are drawn.`;
/**
 * The model for the rows: {symbols, rest, files: Map(caller file -> [{id: a symbol, n: its callers there}])}.
 * symbols: what has a caller that may break or that is not in the PR, or a finding, in this order: a changed signature
 * with a caller that did not change (the most such callers first), then a finding (the worst first), then the most
 * callers outside the PR. A symbol: {id, name, kind, path, base, line, at, isNew, sig, mark: its findings or null,
 * tests, risky: callers that keep an unchanged call to its changed signature, groups: {outside, untouched: {n, files:
 * [{path, base, n, line: of its first caller, callers: [{name, line}]}] the most callers first}}, changed: callers
 * changed in this PR}. rest: the other symbols (no caller outside the PR, nothing that stands out): {id, name, at,
 * inPr: callers in the PR, tests}. Tests are counted, never callers here. Pure.
 */
export function impactDense(model, findings = []) {
  const fns = model?.functions ?? [], marks = impactMarks(model, findings), files = new Map();
  const rows = fns.map((fn) => {
    const real = fn.callers.filter((c) => !c.test && c.id !== fn.id), group = (mark) => {
      const by = new Map();
      for (const c of real.filter((x) => x.mark === mark)) by.set(c.path, [...(by.get(c.path) ?? []), c]);
      return { n: [...by.values()].reduce((k, l) => k + l.length, 0), files: [...by].map(([path, list]) => ({ path, base: base(path), n: list.length, line: list[0].line, callers: list.map((c) => ({ name: c.name ?? "top level", line: c.line })) }))
        .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path)) };
    };
    const groups = { outside: group("outside"), untouched: group("untouched") }, changed = real.filter((c) => c.mark === "changed").length;
    return { id: fn.id, name: fullName(fn), kind: fn.kind, path: fn.path, base: base(fn.path), line: fn.nameLine, at: `${fn.path}:${fn.nameLine}`, isNew: Boolean(fn.isNew), sig: fn.sig ?? null, mark: marks.nodes.get(fn.id) ?? null,
      tests: fn.callers.filter((c) => c.test).length, risky: fn.sig ? groups.outside.n + groups.untouched.n : 0, groups, changed };
  });
  const out = (r) => r.risky > 0 || r.mark || r.groups.outside.n > 0, rank = (r) => (r.risky ? 0 : r.mark ? 1 : 2);
  const symbols = rows.filter(out).sort((a, b) => rank(a) - rank(b) || b.risky - a.risky || (SEV[a.mark?.severity] ?? 9) - (SEV[b.mark?.severity] ?? 9) || b.groups.outside.n - a.groups.outside.n || a.name.localeCompare(b.name));
  for (const r of symbols) for (const g of [r.groups.outside, r.groups.untouched]) for (const f of g.files) files.set(f.path, [...(files.get(f.path) ?? []), { id: r.id, n: f.n }]);
  return { symbols, rest: rows.filter((r) => !out(r)).map((r) => ({ id: r.id, name: r.name, at: r.at, inPr: r.groups.untouched.n + r.changed, tests: r.tests })), files, marks };
}
/** A symbol's row in words, for the Markdown and a tooltip: "signature changed, 5 callers keep the old call; 21 callers not in this PR in 9 files; …". */
export function denseWords(r) {
  const g = (x, word) => (x.n ? `${plural(x.n, "caller")} ${word} in ${plural(x.files.length, "file")}` : null);
  return [r.sig && `signature changed${r.risky ? `, ${plural(r.risky, "caller")} ${r.risky === 1 ? "keeps" : "keep"} the old call` : ""}`, r.isNew && "added", g(r.groups.outside, MARKS.outside.word), g(r.groups.untouched, MARKS.untouched.word),
    r.changed ? `${plural(r.changed, "caller")} ${MARKS.changed.word}` : null, r.tests ? plural(r.tests, "test") : "no test",
    r.mark ? `${r.mark.severity}: ${r.mark.findings.map((f) => f.title).join("; ")}` : null].filter(Boolean).join("; ");
}
/** The other symbols in a sentence: "5 changed symbols have no caller outside this PR: a (3 in the PR), b, c." or "". */
export const restText = (dense, model) => (dense.rest.length ? `${plural(dense.rest.length, `changed ${noun(model)}`)} ${dense.rest.length === 1 ? "has" : "have"} no caller outside this PR: ${dense.rest.map((r) => `${r.name}${r.inPr ? ` (${r.inPr} in the PR)` : ""}`).join(", ")}.` : "");
/** A chosen caller file in words: "CartPage.tsx calls 3 of the changed symbols: a (2 callers), b, c." */
export function denseFile(dense, path) {
  const hit = dense.files.get(path) ?? [], name = new Map(dense.symbols.map((r) => [r.id, r.name]));
  return hit.length ? `${base(path)} calls ${hit.length} of the changed symbols: ${hit.map((h) => `${name.get(h.id)}${h.n > 1 ? ` (${h.n} callers)` : ""}`).join(", ")}.` : "";
}

const sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
/** The unresolved findings inside a changed function, as arch.js archMarks gives them: {nodes: Map(card id -> mark), edges}. */
export function impactMarks(model, findings) {
  const nodes = new Map(), fns = model?.functions ?? [];
  for (const f of findings ?? []) {
    const fn = fns.filter((x) => f.file && sameFile(x.path, f.file) && x.line <= (f.line ?? 0) && (f.line ?? 0) <= x.end).sort((a, b) => (a.end - a.line) - (b.end - b.line))[0];
    if (!fn) continue;
    const m = nodes.get(fn.id) ?? { findings: [], n: 0, breaks: 0, severity: f.severity };
    m.findings.push(f); m.n++;
    if ((SEV[f.severity] ?? 9) < (SEV[m.severity] ?? 9)) m.severity = f.severity;
    nodes.set(fn.id, m);
  }
  return { nodes, edges: new Map() };
}

/** Every caller and test as a row, for the list under the picture and the Markdown table:
 *  [{fn, caller | null, name, at, mark, words: what the row says about the caller}] */
export function impactRows(model) {
  return (model?.functions ?? []).flatMap((fn) => (fn.callers.length ? fn.callers.map((c) => ({ fn, caller: c, name: `${c.name ?? "top level"}${c.test ? " (test)" : ""}`,
    at: `${c.path}:${c.sites.map((s) => s.line).join(", ")}`, mark: c.mark, words: [MARKS[c.mark].word, fn.sig && c.mark !== "changed" && SIG.word].filter(Boolean).join("; ") }))
    : [{ fn, caller: null, name: "no caller found", at: "", mark: null, words: "" }]));
}

/** The section of the page's Markdown: {title, lines, head, rows (a table), flow (cards and calls for a flowchart)}. */
export function impactDoc(model, findings = []) {
  const L = impactLines(model), T = L.totals, dense = L.dense ? impactDense(model, findings) : null, a = dense ? { groups: [], nodes: [], edges: [] } : impactArch(model), marks = impactMarks(model, findings);
  const fnCell = (fn) => `\`${fullName(fn)}\` (\`${fn.path}:${fn.nameLine}\`)${fn.isNew ? ", added" : ""}${fn.sig ? ", signature changed" : ""}, ${testsLine(fn)}${marks.nodes.get(fn.id) ? `, ${marks.nodes.get(fn.id).severity}: ${marks.nodes.get(fn.id).findings.map((f) => f.title).join("; ")}` : ""}`;
  return { title: `${L.title} (${L.counts})`,
    lines: [...L.source, "", L.lead, "",
      ...(T.callers ? [`Callers by mark: ${MARK_ORDER.map((m) => `${MARKS[m].word}: ${T[m]}`).join(" · ")}${T.risky ? ` · ${SIG.word}: ${T.risky}` : ""}.`, ""] : []),
      // Many callers: what the page's rows say, in the same order, and no flowchart (the table below has every caller).
      ...(dense ? [L.dense, "", ...dense.symbols.map((r) => `- \`${r.name}\` (\`${r.at}\`): ${denseWords(r)}`), ...(dense.rest.length ? ["", restText(dense, model)] : []), ""] : [])],
    head: [`Changed ${noun(model)}`, "Caller", "File:line", "Mark"],
    rows: impactRows(model).map((r) => [fnCell(r.fn), r.caller ? `\`${r.name}\`` : r.name, r.at ? `\`${r.at}\`` : "", r.words]),
    flow: { groups: a.groups.map((g) => ({ id: g.id, label: g.label.replace(/^[◆◐○] /, "") })), edges: a.edges,
      nodes: a.nodes.map((n) => ({ id: n.id, group: n.group, status: n.status, label: [n.label, ...n.rows.map((r) => (r.place ? r.tip : r.text))].join(" · ") })) } };
}
