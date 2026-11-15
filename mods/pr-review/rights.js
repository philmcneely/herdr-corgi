// The Security page's picture "Who may do what": who may do which action on which resource, and what of that this PR
// changes. A table, not a map: a row per principal (a role, a function, a pipeline, an operator, anyone on the
// internet), a column per resource (the card a right sits on, else the resource's own name), a cell with the actions
// and what the PR does to them (added, widened, narrowed, removed, unchanged; a shape and a word). A rule that takes a
// right away (pr.js isGuard) is no right: it stands as a guard in the cell it protects. Pure: the security run's
// access rows → the table (rightsOf) → what is open of it (rightsShown) → Markdown (rightsMd).
//
// Nothing is guessed: the rows are the run's access rows as they are; a change the run does not say is "not said".
import { isGuard } from "./pr.js";

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const nameKey = (s) => flat(s).toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");

// What this PR does to a right, as a shape and a word (never a color alone). null: the run does not say.
export const CHANGE = { added: ["+", "added"], widened: ["▲", "widened"], narrowed: ["▼", "narrowed"], removed: ["−", "removed"], unchanged: ["=", "unchanged"] };
export const NOT_SAID = ["?", "not said"];
export const GUARD = ["⛨", "guard"];
// Open at most this much; beyond it the rows and columns this PR leaves alone are folded behind a counter.
export const MAX = { cols: 8, rows: 12 };
export const NOTE = "From the policies and calls this run read; conditions and policies outside the diff may change the result.";
const WHO = ["internet", "operator", "ci", "role"]; // from the most exposed inwards, as the run's principal kinds

// An action as the cell says it. "*" and "sqs:*" are every action (of a service): said in words and marked; a pattern
// ("s3:Get*") is marked as one. A guard's "deny …" loses the word: the cell says "guard".
export function actionOf(a) {
  const s = flat(a).replace(/^(deny|denies|block|blocks)\s+/i, ""), all = /^(\*|[\w-]+:\*)$/.test(s);
  return { text: all ? `${s} (all actions)` : s.includes("*") ? `${s} (wildcard)` : s, wild: all ? "all" : s.includes("*") ? "some" : null };
}

// access: the security run's rows; arch: the picture (a row's `node` is its column when the picture has that card);
// crossings: views.js crossingsOf's rows (a cell names its crossing's number and carries that crossing's findings);
// findings: the unresolved ones (a finding that names the row in reachable_from hangs at its cell too).
// → null without rows, else {rows: [{key, name, kind, changed}], cols: [{key, name, kinds, node, wild, changed}],
//   cells: Map("row\0col" → [entry]), total, line, note}; entry: {id, guard, actions: [{text, wild}], change, mark:
//   [shape, word], unused, holds, loosened, at, resource, auth, crossing: its number or null, crossKey, findings}.
export function rightsOf({ arch = null, access = [], crossings = [], findings = [] } = {}) {
  const list = (access ?? []).filter((x) => x && (flat(x.principal) || flat(x.resource)));
  if (!list.length) return null;
  const card = (id) => (arch?.nodes ?? []).find((n) => n.id === id) ?? null;
  const changeOf = (x) => { const c = x.change ?? (x.opened_by_pr === true ? "added" : x.opened_by_pr === false ? "unchanged" : null); return CHANGE[c] ? c : null; };
  const rows = new Map(), cols = new Map(), cells = new Map(), entries = [];
  for (const x of list) {
    const guard = isGuard(x), change = changeOf(x), moved = change !== "unchanged", every = /^(\*|all resources)$/i.test(flat(x.resource)), on = card(x.node);
    const rk = nameKey(x.principal) || "\0", ck = on ? `n:${on.id}` : `r:${nameKey(x.resource)}`;
    if (!rows.has(rk)) rows.set(rk, { key: rk, name: flat(x.principal) || "not named", kind: WHO.includes(x.principal_kind) ? x.principal_kind : null, changed: false });
    if (!cols.has(ck)) cols.set(ck, { key: ck, name: every ? "* (all resources)" : flat(on?.label) || flat(x.resource) || "not named", kinds: [], node: on?.id ?? null, wild: every, changed: false });
    const row = rows.get(rk), col = cols.get(ck), kind = flat(x.kind);
    if (kind && !col.kinds.includes(kind)) col.kinds.push(kind);
    row.changed ||= moved; col.changed ||= moved;
    const k = (crossings ?? []).findIndex((r) => r.key === `a:${x.id ?? x.resource}` || (r.aliases ?? []).includes(`a:${x.id ?? x.resource}`));
    const fs = [...new Set([...(k >= 0 ? crossings[k].findings ?? [] : []), ...(findings ?? []).filter((f) => x.id && (f.reachable_from ?? []).includes(x.id))])];
    const entry = { id: x.id ?? `${rk}|${ck}|${entries.length}`, guard, actions: (x.actions ?? []).map(actionOf), change, mark: CHANGE[change] ?? NOT_SAID, unused: !guard && x.used === false,
      holds: guard ? flat(x.holds_against) || null : null, loosened: guard && ["narrowed", "removed"].includes(change), at: flat(x.at) || null, resource: flat(x.resource), auth: flat(x.auth) || null,
      crossing: k >= 0 ? k + 1 : null, crossKey: k >= 0 ? crossings[k].key : null, findings: fs, row: rk, col: ck };
    entries.push(entry);
    cells.set(`${rk}\0${ck}`, [...(cells.get(`${rk}\0${ck}`) ?? []), entry]);
  }
  const first = (m) => [...m.values()].map((v, k) => [v, k]);
  const rank = (r) => (WHO.includes(r.kind) ? WHO.indexOf(r.kind) : WHO.length);
  const sortedRows = first(rows).sort(([a, i], [b, j]) => Number(b.changed) - Number(a.changed) || rank(a) - rank(b) || i - j).map(([v]) => v);
  const sortedCols = first(cols).sort(([a, i], [b, j]) => Number(b.changed) - Number(a.changed) || i - j).map(([v]) => v);
  // The line a folded section says: what the PR does to the rights, the ones with every action, and the guards.
  const grants = entries.filter((e) => !e.guard), guards = entries.filter((e) => e.guard), n = (c) => grants.filter((e) => e.change === c).length;
  const wild = grants.filter((e) => e.change !== "removed" && e.actions.some((a) => a.wild === "all")).length, loose = guards.filter((e) => e.loosened).length, unsaid = grants.filter((e) => e.change === null).length;
  const moved = [n("added") && `${plural(n("added"), "right")} added`, n("widened") && `${n("widened")} widened`, n("narrowed") && `${n("narrowed")} narrowed`, n("removed") && `${n("removed")} removed`].filter(Boolean);
  const line = [moved.length ? moved.join(", ") : grants.length ? "no right changed by this PR" : "no right named", unsaid && `${unsaid} with its change not said`, wild && `${wild} with all actions`,
    guards.length && `${plural(guards.length, "guard")}${loose ? `, ${loose} narrowed or removed` : ""}`].filter(Boolean).join(", ");
  return { rows: sortedRows, cols: sortedCols, cells, total: grants.length, guards: guards.length, line, note: NOTE };
}
export const cellOf = (m, row, col) => m.cells.get(`${row.key}\0${col.key}`) ?? [];

// What of the table is open: all of it while it is small (or `all`); else the rows and columns this PR changes, at
// most MAX of each, and a line that counts the rest. → {rows, cols, more: hidden cells' rights, moreLine or null}.
export function rightsShown(m, all = false) {
  const small = m.rows.length <= MAX.rows && m.cols.length <= MAX.cols;
  if (all || small) return { rows: m.rows, cols: m.cols, more: 0, moreLine: null };
  const pick = (list, max) => { const ch = list.filter((x) => x.changed); return (ch.length ? ch : list).slice(0, max); };
  const rows = pick(m.rows, MAX.rows), cols = pick(m.cols, MAX.cols), r = m.rows.length - rows.length, c = m.cols.length - cols.length;
  return { rows, cols, more: r + c, moreLine: `${listOf([r && plural(r, "more principal"), c && plural(c, "more resource")].filter(Boolean))} ${r && c ? "are" : r + c === 1 ? "is" : "are"} folded: this PR ${r && c ? "changes nothing there or they did not fit" : "changes nothing there or it did not fit"}.` };
}

// A cell's entry in words, for the Markdown table and a tooltip: "+ added: sqs:SendMessage (crossing 2, granted and
// not used, template.yaml:21)", "⛨ guard, + added: denies sqs:SendMessage. Holds against: …".
export function entryText(e, code = (s) => s) {
  const acts = e.actions.map((a) => a.text).join(", ") || (e.guard ? "access" : "not named");
  const tail = [e.crossing && `crossing ${e.crossing}`, e.unused && "granted and not used", e.at && code(e.at)].filter(Boolean).join(", ");
  return e.guard ? `${GUARD.join(" ")}, ${e.mark.join(" ")}: denies ${acts}${tail ? ` (${tail})` : ""}.${e.holds ? ` Holds against: ${e.holds.replace(/\.$/, "")}.` : ""}${e.loosened ? " This PR loosens it." : ""}`
    : `${e.mark.join(" ")}: ${acts}${tail ? ` (${tail})` : ""}`;
}
// The unresolved findings that hang at a cell, one line per cell: counted by severity, and where they stand in full
// (the crossing of that number; a cell without a crossing names them here).
export function rightsFindings(m) {
  const SEV = ["critical", "high", "medium", "low"], sev = (fs) => SEV.map((k) => [fs.filter((f) => f.severity === k).length, k]).filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(", ");
  return m.rows.flatMap((r) => m.cols.map((c) => { const es = cellOf(m, r, c), fs = [...new Set(es.flatMap((e) => e.findings))], at = [...new Set(es.filter((e) => e.findings.length).map((e) => e.crossing).filter(Boolean))];
    return fs.length ? `${r.name} on ${c.name}: ${plural(fs.length, "unresolved finding")}${sev(fs) ? ` (${sev(fs)})` : ""}${at.length ? `, listed at crossing ${listOf(at)}` : `: ${fs.map((f) => flat(f.title)).join("; ")}`}` : null; }).filter(Boolean));
}

// The section of Copy as Markdown: the whole table (nothing folded) and the findings at its cells. [] without a model.
export function rightsMd(m) {
  if (!m) return [];
  const cell = (s) => flat(s).replace(/\|/g, "\\|") || "–", at = rightsFindings(m);
  const head = ["Who", ...m.cols.map((c) => `${c.name}${c.kinds.length ? ` (${c.kinds.join(", ")})` : ""}`)];
  return [`## Who may do what (${m.total})`, "", `${m.line[0].toUpperCase()}${m.line.slice(1)}.`, "", m.note, "",
    `| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
    ...m.rows.map((r) => `| ${[`${r.name}${r.kind ? ` (${r.kind})` : ""}`, ...m.cols.map((c) => cellOf(m, r, c).map((e) => entryText(e, (s) => `\`${s}\``)).join("; "))].map(cell).join(" | ")} |`), "",
    ...(at.length ? ["Unresolved findings at a cell:", "", ...at.map((x) => `- ${x}`), ""] : [])];
}
