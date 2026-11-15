// The review as Markdown, to copy and hand to an agent or a person ("Copy this page as Markdown"): the Overview, a
// finding or all unresolved ones, a layer, the architecture and the Security page. Pure: each function takes the
// analysis as review.js holds it (pr.js mapReview), the merged findings (pr.js mergeFindings) and their states, and
// returns text that starts with the PR and commit it is about. Pictures are Mermaid: an agent reads it as text and
// GitHub draws it. A security finding is in here in full: this is for the person's own use, nothing is posted.
import { taskList, taskHead, verdictParts, findingCounts, componentLine, CERTAINTY, SEVERITY_SCALE, levels, isGuard, secOldLine } from "./pr.js";
import { transitionText } from "./arch.js";
import { langOf } from "./syntax.js";
import { resPathView, asideOf, threatCited, skipText, guardLine } from "./views.js";
import { resWord, resToolText, resVerdict, resWatch } from "./views.js"; // wave R2: the page's words, verdict and watch list
// The pages' own sources, so a page and its Markdown say the same: the crossings and their picture, the scope table,
// the map as the Architecture page draws it, the paths' order and verdict, a finding's facts.
import { crossingsOf, crossingChanged, secSentence, wayOf, wayText, secPicture, secBlast, scopeTable, scopeConflicts, AREA_NAME, mapArch, resVerdictParts, resCardOf, factRows } from "./views.js";
import { archMarks } from "./arch.js";
import { transitionMarks, surfaceOf, reachLevel, secOrder, EXPOSURE, inProcess, resNoPicture, resShown, probeBaseWord, datedByDiff } from "./views.js";
import { doesList, surfaceLine, countLine, funnelShort, funnel as funnelOf, findingSteps } from "./pr.js";
import { resDepRows } from "./views.js"; // Resilience: dependencies that fail or are overloaded
import { rightsOf, rightsMd } from "./rights.js"; // Security: the table "Who may do what"
import { dataflowOf, dataflowMd } from "./dataflow.js"; // Security: "Where sensitive data goes"
import { timelineOf, timelineMd } from "./timeline.js"; // Resilience: the picture "Timing"
import { faultTrees, faultFlow, FAULT_NOTE } from "./faulttree.js"; // Resilience: what follows from a dependency's case, as a tree
import { schemaMd } from "./schema.js"; // the Architecture page's "Schema changes"
import { impactDoc } from "./impact.js"; // the Architecture page's Impact section
import { infraMd } from "./infra.js"; // the Architecture page's "Infrastructure changes"

const STATE = { open: "Unresolved", progress: "Fix sent", fixed: "Fixed", dismissed: "Dismissed", recheck: "Unresolved, line changed" };
const SOURCE = { analysis: "Analysis", security: "Security review", claude: "Claude code review", codex: "Codex review", resilience: "Resilience review", ai: "AI note" };
const ASK = { met: "met", partly: "partly", broken: "broken", not_done: "not done", extra: "extra" };
const KIND = { architecture: "Architecture", flow: "Flow", sequence: "Sequence", state_machine: "State diagram", steps: "Steps" };
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const unresolved = (st) => st !== "fixed" && st !== "dismissed";
const flat = (s) => String(s ?? "").replace(/[\u0000-\u001f\s]+/g, " ").trim();
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The parts of a text, nested as they come; "" is a blank line, false and null are left out (so a condition on a
// string that may be empty is written Boolean(x) && …).
const doc = (...parts) => `${parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false).join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;

// ---- code context: the lines a place names, as the review holds them (no new fetches)

const LANG = { py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx", json: "json", yaml: "yaml", yml: "yaml", sh: "bash", rs: "rust", go: "go",
  java: "java", kt: "kotlin", rb: "ruby", tf: "hcl", toml: "toml", sql: "sql", html: "html", css: "css", md: "markdown", ini: "ini", cfg: "ini", editorconfig: "ini" };
// A fence's language: by the ending, else what the highlighter makes of the name or of the file's first line ("#!/bin/sh"
// in bin/release, .envrc, a Git hook), so a script without an ending is fenced as bash.
const FENCE = { shell: "bash", js: "javascript", make: "makefile", workflow: "yaml", spring: "yaml" }; // the highlighter's names that a fence spells otherwise
export const fenceLang = (file, first = "") => { const name = String(file).split("/").pop(), l = langOf(String(file), first); return LANG[name.split(".").pop()] ?? FENCE[l] ?? l ?? ""; };
export const CODE_MAX = 12; // lines of one block
const CODE_PAD = 2; // lines around the place
// A file's rows by its path, also by the end of it ("mailer.py:14" in a path step): Map(path -> rows) -> rowsOf(file).
export function rowsByPath(map) {
  return (file) => { const hit = map.has(file) ? [file] : [...map.keys()].filter((p) => p.endsWith(`/${file}`)); return hit.length === 1 ? { path: hit[0], rows: map.get(hit[0]) } : null; };
}
// The code blocks of one text. rowsOf(file): {path: the file's whole path, rows: its rows ({kind: "+" | "-" | " ", n:
// the new line number, text}; pr.js diffRows, or the whole file where the review has loaded it)}, or null when the
// review holds no line of it; rowsOf null: no code context at all.
// block(file, line, end): the place's lines with two lines around, at most CODE_MAX, under "Code `file:a-b`:" in a
// fence (```diff with + and - marks when the lines changed, else the file's language). A place already shown says
// where ("see above") instead of a second block; a place the review holds no line of gives nothing. at("file:12-20")
// is the same from a place's text. stats: {blocks, lines} so far.
export function codeContext(rowsOf) {
  const shown = new Map(), stats = { blocks: 0, lines: 0 };
  const block = (named, line, end = line, pad = CODE_PAD) => {
    if (!rowsOf || !named || !(line > 0)) return [];
    const got = rowsOf(named), file = got?.path ?? named;
    const hi = Math.max(line, Number(end) || line), rows = (got?.rows ?? []).filter((r) => r.kind === "+" || r.kind === "-" || r.kind === " ");
    const n = (r) => r.n ?? null, inside = (r) => n(r) !== null && n(r) >= line && n(r) <= hi;
    if (!rows.some(inside)) return [];
    const seen = (shown.get(file) ?? []).find(([a, b]) => a <= line && hi <= b);
    if (seen) return [`Code: see \`${file}:${seen[0]}-${seen[1]}\` above.`, ""];
    let first = rows.findIndex((r) => n(r) !== null && n(r) >= line - pad), last = rows.findLastIndex((r) => n(r) !== null && n(r) <= hi + pad);
    while (first > 0 && rows[first - 1].kind === "-") first--; // the lines this place replaced
    const all = rows.slice(first, last + 1), part = all.slice(0, CODE_MAX), nums = part.map(n).filter((x) => x !== null), a = nums[0], b = nums.at(-1);
    if (a === undefined) return [];
    const same = (shown.get(file) ?? []).find(([x, y]) => x <= a && b <= y); // the lines it would show are shown already (a range that reaches past the diff)
    if (same) return [`Code: see \`${file}:${same[0]}-${same[1]}\` above.`, ""];
    // Lines the review does not hold between two hunks: said in the block, so no line seems to follow the other.
    const gap = (k) => k > 0 && n(part[k]) !== null && n(part[k - 1]) !== null && n(part[k]) - n(part[k - 1]) > 1;
    const diff = part.some((r) => r.kind !== " "), lines = part.flatMap((r, k) => [...(gap(k) ? [diff ? `@@ line ${n(r)} @@` : "…"] : []), (diff ? `${r.kind}${r.text}` : r.text).replace(/\s+$/, "")]), tick = lines.some((l) => l.includes("```")) ? "````" : "```";
    shown.set(file, [...(shown.get(file) ?? []), [a, b]]); stats.blocks++; stats.lines += lines.length;
    return [`Code \`${file}:${a}-${b}\`:`, "", `${tick}${diff ? "diff" : fenceLang(file, rows.find((r) => r.n === 1)?.text)}`, ...lines, tick, all.length > part.length && `(${all.length - part.length} more ${all.length - part.length === 1 ? "line" : "lines"} of this place not shown.)`, ""];
  };
  const at = (place, pad) => { const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(String(place ?? "").trim()); return m ? block(m[1], Number(m[2]), Number(m[3] ?? m[2]), pad) : []; };
  return { block, at, stats, on: Boolean(rowsOf) };
}
// "Code context (3 blocks, 28 lines)" of a finished text: counted from the blocks' own head lines.
export function codeStats(text) {
  const lines = String(text ?? "").split("\n"), out = { blocks: 0, lines: 0 };
  lines.forEach((l, i) => { if (!/^Code `[^`]+:\d+-\d+`:$/.test(l)) return; out.blocks++; let k = i + 2; const tick = /^`+/.exec(lines[k] ?? "")?.[0]; if (!tick) return; for (k++; k < lines.length && lines[k] !== tick; k++) out.lines++; });
  return out;
}

// ---- a text in parts, for the preview before copying: its head (the PR line, the title and what stands before the
// first "## " heading) and one part per "## " heading with its line count; mdJoin leaves the parts in `off` out.
// → {head: [lines], parts: [{title, lines, n}]}. A "## " inside a code fence is no heading.
export function mdParts(text) {
  const head = [], parts = [];
  let cur = null, fence = null;
  for (const l of String(text ?? "").replace(/\n+$/, "").split("\n")) {
    const tick = /^\s*(`{3,})/.exec(l)?.[1];
    if (tick && (!fence || tick.length >= fence.length)) fence = fence ? null : tick;
    if (!fence && /^## /.test(l)) { cur = { title: l.slice(3).trim(), lines: [l] }; parts.push(cur); } else (cur ? cur.lines : head).push(l);
  }
  for (const p of parts) p.n = mdLines(p.lines);
  return { head, parts };
}
// The preview's one way to count (acceptance, UX 2): the lines with text. A part's size, the head's and the whole
// text's are counted so, and the sizes of the parts kept add up to the size at the foot.
export const mdLines = (x) => (Array.isArray(x) ? x : String(x ?? "").split("\n")).filter((l) => l.trim()).length;
// The head as it is copied. With parts left out, a line under the title names them: the title counts the whole page
// ("28 unresolved findings: 17 high, 11 medium") and would promise findings the text does not have.
export function mdHead({ head, parts }, off = new Set()) {
  const out = parts.filter((_p, k) => off.has(k)).map((p) => p.title);
  if (!out.length) return head;
  const k = head.findIndex((l) => /^# /.test(l)), note = `Left out of this text: ${out.join(", ")}.`;
  return k < 0 ? [...head, "", note] : [...head.slice(0, k + 1), "", note, ...head.slice(k + 1)];
}
export const mdJoin = (doc, off = new Set()) => `${[...mdHead(doc, off), ...doc.parts.filter((_p, k) => !off.has(k)).flatMap((p) => p.lines)].join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;

// "PR owner/repo#2 "title" at commit abc1234 (url)": the first line of every text, so it stands without context.
export const prLine = ({ pr = {}, head = "" }) => `PR ${pr.repo ?? ""}#${pr.number ?? ""} "${flat(pr.title)}"${head ? ` at commit ${String(head).slice(0, 7)}` : ""}${pr.url ? ` (${pr.url})` : ""}`;

// ---- Mermaid

// Text inside a Mermaid diagram: "#35;"-style entity codes for the characters that end a label in that place (Mermaid
// decodes them when it draws), one line. A backtick would start Mermaid's own markdown inside quotes.
const CODE = { "#": "#35;", '"': "#quot;", "<": "#lt;", ">": "#gt;", "|": "#124;", ":": "#58;", ";": "#59;", ",": "#44;", "+": "#43;", "`": "'" };
const ent = (s, chars) => flat(s).replace(chars, (c) => CODE[c]); // one pass: a code's own "#" and ";" stay
const quoted = (s) => ent(s, /[#"<>|`]/g); // inside "…": a node, a group, a call's text, a state's name
const descr = (s) => ent(s, /[#:;<>`]/g); // after "a --> b :" in a state diagram, which ends at a colon or semicolon
const alias = (s) => ent(s, /[#":;,<>+`]/g); // a sequence participant's name
const message = (s) => ent(s, /[#;`]/g); // a sequence message, which ends at a semicolon
const WORDS = new Set(["end", "graph", "flowchart", "subgraph", "class", "classdef", "click", "style", "linkstyle", "default", "direction", "state", "note", "as", "participant", "actor",
  "loop", "alt", "else", "opt", "par", "and", "rect", "activate", "deactivate", "box", "critical", "break", "title", "call", "href", "interpolate"]);
// The picture's own ids where Mermaid takes them as they are (an agent reads "handler", a finding's `breaks` names
// it), else a numbered one: a keyword, a space, a bracket or a name used twice would break the diagram.
function idsOf(nodes, prefix) {
  const plain = (n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n.id) && !WORDS.has(n.id.toLowerCase()), used = new Set(nodes.filter(plain).map((n) => n.id));
  return new Map(nodes.map((n, i) => { let id = n.id; if (!plain(n)) { id = `${prefix}${i}`; while (used.has(id)) id += "_"; used.add(id); } return [n.id, id]; }));
}
// The nodes of a picture, each id once (the first one counts).
const uniq = (nodes) => (nodes ?? []).filter((n, i, all) => n?.id !== undefined && all.findIndex((m) => m?.id === n.id) === i);
const fence = (lines) => ["```mermaid", ...lines, "```"];
const notes = (x, extra = []) => { const l = [...extra, x.source === "spec" && "spec only"].filter(Boolean); return l.length ? ` (${l.join(", ")})` : ""; };
const cardStatus = (x) => (["new", "added"].includes(x.status) ? "new" : ["changed", "removed"].includes(x.status) ? x.status : x.changed ? "changed" : null);

// Cards, groups and calls as a Mermaid flowchart, left to right like the drawn map. A card's status is its class
// (new, changed, removed), a call's is in its text; what is only in the spec is dashed and says so. A call to
// something that is no card gets a card of its own, so no line ends nowhere. When the analysis names trust zones,
// they are the frames ("Internet (trust: public)") instead of the groups, a card without a zone stands outside every
// frame, and a call over a boundary (`crosses`) is a thick line that says so. path: {nodes, edges} (card ids, indexes
// into `edges`) drawn in red, the way from an entry to a finding.
// systems: the frames are the groups (the systems, as the Architecture page draws them) also when there are zones; a
// card then names its zone's trust in its text. marks: arch.js archMarks ({nodes: Map(id -> {n, severity}), edges:
// Map(index -> …)}): the unresolved findings at a card or a call, in its text ("high: 2 findings"). A call with
// `dashed` (a crossing not assessed) is drawn like one from the spec.
export function mermaidFlow({ nodes = [], edges = [], groups = [], zones = [] }, { path = null, systems = false, marks = null } = {}) {
  const all = uniq(nodes), known = new Set(all.map((n) => n.id));
  for (const e of edges) for (const id of [e.from, e.to]) if (id !== undefined && !known.has(id)) { known.add(id); all.push({ id, label: id, outside: true }); }
  const id = idsOf(all, "n"), zs = (zones ?? []).filter((z) => z?.id !== undefined);
  const frames = zs.length && !systems ? zs.map((z, k) => ({ key: `zone${k}`, label: `${z.name ?? z.id}${z.trust ? ` (trust: ${z.trust})` : ""}`, own: (n) => n.zone === z.id }))
    : groups.filter((g) => !g.bare && flat(g.label ?? g.id)).map((g, k) => ({ key: `group${k}`, label: `${g.label ?? g.id}${g.kind ? ` (${g.kind})` : ""}`, own: (n) => n.group === g.id }));
  const mark = (m) => (m ? `${m.severity}: ${count(m.n ?? m.findings?.length ?? 0, "finding")}` : null), trust = (n) => (systems ? zs.find((z) => z.id === n.zone)?.trust : null);
  const card = (n, pad) => `${pad}${id.get(n.id)}["${quoted(n.label ?? n.id)}${notes(n, [trust(n) && `zone: ${trust(n)}`, mark(marks?.nodes?.get(n.id))])}"]${cardStatus(n) ? `:::${cardStatus(n)}` : ""}`;
  const loose = all.filter((n) => !frames.some((f) => f.own(n)));
  const used = new Set(all.map(cardStatus).filter(Boolean));
  const drawn = edges.map((e, k) => [e, k]).filter(([e]) => id.has(e.from) && id.has(e.to)), lit = new Set(path?.edges ?? []), onPath = (path?.nodes ?? []).filter((n) => id.has(n));
  return fence(["flowchart LR",
    ...frames.flatMap((f) => { const own = all.filter(f.own); return own.length ? [`  subgraph ${f.key}["${quoted(f.label)}"]`, ...own.map((n) => card(n, "    ")), "  end"] : []; }),
    ...loose.map((n) => card(n, "  ")),
    ...drawn.map(([e, k]) => {
      const text = `${quoted(transitionText(e))}${notes(e, [cardStatus(e), e.crosses && "crosses a trust boundary", mark(marks?.edges?.get(k))])}`.trim();
      return `  ${id.get(e.from)} ${e.source === "spec" || e.dashed ? "-.->" : e.crosses ? "==>" : "-->"}${text ? `|"${text}"|` : ""} ${id.get(e.to)}`;
    }),
    ...[["new", "stroke:#2da44e,stroke-width:2px"], ["changed", "stroke:#bf8700,stroke-width:2px"], ["removed", "stroke:#cf222e,stroke-dasharray:4 3"]].filter(([k]) => used.has(k)).map(([k, v]) => `  classDef ${k} ${v}`),
    ...(onPath.length ? ["  classDef way fill:#ffebe9,stroke:#cf222e,stroke-width:3px", `  class ${onPath.map((n) => id.get(n)).join(",")} way`] : []),
    ...drawn.map(([, k], i) => lit.has(k) && `  linkStyle ${i} stroke:#cf222e,stroke-width:3px`).filter(Boolean)]);
}

// A state diagram: the start points at the states nothing leads to, the states that lead nowhere end it (as the
// drawn one does). ponytail: states inside a Parallel or Map state are listed flat, not nested.
function mermaidState(v) {
  const nodes = uniq(v.nodes), id = idsOf(nodes, "s"), edges = [...(v.edges ?? []), ...(v.transitions ?? [])].filter((e) => id.has(e.from) && id.has(e.to));
  const moves = edges.filter((e) => e.from !== e.to), roots = nodes.filter((n) => !moves.some((e) => e.to === n.id)), sinks = nodes.filter((n) => !moves.some((e) => e.from === n.id));
  return fence(["stateDiagram-v2",
    ...nodes.map((n) => `  state "${quoted(n.label ?? n.id)}${notes(n, [n.changed && "changed"])}" as ${id.get(n.id)}`),
    ...(roots.length ? roots : nodes.slice(0, 1)).map((n) => `  [*] --> ${id.get(n.id)}`),
    ...edges.map((e) => { const text = `${descr(transitionText(e) || e.error || "")}${notes(e, [e.changed && "changed"])}`.trim(); return `  ${id.get(e.from)} --> ${id.get(e.to)}${text ? ` : ${text}` : ""}`; }),
    ...sinks.filter((n) => !roots.includes(n)).map((n) => `  ${id.get(n.id)} --> [*]`)]);
}

// Who calls whom, in the order of the calls.
function mermaidSequence(v) {
  const nodes = uniq(v.nodes), id = idsOf(nodes, "p"), edges = [...(v.edges ?? []), ...(v.transitions ?? [])].filter((e) => id.has(e.from) && id.has(e.to));
  return fence(["sequenceDiagram",
    ...nodes.map((n) => `  participant ${id.get(n.id)} as ${alias(`${n.label ?? n.id}${notes(n)}`)}`),
    ...edges.map((e, k) => `  ${id.get(e.from)}${e.source === "spec" ? "-->>" : "->>"}${id.get(e.to)}: ${k + 1}. ${message(`${transitionText(e) || "calls"}${notes(e, [e.changed && "changed"])}`)}`)]);
}

// One picture of the analysis under its name: a state machine as stateDiagram-v2, a sequence as sequenceDiagram, a
// flow or an architecture as a flowchart, steps as a numbered list.
// findings: the unresolved ones; a state diagram then lists the moves they hang on (views.js transitionMarks, as the
// page marks them).
export function visualMd(v, h = "###", findings = null) {
  const edges = [...(v.edges ?? []), ...(v.transitions ?? [])], nodes = uniq(v.nodes);
  const lv = v.kind === "steps" ? levels(nodes, edges) : null;
  const body = v.kind === "state_machine" ? mermaidState(v) : v.kind === "sequence" ? mermaidSequence(v)
    : v.kind === "steps" ? [...nodes].sort((a, b) => lv.get(a.id) - lv.get(b.id)).map((n, k) => `${k + 1}. ${flat(n.label ?? n.id)}${n.note ? `: ${flat(n.note)}` : ""}${n.at ? ` (\`${n.at}\`)` : ""}`)
    : mermaidFlow({ nodes, edges });
  const marks = v.kind === "state_machine" && findings ? [...transitionMarks(v, findings)] : [];
  return [`${h} ${KIND[v.kind] ?? v.kind}${v.title ? `: ${flat(v.title)}` : ""}`, "", ...body, "",
    ...(marks.length ? ["Unresolved findings at its moves:", "", ...marks.map(([i, m]) => `- ${flat(edges[i].from)} → ${flat(edges[i].to)} (${m.severity}): ${m.findings.map((f) => flat(f.title)).join("; ")}`), ""] : [])];
}

// ---- findings

const where = (f) => `\`${f.file}:${f.line}${f.end > f.line ? `-${f.end}` : ""}\``;
const cell = (s) => flat(s).replace(/\|/g, "\\|") || "-";
const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`), ""] : []);
// A finding in one line, for a list: "**high** Title (`a.py:3`) · Fix sent · Assumed, not checked".
const findingLine = (f, st) => `**${f.severity}**${f.security ? " security" : ""}: ${flat(f.title)} (${where(f)})${[st && st !== "open" && STATE[st], CERTAINTY[f.certainty]].filter(Boolean).map((x) => ` · ${x}`).join("")}`;

// Everything a finding says, under headings one level below `h`: what its severity means, where and in which state it
// is, who found it, how sure it is and what it hangs on, the criteria it breaks (and `extra` lines: how it is
// reached), then effect, detail and suggestion as they were written (their markdown stays).
// cx: the text's code blocks (codeContext): the finding's lines stand under its facts. more: [[label, text]] the view
// adds (its layer, its owner, what is known about its fix).
// steps: pr.js findingSteps (reported → evidence → fix sent → verified → in the PR) with what each one rests on.
function findingBody(f, { status = "open", asks = [], h = "##", extra = [], cx = null, more = [], steps = [] }) {
  const fact = new Map(factRows(f));
  const broken = asks.filter((a) => (a.findings ?? []).some((x) => f.ids.includes(x)) || (f.criteria ?? []).includes(a.id));
  const others = (f.sources ?? []).filter((s) => s.title !== f.title || s.detail !== f.detail);
  return [
    `- **Severity:** ${fact.get("Severity") ? flat(fact.get("Severity")).replace(/\.$/, "") : f.severity}${SEVERITY_SCALE[f.severity] ? `. On this scale, ${f.severity} means: ${SEVERITY_SCALE[f.severity]}` : ""}${f.impact && !fact.get("Severity") ? `. Here: ${String(f.impact).replace(/_/g, " ")}` : ""}.`,
    `- **Where:** ${where(f)}`,
    `- **State:** ${STATE[status] ?? status}`,
    (f.sources ?? []).length > 0 && `- **Found by:** ${f.sources.map((s) => `${SOURCE[s.reviewer] ?? s.reviewer} (${s.severity})`).join(", ")}`,
    Boolean(f.category) && `- **Category:** ${f.category}${f.security && f.category !== "security" ? ", security" : ""}`,
    Boolean(f.certainty) && `- **Certainty:** ${flat(fact.get("Certainty") ?? CERTAINTY[f.certainty])}`,
    f.preconditions?.length > 0 && ["- **Preconditions:**", ...f.preconditions.map((p) => `  - ${flat(p)}`)],
    Boolean(f.certainty) && !f.preconditions?.length && "- **Preconditions:** none, it always happens",
    broken.length > 0 && ["- **Breaks these criteria:**", ...broken.map((a) => `  - ${ASK[a.state] ?? a.state}: ${flat(a.text)}`)],
    ...factRows(f).filter(([label]) => label === "Reach").map(([label, text]) => `- **${label}:** ${flat(text)}`),
    Boolean(f.same_cause_at) && `- **Same cause as:** \`${f.same_cause_at}\``,
    Boolean(f.effort) && `- **Effort of the fix:** ${flat(f.effort)}`,
    f.introduced_here === false && "- **Already there before this PR.**",
    ...extra,
    ...(more ?? []).filter((x) => x?.[1]).map(([label, text]) => `- **${label}:** ${flat(text)}`),
    steps.length > 0 && ["- **Where it stands:**", ...steps.map((x) => `  - ${x.label}: ${x.done ? "reached" : flat(x.missing)}${x.details?.length ? ` (${x.details.map(([label, text]) => `${label}: ${flat(text)}`).join("; ")})` : ""}`)],
    "",
    ...(cx ? cx.block(f.file, f.line, f.end) : []),
    Boolean(f.effect) && [`${h} Effect`, "", f.effect.trim(), ""],
    Boolean(f.detail) && [`${h} Detail`, "", f.detail.trim(), ""],
    Boolean(f.suggestion) && [`${h} Suggestion`, "", f.suggestion.trim(), ""],
    others.length > 0 && [`${h} Also reported as`, "", ...others.map((s) => `- ${SOURCE[s.reviewer] ?? s.reviewer} (${s.severity}): ${flat(s.title)}${s.detail ? `. ${flat(s.detail)}` : ""}`), ""],
  ];
}

// code: rowsOf(file) for the code blocks (codeContext), null: none. moreOf(f): [[label, text]] from the view.
// stepsOf(f): pr.js findingSteps with the view's status and fix facts.
export const findingMd = (f, { pr, head, status = "open", asks = [], code = null, moreOf = () => [], stepsOf = () => [] } = {}) => doc(prLine({ pr, head }), "", `# Finding: ${flat(f.title)}`, "", findingBody(f, { status, asks, cx: codeContext(code), more: moreOf(f), steps: stepsOf(f) }));

const bySeverity = (list) => [...list].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
const sevCount = (list) => ["high", "medium", "low"].map((k) => [k, list.filter((f) => f.severity === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
const numbered = (list, statusOf, asks, h, cx = null, moreOf = () => []) => list.flatMap((f, k) => [`${h} ${k + 1}. ${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks, h: `${h}#`, cx, more: moreOf(f) })]);

// Every unresolved finding, most severe first.
// notes: the AI notes without a finding (pr.js mergeFindings notes: {path, line, severity, reason}). sources: the
// tab's line of who found how many ("Analysis 13", "Codex review: failed").
export function findingsMd(findings, { pr, head, statusOf = () => "open", asks = [], code = null, moreOf = () => [], notes = [], sources = [] } = {}) {
  const list = bySeverity(findings.filter((f) => unresolved(statusOf(f)))), cx = codeContext(code), settled = findings.filter((f) => !unresolved(statusOf(f))), fun = funnelOf(findings, statusOf);
  // One part per severity ("## High (16)"), the findings numbered through under them: the preview lists a handful of
  // parts to tick, not one per finding.
  const groups = ["critical", "high", "medium", "low"].map((k) => [k, list.filter((f) => f.severity === k)]).filter(([, l]) => l.length), rest = list.filter((f) => !groups.some(([, l]) => l.includes(f)));
  const group = (title, l) => [`## ${title} (${l.length})`, "", ...l.flatMap((f) => [`### ${list.indexOf(f) + 1}. ${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks, h: "####", cx, more: moreOf(f) })])];
  return doc(prLine({ pr, head }), "", `# ${count(list.length, "unresolved finding")}${list.length ? `: ${sevCount(list)}` : ""}`, "",
    findings.length > 0 && countLine(findingCounts(findings, statusOf)), Boolean(funnelShort(fun)) && `${funnelShort(fun)}.`, sources.length > 0 && `Sources: ${sources.map(flat).join(" · ")}.`,
    "A finding with a fix sent stays unresolved until it is verified.", "",
    ...groups.flatMap(([k, l]) => group(`${k[0].toUpperCase()}${k.slice(1)}`, l)), rest.length > 0 && group("Other severity", rest),
    settled.length > 0 && [`## Fixed or dismissed (${settled.length})`, "", ...settled.map((f) => `- ${findingLine(f, statusOf(f))}`), ""],
    notes.length > 0 && [`## AI notes (${notes.length})`, "", ...notes.map((x) => `- ${x.severity ?? "low"}: ${flat(x.reason)} (\`${x.path}:${x.line}\`)`), ""]);
}

// The components this PR adds or changes, with owner and what is to operate (the Overview's "New parts", the
// Architecture page's table).
const componentsTable = (list) => table(["Component", "Kind", "Status", "Where", "Owner", "To operate"], (list ?? []).map((c) => [c.name, c.kind, c.status, c.at ? `\`${c.at}\`` : "", c.owner ?? "no owner", (c.operate ?? []).join("; ") || "nothing named"]));

// ---- the Overview

// checks: pr.js preMergeChecks; related: related.py's context (stacked_on, open, merged). From the view, so the text
// says what the page says: verdict (review.js verdictNow, with the resilience blockers), action (pr.js verdictAction),
// rows (review.js mergeRows: "Before merge"), nc (pr.js notChecked) with resLine (the resilience run in words), cost
// (pr.js costLine), flow (the flow picture the page shows). code: rowsOf(file) for the code blocks.
const ROW_KIND = { security: "Security", criterion: "Criterion", ask: "Criterion", finding: "Finding", conflict: "Merge conflict", ci: "CI check", rule: "Repo rule", verify: "Fix to verify", overlap: "Overlapping PR", resilience: "Resilience" };
// size: "9 files +178 −10"; funnel: pr.js funnel() of the findings (how many reports became how many findings).
export function overviewMd({ pr, head, ai = null, findings = [], statusOf = () => "open", checks = [], related = null, verdict: said = null, action = null, rows = null, nc = null, resLine = null, cost = null, flow = null, code = null, size = null, funnel = null }) {
  const list = taskList(ai?.asks ?? [], findings, ai?.unlinked ?? [], statusOf), verdict = said ?? (ai || findings.length ? verdictParts(list, findingCounts(findings, statusOf), { failed: checks.filter((c) => c.ok === false).length, oldRules: Boolean(ai?.securityFrom?.predates) }) : []);
  const line = (f) => `- ${findingLine(f, statusOf(f))}`, cx = codeContext(code);
  const before = (r) => [`- **${ROW_KIND[r.kind] ?? r.kind}:** ${r.finding ? findingLine(r.finding, statusOf(r.finding)) : `${flat(r.title)}${r.where ? ` (\`${r.where}\`)` : ""}`}${r.ask && !r.finding ? ` (${ASK[r.ask.state] ?? r.ask.state})` : ""}`,
    Boolean(r.why) && `  - ${flat(r.why)}`, (r.asks ?? []).length > 0 && `  - Breaks: ${r.asks.map((x) => flat(x.short || x.text || x)).join("; ")}`, r.finding?.path_certainty && `  - ${{ assumed: "assumed reachable", confirmed: "confirmed reachable", derived: "reachable by the code" }[r.finding.path_certainty] ?? `reach ${r.finding.path_certainty}`}`, (r.also ?? []).length > 0 && `  - Same cause also at ${r.also.join(", ")}`,
    Boolean(r.url) && `  - ${r.url}`, "", ...(r.finding ? cx.block(r.finding.file, r.finding.line, r.finding.end) : cx.at(r.where))];
  const does = ai ? doesList(ai) : [], surface = ai ? surfaceLine(ai.access, ai.scope?.checked ?? []) : null, rel = [...(related?.open ?? []).filter((p) => !p.stacked || p.above), ...(related?.merged ?? []).map((p) => ({ ...p, merged: true }))];
  const ask = (r) => [`- **${ASK[r.ask.state] ?? r.ask.state}**: ${flat(r.ask.text)}`, Boolean(r.ask.why) && `  - Why: ${flat(r.ask.why)}`, r.unlinked && "  - No finding backs this state.", ...r.findings.map((f) => `  ${line(f)}`)];
  const marked = list.rows.filter((r) => list.marked && r.ask.acceptance), rest = list.rows.filter((r) => !marked.includes(r)), hasTask = list.rows.length + list.extra.length > 0;
  const mark = (ok) => (ok === true ? "passed" : ok === false ? "failed" : ok === null ? "pending" : "n/a");
  const rules = [...checks.filter((c) => !c.rule).map((c) => `- ${mark(c.ok)}: ${flat(c.name)}${c.ok !== true && c.why ? `. ${flat(c.why)}` : ""}`),
    ...(ai?.rules ?? []).map((r) => `- ${mark(r.status === "pass" ? true : r.status === "fail" ? false : undefined)}: ${flat(r.rule)} (${[r.source, r.where && `\`${r.where}\``].filter(Boolean).join(", ")})${r.why ? `. ${flat(r.why)}` : ""}`)];
  return doc(prLine({ pr, head }), "", `# Review overview: ${flat(pr.title)}`, "",
    verdict.length > 0 && `**Verdict:** ${action ? `${action}: ` : ""}${verdict.map((p) => p.text).join(" · ")}`,
    ai?.mergeRisk && `**Merge risk:** ${ai.mergeRisk.level}${ai.mergeRisk.why ? `. ${flat(ai.mergeRisk.why)}` : ""}`,
    related?.stacked_on && `**Stacked on:** #${related.stacked_on.number} ${flat(related.stacked_on.title)}${related.stacked_on.url ? ` (${related.stacked_on.url})` : ""}. This PR merges after it.`,
    componentLine(ai?.componentCounts) && `**Components:** ${componentLine(ai.componentCounts)}`,
    Boolean(surface) && `**Attack surface:** ${surface}`,
    Boolean(cost) && `**Cost of the AI runs:** ${flat(cost)}`,
    Boolean(size) && `**Size:** ${flat(size)}`,
    ai && `**Analysis:** ${ai.exact === false ? "analysis of an earlier head: the PR has new commits since it ran" : `analysis of ${head ? String(head).slice(0, 7) : "this head"}`}${ai.model ? ` (${ai.model})` : ""}`,
    funnel?.merged > 0 && `**Findings:** ${funnel.merged} ${funnel.merged === 1 ? "finding" : "findings"}${funnel.reported > funnel.merged ? ` from ${funnel.reported} reports` : ""}${rows ? `; ${rows.length} stand before the merge` : ""}`,
    (ai?.task?.title || ai?.task?.jira || ai?.task?.note) && `**Task:** ${[ai.task.title, ai.task.jira && `linked issue ${ai.task.jira}`, ai.task.note].filter(Boolean).map(flat).join(" · ")}`,
    !ai && "No analysis of this diff yet: the findings below come from the reviewers.", "",
    rows && [`## Before merge (${rows.length})`, "", rows.length ? "What stands before the merge, most urgent first." : "Nothing stands before the merge.", "", ...rows.flatMap(before), ""],
    (hasTask || list.security.length + list.other.length > 0) && [`## ${hasTask ? `Check against the task: ${taskHead(list)}` : "Unresolved findings"}`, "",
      list.security.length > 0 && ["### Security", "", ...list.security.map(line), ""],
      marked.length > 0 && ["### Acceptance criteria", "", ...marked.map(ask), ""],
      rest.length > 0 && [`### ${list.marked ? "Also in the description" : "Criteria"}`, "", ...rest.map(ask), ""],
      list.extra.length + list.other.length > 0 && [`### ${hasTask ? "Not in the task" : "Other findings"}`, "", ...list.extra.map(ask),
        hasTask && list.other.length > 0 && `- ${count(list.other.length, "unresolved finding")} ${list.other.length === 1 ? "belongs" : "belong"} to no criterion:`, ...list.other.map((f) => `${hasTask ? "  " : ""}${line(f)}${f.introduced_here === false ? " · already there before this PR" : ""}`),
        list.other.some((f) => f.introduced_here === false) && `- ${list.other.filter((f) => f.introduced_here === false).length} already there before this PR.`, ""]],
    nc && ["## Not checked", "", flat(nc.text), "", nc.areas?.length ? `- Areas no run checked: ${nc.areas.join(", ")}` : "- Every area was checked by at least one run.",
      (nc.assumptions ?? []).length > 0 && [`- ${nc.assumptions.length} ${nc.assumptions.length === 1 ? "finding rests" : "findings rest"} on an assumption nobody checked:`, ...nc.assumptions.map((f) => `  ${line(f)}`)],
      `- Security review: ${nc.security}`, Boolean(resLine) && `- Resilience review: ${flat(resLine)}`, ""],
    Boolean(ai?.summary) && ["## What changed", "", ai.summary.trim(), ""],
    does.length > 0 && ["## What the PR does", "", ...does.flatMap(([label, items]) => [`${label}:`, "", ...items.map((x) => `- ${flat(x.text)}${x.source === "spec" ? " (spec only)" : ""}${x.evidence ? ` (\`${x.evidence}\`)` : ""}`), ""]),
      flow && visualMd(flow)],
    (ai?.behaviorPoints?.length || ai?.behavior) && !does.some(([label]) => label === "At run time") && ["## Behavior", "", ai.behaviorPoints?.length ? ai.behaviorPoints.map((x) => `- ${flat(x.text)}${x.source === "spec" ? " (spec only)" : ""}${x.evidence ? ` (\`${x.evidence}\`)` : ""}`) : ai.behavior.trim(), ""],
    ai?.components?.length > 0 && [`## New parts (${ai.components.length})`, "", ...componentsTable(ai.components)],
    rules.length > 0 && [`## Repo rules and checks (${rules.length})`, "", ...rules, ""],
    rel.length > 0 && [`## Related PRs (${rel.length})`, "", ...rel.map((p) => `- #${p.number} ${flat(p.title)}: ${p.merged ? "merged" : p.above ? "builds on this PR, it merges after this one" : "open"}${p.overlap ? `, ${count(p.overlap, "file")} in common` : ""}${p.url ? ` (${p.url})` : ""}`), ""]);
}

// ---- a layer

// step: a layer of the analysis; n: its number as shown; files: the files its hunks are in; findings: the layer's.
// deps: the titles of the layers it builds on; access: what it opens (views.js layerAccess text); hunks: its hunks
// [{path, rows}] for the code blocks (each one's first lines); code: rowsOf(file) for the findings' lines.
// open: every unresolved finding of the review (a state diagram marks the moves they hang on), else the layer's.
export function layerMd(step, { pr, head, n = null, files = [], findings = [], statusOf = () => "open", deps = [], access = null, hunks = [], code = null, open: allOpen = null } = {}) {
  const open = bySeverity(findings.filter((f) => unresolved(statusOf(f)))), cx = codeContext(code);
  const span = (h) => { const ns = (h.rows ?? []).map((r) => r.n).filter((x) => x > 0); return ns.length ? cx.block(h.path, ns[0], ns.at(-1), 0) : []; };
  const flow = (f) => [`- \`${flat(f.function)}\`${f.at ? ` at \`${f.at}\`` : ""}`,
    ...(f.inputs ?? []).map((i) => `  - in: \`${flat(i.name)}\` (${flat(i.type)})${i.example ? `, for example \`${flat(i.example)}\`` : ""}`),
    f.output && `  - out: ${flat(f.output.type)}${f.output.example ? `, for example \`${flat(f.output.example)}\`` : ""}`,
    f.side_effects?.length > 0 && `  - side effects: ${f.side_effects.map(flat).join("; ")}`, f.calls?.length > 0 && `  - calls: ${f.calls.map((c) => `\`${flat(c)}\``).join(", ")}`,
    ...(f.trace ?? []).map((x) => `  - line ${x.line}${x.path ? ` (${flat(x.path)})` : ""}: \`${flat(x.values)}\``)];
  return doc(prLine({ pr, head }), "", `# Layer${n ? ` ${n}` : ""}: ${flat(step.title)}`, "",
    Boolean(step.risk) && `**Risk:** ${step.risk === "skim" ? "low, skimmed by the analysis" : step.risk}`, Boolean(step.why) && `**Why it matters:** ${flat(step.why)}`,
    deps.length > 0 && `**Depends on:** ${deps.map(flat).join("; ")}`, Boolean(access) && `**Opens:** ${flat(access)}`, "",
    Boolean(step.text) && [step.text.trim(), ""],
    files.length > 0 && ["## Files", "", ...files.map((f) => `- \`${f}\``), ""],
    step.questions?.length > 0 && ["## Questions to check", "", ...step.questions.map((q, k) => `- ${step.questionFiles?.[k] ? `\`${step.questionFiles[k]}\`: ` : ""}${flat(q)}`), ""],
    [`## Findings: ${open.length ? `${open.length} unresolved, ${sevCount(open)}` : "none unresolved"}`, "", ...open.flatMap((f) => [`- ${findingLine(f, statusOf(f))}`, Boolean(f.effect) && `  - ${flat(f.effect)}`, "", ...cx.block(f.file, f.line, f.end)]), ""],
    step.visuals?.length > 0 && [`## Pictures (${step.visuals.length})`, "", ...step.visuals.map((v) => visualMd(v, "###", allOpen ?? open))],
    step.flows?.length > 0 && [`## Functions with example values (${step.flows.length})`, "", ...step.flows.map(flow), ""],
    cx.on && hunks.length > 0 && [`## Code of this layer (${count(hunks.length, "hunk")})`, "", "The first lines of each hunk; the rest is in the diff.", "", ...hunks.flatMap(span)]);
}

// ---- the architecture

// The map as a Mermaid flowchart, the cards with what they are, where an unresolved finding breaks the flow, the
// components with owner and what is to operate, then the analysis' other pictures of the whole PR.
// The map is the one the page draws (views.js mapArch: the Internet card at the way in; the systems as frames, a
// card's zone in its text, the unresolved findings at a card or a call as arch.js archMarks counts them).
// layersOf(n): the titles of the layers that read a card's code; placesIn(path): how many changed places of the PR
// are in a file (both from the view; without them those lines are left out).
export function architectureMd({ pr, head, ai, findings = [], statusOf = () => "open", code = null, layersOf = null, placesIn = null, impact = null, infra = null, schema = null }) {
  const a = ai?.arch, nodes = a?.nodes ?? [], name = (id) => flat(nodes.find((n) => n.id === id)?.label ?? (id === "internet" ? "Internet" : id));
  const openAll = findings.filter((f) => unresolved(statusOf(f))), marks = a ? archMarks(a, openAll, ai?.access, ai?.threats ?? []) : null, drawn = a ? mapArch(a, ai?.access ?? [], ai?.bypasses ?? []) : null, cx = codeContext(code);
  const call = (e, k) => [`${k + 1}`, `${name(e.from)} → ${name(e.to)}`, transitionText(e), [cardStatus(e) ?? (e.status && e.status !== "unchanged" ? e.status : ""), e.source === "spec" && "spec only", e.crosses && !e.in_process && "crosses a trust boundary", e.in_process && "same process"].filter(Boolean).join(", "),
    marks.edges.get(k) ? `${marks.edges.get(k).severity}: ${marks.edges.get(k).findings.map((f) => flat(f.title)).join("; ")}` : ""];
  // A card as its panel shows it: what it is, its file, the unresolved findings on it and on its calls, its
  // connections (incoming first), what running it needs, who owns it and who may reach it, its text and details.
  const card = (n) => {
    const at = n.at ?? n.evidence, path = at ? String(at).replace(/:\d+.*$/, "") : null, edges = a.edges ?? [], k = placesIn && path ? placesIn(path) : null;
    const found = [...(marks.nodes.get(n.id)?.findings ?? []).map((f) => ({ f, edge: null })), ...edges.flatMap((e, i) => (e.from === n.id || e.to === n.id ? (marks.edges.get(i)?.findings ?? []).map((f) => ({ f, edge: e })) : []))]
      .sort((x, y) => (RANK[x.f.severity] ?? 9) - (RANK[y.f.severity] ?? 9));
    const links = edges.filter((e) => e.from === n.id || e.to === n.id).sort((x, y) => (x.to === n.id ? 0 : 1) - (y.to === n.id ? 0 : 1));
    const comps = (ai?.components ?? []).filter((c) => c.node === n.id), ops = [...new Set(comps.flatMap((c) => c.operate ?? []))], owners = [...new Set(comps.map((c) => c.owner).filter(Boolean))], access = (ai?.access ?? []).filter((x) => x.node === n.id);
    const layers = layersOf ? layersOf(n) : [];
    return [`### ${flat(n.label ?? n.id)}`, "",
      `- ${[cardStatus(n) ?? "unchanged", n.type, n.source === "spec" && "spec only", group(n) && `in ${group(n)}`, zones.length && `zone: ${zone(n)}`].filter(Boolean).join(", ")}`,
      `- **File:** ${at ? `\`${at}\`${k === null ? "" : k ? `, ${k} changed ${k === 1 ? "place" : "places"} in this PR` : ", not in this PR's diff"}` : "the analysis names no file for this card"}`,
      found.length > 0 && [`- **Unresolved findings (${found.length}):**`, ...found.map(({ f, edge }) => `  - ${findingLine(f, statusOf(f))}${edge ? `, breaks the call ${edge.from === n.id ? `to ${name(edge.to)}` : `from ${name(edge.from)}`}` : f.breaks?.node === n.id ? ", breaks the flow here" : ""}`)],
      links.length > 0 && ["- **Connections:**", ...links.map((x) => `  - ${x.from === n.id ? "→" : "←"} ${name(x.from === n.id ? x.to : x.from)}${transitionText(x) ? `: ${flat(transitionText(x))}` : ""}`)],
      ops.length > 0 && `- **To operate:** ${ops.map(flat).join(" · ")}`,
      comps.length > 0 && ai?.componentCounts?.codeowners !== false && `- **Owner:** ${owners.join(", ") || "no owner named"}`,
      access.length > 0 && ["- **Access:**", ...access.map((x) => `  - ${flat(x.principal)}: ${(x.actions ?? []).map(flat).join(", ")}${x.public ? " · public" : ""}${x.used === false ? " · not used by the code" : ""}`)],
      layers.length > 0 && `- **Layers on this code:** ${layers.map(flat).join("; ")}`,
      "", Boolean(n.description) && [flat(n.description), ""], Boolean(n.details) && [String(n.details).trim(), ""]];
  };
  // With trust zones the diagram's frames are the zones: each card names its group and zone here instead.
  const zones = a?.zones ?? [], group = (n) => flat((a.groups ?? []).find((g) => g.id === n.group)?.label ?? ""), zone = (n) => { const z = zones.find((x) => x.id === n.zone); return z ? `${flat(z.name ?? z.id)} (${z.trust ?? "trust not stated"})` : "none"; };
  const breaks = bySeverity(findings.filter((f) => (f.breaks?.node || f.breaks?.from) && unresolved(statusOf(f)))); // a place on the map; breaks.transition alone is a move of a state diagram
  const st = (k) => nodes.filter((n) => cardStatus(n) === k).length;
  const sums = [["new", st("new")], ["changed", st("changed")], ["removed", st("removed")]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
  return doc(prLine({ pr, head }), "", "# Architecture impact", "",
    !a && "The analysis has no architecture picture for this PR.",
    a && [`${count(nodes.length, "card")}${sums ? `: ${sums}` : ""}. A card's class in the diagram is its status; a dashed call is only in the spec${(a.zones ?? []).length ? "; a card names its trust zone, a thick call crosses a trust boundary" : ""}. The frames are the systems; a card or a call with unresolved findings says how many.`, componentLine(ai.componentCounts) && `${componentLine(ai.componentCounts)}.`, "", ...mermaidFlow(drawn, { systems: true, marks }), "",
      `## Cards (${nodes.length})`, "", ...nodes.flatMap(card),
      (a.edges ?? []).length > 0 && [`## Calls (${a.edges.length})`, "", "Every call with its whole text, numbered as on the map.", "", ...table(["#", "Call", "What", "Status", "Unresolved findings"], a.edges.map(call))]],
    breaks.length > 0 && [`## Where the flow breaks (${breaks.length})`, "", ...breaks.map((f) => `- ${f.breaks.node ? `Card ${name(f.breaks.node)}` : `Call ${name(f.breaks.from)} → ${name(f.breaks.to)}`}: ${findingLine(f, statusOf(f))}`), ""],
    ai?.components?.length > 0 && [`## Components this PR adds or changes (${ai.components.length})`, "", ai.componentCounts?.codeowners === false && "This repository has no CODEOWNERS file, so no owner can be named.", "", ...componentsTable(ai.components)],
    impact && impactSection(impactDoc(impact, openAll)),
    infra && ["", ...infraMd(infra, { table, flow: mermaidFlow, findings: openAll })], // "Infrastructure changes" (infra.js): from the diff, also without an analysis
    schema && ["", ...schemaMd(schema, { table, findings: openAll })], // "Schema changes" (schema.js): from the diff, also without an analysis
    ai?.visuals?.length > 0 && [`## Other pictures (${ai.visuals.length})`, "", ...ai.visuals.map((v) => visualMd(v))],
    cx.on && breaks.length > 0 && [`## Code where the flow breaks`, "", ...breaks.flatMap((f) => cx.block(f.file, f.line, f.end))]);
}

// The Impact section (impact.js impactDoc): its lines, every caller as a table row, and the picture as a flowchart.
const impactSection = (d) => ["", `## ${d.title}`, "", ...d.lines, ...(d.rows.length ? ["Callers and tests as a list:", "", ...table(d.head, d.rows)] : []), ...(d.flow.nodes.length ? [...mermaidFlow(d.flow), ""] : [])];

// ---- the Security page

// The Security page as it stands, nothing folded: the sentence over it, every trust boundary crossing in its open
// form (who arrives, the check and where it sits, what it holds on, the way through every gate, what an attacker
// controls and reaches, the evidence, the threats and the findings there), what a taken-over frame may do, the
// crossings as a picture (views.js secPicture: the page's own, also below three crossings), the unresolved security
// findings in full, exposure, rights, and what each run says it checked with its contradictions. runs: pr.js runsOf.
// code: rowsOf(file) for the code blocks (the gate's line, each finding's lines); extra: Map(crossing key -> ask) of
// the ways in the task does not ask for (review.js secExtra); moreOf(f): [[label, text]] from the view.
const KIND_WORD = { entry: "Way in", right: "Right", call: "Call", bypass: "In-process call", operator: "Operator way" };
const RESULT_WORD = { finding: "Finding", mitigated: "Mitigated", not_assessed: "Not assessed" };
const dot = (s) => flat(s).replace(/\.+$/, "");
// eff: review.js effZones (Map(card -> {trust, drawn, zone, why, cond})): where a card is really reachable from.
export function securityMd({ pr, head, ai = null, findings = [], statusOf = () => "open", runs = {}, code = null, extra = new Map(), moreOf = () => [], eff = null }) {
  const cx = codeContext(code), a = ai?.arch ?? null, threats = ai?.threats ?? [];
  const openAll = findings.filter((f) => unresolved(statusOf(f))), list = bySeverity(openAll.filter((f) => f.security || f.category === "security"));
  const rows = crossingsOf({ arch: a, access: ai?.access ?? [], threats, gates: ai?.gates ?? [], bypasses: ai?.bypasses ?? [], findings: openAll });
  const changed = rows.filter(crossingChanged), rest = rows.filter((r) => !crossingChanged(r)), marks = archMarks(a, openAll, ai?.access, threats);
  // The unresolved findings a named threat stands on without being ⛨ (their effect is not access or data): a flood
  // at a public way in, a script that can leave a guardrail off. Counted apart, listed in full.
  const cited = bySeverity(threatCited(threats, openAll).filter((f) => !list.includes(f))), shown = [...list, ...cited], picMarks = archMarks(a, shown, ai?.access, threats);
  // The guards: rules that take a right away, with the threat they hold against (views.js asideOf).
  const guards = asideOf({ arch: a, access: ai?.access ?? [], threats, gates: ai?.gates ?? [], bypasses: ai?.bypasses ?? [], findings: openAll }).guards ?? [];
  // Codex answers in text and a small Claude pass turns it into findings: an older run carries that pass's model.
  const secN = findingCounts(findings, statusOf).security; // the page's one number: ⛨ findings once per cause
  const modelOf = (kind, r) => (!r.model ? "" : kind === "codex" && /^claude/i.test(r.model) ? ` (Codex; its text turned into findings by ${r.model})` : ` (${r.model})`);
  const label = (id) => a?.nodes?.find((n) => n.id === id)?.label ?? (a?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id);
  const num = (r) => rows.indexOf(r) + 1, fline = (f) => `  - ${findingLine(f, statusOf(f))}`;
  const crossing = (r) => {
    const also = r.kind === "operator" ? [] : [...new Set([...(marks.nodes.get(r.ends.to)?.findings ?? []), ...(r.edge !== undefined ? marks.edges.get(r.edge)?.findings ?? [] : [])])].filter((f) => !r.findings.includes(f));
    const failOpen = r.kind === "entry" && r.findings.some((f) => f.impact === "unauthorized_access"), assessed = r.result !== "not_assessed", ask = extra.get(r.key);
    return [`### ${num(r)}. ${flat(r.from.name)} → ${flat(r.to.name)}`, "",
      `- **${KIND_WORD[r.kind] ?? "Call"}:** ${flat(r.what || label(r.ends.to))}${r.kind === "right" && r.actions?.length && !r.aliases ? ` (${r.actions.join(", ")})` : ""}`,
      `- **Result:** ${RESULT_WORD[r.result] ?? r.result}${!assessed && r.reason ? `: ${dot(r.reason)}` : ""}. Change by this PR: ${r.change ?? "not said"}.`,
      `- **Who:** ${flat(r.identity ?? "not named")}${r.unmapped ? " (principal not mapped to a card)" : ""}`,
      `- **Check:** ${r.kind === "bypass" ? "none: one process, no boundary in between" : r.check ? `${flat(r.check)}${r.expects ? `, expects ${flat(r.expects)}` : ""}${r.at ? ` (\`${r.at}\`)` : ""}` : "no check named"}`,
      r.kind !== "bypass" && `- **Holds only if:** ${r.holds_if ? dot(r.holds_if) : "not named"}`,
      `- **Way:** ${wayText(wayOf(r, rows, a))}`,
      assessed && `- **An attacker controls:** ${r.carries?.length ? [].concat(r.carries).map(flat).join(", ") : "not named"}`,
      !assessed && r.carries?.length > 0 && `- **What crosses here:** ${[].concat(r.carries).map(flat).join(", ")}`,
      assessed && `- **At the end they reach:** ${r.goal ? dot(r.goal) : "not named"}`,
      assessed && `- **Evidence:** ${r.evidence ? dot(r.evidence) : "none named"}`,
      failOpen && "- **Can fail open:** an unresolved finding says this way in's check can be passed.",
      Boolean(r.unused) && "- **Granted, not used:** the code in this PR never uses this right; least privilege says drop it.",
      Boolean(r.breaks) && `- Breaks the condition of crossing ${rows.findIndex((y) => y.key === r.breaks) + 1}.`,
      r.kind === "operator" && r.valueFrom !== undefined && (r.valueFrom ? `- Set at \`${r.valueFrom}\`.` : "- Set nowhere in the repository."),
      Boolean(ask) && `- The task does not ask for “${flat(ask.text)}”, and this PR opens it here.${ask.why ? ` ${flat(ask.why)}` : ""}`,
      ...(r.conflicts ?? []).map((c) => `- Data disagree: “${dot(c.f.title)}” names ${c.finding.join(", ") || "no way in"}, its threat ${c.threat.join(", ") || "no way in"}; the outer one counts here.`),
      ...(r.threats ?? []).map((x) => `- Threat${x.id ? ` ${x.id}` : ""}${x.stride ? ` (STRIDE ${x.stride})` : ""}${x.result ? `, ${String(x.result).replace(/_/g, " ")}` : ""}: ${flat(x.threat ?? "")}${x.evidence ? ` Evidence: \`${flat(x.evidence)}\`.` : ""}${x.note ? ` (${flat(x.note)})` : ""}`),
      r.findings.length > 0 && ["- **Findings at this crossing:**", ...r.findings.map(fline)],
      also.length > 0 && ["- **Also at this place:**", ...also.map(fline)],
      "", ...cx.at(r.at), r.kind === "operator" && r.valueFrom ? cx.at(r.valueFrom) : []];
  };
  // The picture: the page's (only the cards at a crossing, the zones as frames, each line numbered as above).
  const pic = (changed.length ? changed : rows), drawn = pic.length ? secPicture(pic, a, num) : null, picture = drawn?.edges.length ? drawn : null; // nothing to draw without a line
  const blast = secBlast(rows, a, ai?.access ?? []), rowOf = (f) => rows.find((r) => r.findings.includes(f)) ?? null;
  const REACH_WORD = { public: "anyone can reach it", authenticated: "an authenticated caller can reach it", internal_only: "it can only be reached from inside", unknown: "the analysis could not tell from where it can be reached" };
  const reach = (f) => { const r = rowOf(f), { ways, stated } = r ? { ways: [], stated: false } : waysOf(f), level = REACH_WORD[f.reachability] ?? null, conflict = r?.conflicts?.find((c) => c.f === f);
    if (!r && ways.length) return [`- **Reachable from:** ${ways.map((x) => `${flat(x.resource)}: ${EXPOSURE[x.exposure].toLowerCase()}, reached by ${flat(x.principal)}`).join("; ")}. ${stated ? `Stated by the analysis${level && f.reachability !== "unknown" ? `: ${level}` : ""}.` : "Derived from the map: the finding sits at this way in."}`];
    if (!r && level) return [`- **Reachable from:** ${level[0].toUpperCase()}${level.slice(1)}${f.reachability === "unknown" ? "." : ". Stated by the analysis, which names no way in."}`];
    return r ? [`- **Reachable from:** ${flat(r.identity ?? r.from.name)} through ${flat(r.what || label(r.ends.to))} (crossing ${num(r)}, ${flat(r.from.name)} → ${flat(r.to.name)}).${conflict ? ` Data disagree: the finding names ${conflict.finding.join(", ") || "no way in"}, its threat ${conflict.threat.join(", ") || "no way in"}; the outer one counts.` : ""}`,
    `- **Way:** ${wayText(wayOf(r, rows, a))}.${r.holds_if ? ` Holds only if: ${dot(r.holds_if)}.` : ""}`] : []; };
  const proof = (f) => (f.proof?.state === "done" ? [`- **Agent check:** ${String(f.proof.result ?? "").replace(/_/g, " ")}${f.proof.reason ? `: ${flat(f.proof.reason)}` : ""}${f.proof.command ? ` (ran \`${flat(f.proof.command)}\`)` : ""}`] : []);
  // What each run checked: the page's table (views.js scopeTable), each run's own line, and where they contradict.
  const tab = scopeTable(ai?.scope ?? null, runs), who = (k) => (k === "analysis" ? "Analysis" : SOURCE[k] ?? k), conflicts = [...scopeConflicts(tab, list)];
  const cell = (c) => (c ? `${String(c.result ?? "").replace(/_/g, " ")}${c.note ? `: ${flat(c.note)}` : ""}` : "–");
  const run = ([kind, r]) => [`- **${who(kind)}:** ${[`${r.state ?? "not run"}${modelOf(kind, r)}`, r.error && `Error: ${dot(r.error)}`, r.scope?.read?.length > 0 && `Read: ${r.scope.read.map(flat).join("; ")}`,
    (r.scope?.skipped ?? []).map(skipText).filter(Boolean).length > 0 && `Left out: ${r.scope.skipped.map(skipText).filter(Boolean).map(flat).join("; ")}`, r.state && !r.scope && "It does not say what it checked",
    r.scope && `Allowed: ${Array.isArray(r.allowed) && r.allowed.length ? r.allowed.map((x) => flat(String(x).replace(/(?:\/[^\s/()]+)+\/([^\s/()]+)/g, "$1"))).join(", ") : "read files in the checkout and its git history; no network, no writes"}`,
    r.count !== undefined && r.count !== null && count(r.count, "finding")].filter(Boolean).join(". ")}.`];
  // The page's order (views.js secOrder): how far out a finding can be reached from, by its crossing's row, else by
  // the ways in it names or sits at; then over a trust boundary; then severity. Each with the reason in words.
  const surface = surfaceOf(ai?.access), cardAt = new Map([...[...picMarks.nodes].flatMap(([id, m]) => m.findings.map((f) => [f.id, id])), ...[...picMarks.edges].flatMap(([i, m]) => m.findings.map((f) => [f.id, a.edges[i].from]))]);
  const waysOf = (f) => { const stated = (f.reachable_from ?? []).map((id) => [...surface.entries, ...surface.grants].find((x) => x.id === id)).filter(Boolean);
    return stated.length ? { ways: stated, stated: true } : { ways: surface.entries.filter((x) => (x.node && x.node === cardAt.get(f.id)) || x.at === `${f.file}:${f.line}`), stated: false }; };
  const LEVEL = { public: "public", authenticated: "authenticated", internal: "internal_only", data: "internal_only" }, zoned = (a?.zones ?? []).length > 0;
  const placed = secOrder(shown.map((f) => { const r = rowOf(f); return r ? { f, level: r.kind === "entry" ? "public" : LEVEL[r.from.trust] ?? "unknown", crosses: r.kind !== "bypass" && r.kind !== "operator" }
    : { f, level: reachLevel(f, waysOf(f).ways), crosses: zoned ? (a.edges ?? []).some((e) => e.crosses && !inProcess(e) && e.to === cardAt.get(f.id)) : null }; }));
  const ordered = placed.map((r) => r.f), why = new Map(placed.map((r) => [r.f.id, r.why]));
  const effLines = [...(eff ?? [])].map(([id, v]) => `- ${flat(label(id))}: ${v.cond ? `${v.trust[0].toUpperCase()}${v.trust.slice(1)} if ${v.cond.replace(/^if crossing /, "")}` : `Reachable as ${v.trust}`}. Drawn in ${flat(v.zone?.name ?? v.drawn)} (${v.drawn}), but ${flat(v.why)}${v.cond ? ` ${v.cond}` : ""}.`);
  return doc(prLine({ pr, head }), "", "# Security", "",
    `${count(list.length, "unresolved security finding")}${list.length ? `: ${sevCount(list)}` : cited.length ? " about access or data" : ""}${secN && secN !== list.length ? `, ${count(secN, "cause")}` : ""}.${cited.length ? ` ${count(cited.length, "other unresolved finding backs", "other unresolved findings back")} a threat named here (${sevCount(cited)}).` : ""}`, "",
    // As the page counts: ⛨ findings once per cause, the findings behind a threat, the guards this PR loosens.
    rows.length > 0 && [secSentence(rows, secN, cited.length, guards.filter((g) => g.loosened).length), ""],
    // pr.js secNote: a run from before the current rules of the security view.
    Boolean(ai?.securityFrom?.predates) && [secOldLine(ai, taskList(ai?.asks ?? [], findings, ai?.unlinked ?? [], statusOf).security), ""],
    [`## Trust boundary crossings (${changed.length}${rest.length ? `, and ${rest.length} unchanged` : ""})`, "",
      "The ways in, the rights and the calls this PR opens or changes across a trust boundary, each in full.", "",
      !rows.length && "The data names no crossing: no zones, no way in and no right into another zone. The security review names them.",
      ...changed.map(crossing),
      rest.length > 0 && [`Unchanged by this PR (${rest.length}):`, "", ...rest.map(crossing)],
      ...blast.map((s) => `- ${s}`), blast.length > 0 && "",
      rows.length > 0 && !rows.some((r) => r.kind === "operator") && "Operator and CI ways (admin scripts, deploys, guardrails): none named by the data, not assessed.", ""],
    picture && ["## Boundary picture", "", "Only the crossings, numbered as in the table, with what goes over them; a dashed line is not assessed. The frames are the trust zones.", "",
      ...mermaidFlow({ groups: picture.groups, nodes: picture.nodes, edges: picture.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, dashed: e.dashed })) }, { marks: { nodes: picMarks.nodes } }), "",
      effLines.length > 0 && ["Cards that can be reached from further out than their zone says:", "", ...effLines, ""]],
    // Under the picture as on the page: the ways of sensitive data over its crossings, and principals × resources.
    dataflowMd(dataflowOf({ data: ai?.secData ?? null, arch: a, crossings: rows }), mermaidFlow, label),
    rightsMd(rightsOf({ arch: a, access: ai?.access ?? [], crossings: rows, findings: openAll })),
    ordered.length > 0 && [`## Findings (${ordered.length}, full text)`, "",
      cited.length > 0 && `${list.length ? "" : "No unresolved finding is about access or data (⛨). "}${cited.length} unresolved ${cited.length === 1 ? "finding backs" : "findings back"} a threat named above without being about access or data: ${cited.length === 1 ? "it is" : "they are"} listed here too.`,
      ordered.length > 1 && "Ordered by how far out they can be reached from, then by whether the way crosses a trust boundary, then by severity.", "",
      ...ordered.flatMap((f, k) => [`### ${k + 1}. ${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks: ai?.asks ?? [], h: "####", extra: [why.has(f.id) && `- **Order:** ${why.get(f.id)}`, ...reach(f), ...proof(f)], cx, more: moreOf(f) })])],
    !ordered.length && ["## Findings (0)", "", "No unresolved security finding.", ""],
    guards.length > 0 && [`## Guards (${guards.length})`, "", "Rules that take a right away: they protect their resource and are no way in.", "",
      ...guards.map((g) => `- ${flat(guardLine(g, (x) => `\`${x}\``))}`), ""],
    exposureMd(ai, "##"), blastMd(ai, "##"),
    grantsOf(ai?.access).length > 0 && [`## Rights granted (${grantsOf(ai.access).length})`, "", ...table(["Resource", "Kind", "Who", "May", "Auth", "Used by the code", "Where"],
      grantsOf(ai.access).map((x) => [x.resource, x.kind, x.principal, (x.actions ?? []).join("; "), x.auth, x.used === undefined ? "" : x.used ? "yes" : "no", x.at ? `\`${x.at}\`` : ""]))],
    ["## What each run checked", "", "Each model run reports this about itself. It says where the run looked, not that the code is safe; “–” means the area was not part of that run.", "",
      tab.rows.length > 0 ? table(["Area", ...tab.cols.map(who)], tab.rows.map((r) => [AREA_NAME[r.area] ?? String(r.area).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), ...tab.cols.map((k) => cell(r.cells[k]))]))
        : [ai ? "No run has reported what it checked: the analysis is older than this report, or nothing has run yet." : "No analysis of this diff yet.", ""],
      ...Object.entries(runs).flatMap(run), !Object.keys(runs).length && "No reviewer has looked at security.", "",
      conflicts.length > 0 && ["Contradictions:", "", ...conflicts.map(([area, c]) => `- ${AREA_NAME[area] ?? area}: ${flat(c.text)}`), ""]]);
}

// ---- ways in, the way to a finding, what a taken-over zone may do

// A way in: everything public, and routes, endpoints and APIs; the other access rows are rights granted. How it is
// checked: `auth_kind` (none | code | gateway | iam) when the analysis has it, else the first word of the free text.
// ponytail: the same rule as views.js surfaceOf/exposureOf (Security page package); use those once both are merged.
const isEntry = (x) => Boolean(x.public) || /route|endpoint|api|url|http|gateway|ingress/i.test(String(x.kind ?? ""));
const unchecked = (x) => (x.auth_kind ? x.auth_kind === "none" : /^(|none|no|nothing|unauthenticated|-|–)$/i.test(String(x.auth ?? "").trim().replace(/[\s.(:;,].*$/, "")));
const entriesOf = (access) => (access ?? []).filter(isEntry).map((x, k) => ({ x, k, r: !x.public ? 2 : unchecked(x) ? 0 : 1 })).sort((a, b) => a.r - b.r || a.k - b.k).map(({ x }) => x);
// A guard takes a right away (crossingsMd lists it); two derived operator rows that say the same are one.
const grantsOf = (access) => (access ?? []).filter((x, k, all) => !isEntry(x) && !isGuard(x) && !(x.derived && all.findIndex((y) => y.derived && y.resource === x.resource && y.principal === x.principal && y.node === x.node) < k));
const AUTH_KIND = { none: "none", code: "in the code", gateway: "at the gateway", iam: "IAM" };
const checkOf = (x) => (unchecked(x) ? "none" : [AUTH_KIND[x.auth_kind], flat(x.auth)].filter(Boolean).join(": ") || "not stated");
const yesNo = (v) => (v === true ? "yes" : v === false ? "no" : "not stated");

// Each way in: reachable from the internet, how the caller is checked, whether this PR opens it, and the line that
// shows it. The first sentence sums them up.
function exposureMd(ai, h) {
  const list = entriesOf(ai?.access);
  if (!ai) return [];
  if (!list.length) return [`${h} Exposure`, "", ai?.access?.length ? "No access row of the analysis is a way in: everything it lists is a right inside the cloud account." : "The analysis lists no ways in.", ""];
  const pub = list.filter((x) => x.public), open = pub.filter(unchecked), opened = list.filter((x) => x.opened_by_pr === true);
  return [`${h} Exposure`, "", `${count(list.length, "way in", "ways in")}: ${pub.length} reachable from the internet${pub.length ? ` (${open.length} without a check of the caller)` : ""}, ${opened.length} opened by this PR.`, "",
    ...table(["Way in", "Kind", "Who", "May", "From the internet", "Check", "Opened by this PR", "Evidence"],
      list.map((x) => [x.resource, x.kind, x.principal, (x.actions ?? []).join("; "), x.public ? "yes" : "no", checkOf(x), yesNo(x.opened_by_pr), x.at ? `\`${x.at}\`` : ""]))];
}

const norm = (s) => flat(s).toLowerCase().replace(/\s+(function|role|lambda|service)$/, "");
// What a component in each trust zone may do once it is taken over: the rights whose holder is the zone, one of its
// cards or a component on one of them (an unused right says so), and the zones its calls reach. A zone of external
// callers only is left out: nobody takes over the caller. Without zones: the rights by who holds them.
function blastMd(ai, h) {
  const a = ai?.arch, zones = (a?.zones ?? []).filter((z) => z?.id !== undefined), nodes = a?.nodes ?? [], access = ai?.access ?? [];
  const right = (x) => `${(x.actions ?? []).map(flat).join(", ") || "use"} on ${flat(x.resource)}${x.used === false ? " (granted, not used by the code)" : ""}`;
  if (!zones.length) {
    const held = [...new Set(grantsOf(access).map((x) => flat(x.principal)))];
    return held.length ? [`${h} Blast radius`, "", "The analysis names no trust zones. The rights granted, by who holds them:", "", ...held.map((p) => `- **${p}** can ${grantsOf(access).filter((x) => flat(x.principal) === p).map(right).join("; ")}.`), ""] : [];
  }
  const name = (id) => flat(nodes.find((n) => n.id === id)?.label ?? id), zoneOf = (id) => nodes.find((n) => n.id === id)?.zone;
  const rows = zones.map((z) => {
    const own = nodes.filter((n) => n.zone === z.id);
    if (own.length && own.every((n) => n.type === "external")) return null;
    const names = new Set([z.name, z.id, ...own.flatMap((n) => [n.id, n.label]), ...(ai?.components ?? []).filter((c) => own.some((n) => n.id === c.node)).map((c) => c.name)].filter(Boolean).map(norm));
    // Whose right: the principal's card or frame when the run names it (principal_node), else by name; guards aside.
    const hosted = (n) => (Array.isArray(n.runs_in) ? n.runs_in.length > 0 : Boolean(n.runs_in)); // a frame's zone: the one its own cards carry
    const inZone = (id) => (nodes.some((n) => n.id === id) ? zoneOf(id) : (nodes.find((n) => n.group === id && n.zone && !hosted(n)) ?? nodes.find((n) => n.group === id && n.zone))?.zone) === z.id;
    const rights = access.filter((x) => !isGuard(x) && !x.public && (x.principal_node ? inZone(x.principal_node) : names.has(norm(x.principal))));
    const out = (a?.edges ?? []).filter((e) => own.some((n) => n.id === e.from) && zoneOf(e.to) !== z.id);
    const reached = [...new Set(out.map((e) => zoneOf(e.to)).filter(Boolean))].map((id) => zones.find((x) => x.id === id)).filter(Boolean);
    const free = [...new Set(out.filter((e) => !zoneOf(e.to)).map((e) => e.to))];
    // With the principal's card named (a newer run): by principal, each right on its card or, off the map, its kind
    // and resource; else as before, "it can … on <resource>".
    // An operator's right works through its script or workflow (the row's card), not on it.
    const on = (x) => `${(x.actions ?? []).map(flat).join(", ") || "use"} ${["operator", "ci"].includes(x.principal_kind) ? "through" : "on"} ${nodes.some((n) => n.id === x.node) ? name(x.node) : [x.kind, flat(x.resource)].filter(Boolean).join(" ")}${x.used === false ? " (granted, not used by the code)" : ""}`;
    const who = [...new Set(rights.filter((x) => x.principal_node).map((x) => flat(x.principal)))];
    const can = !rights.length ? "no right in this PR names it" : who.length ? who.map((p) => `${p} can ${rights.filter((x) => flat(x.principal) === p).map(on).join("; ")}`).join(". ") : `it can ${rights.map(right).join("; ")}`;
    const via = [...reached.map((x) => `${flat(x.name ?? x.id)} (${x.trust ?? "trust not stated"})`), free.length && `${count(free.length, "card")} outside every zone (${free.map(name).join("; ")})`].filter(Boolean);
    return `- **${flat(z.name ?? z.id)}** (${z.trust ?? "trust not stated"}): If it is compromised, ${can}. ${via.length ? `Its calls reach ${via.join(" and ")}.` : "It calls nothing outside its zone."}`;
  }).filter(Boolean);
  return [`${h} Blast radius`, "", "What a taken-over component in each zone may do, from the rights in this PR, and which zones its calls reach.", "", ...rows, ""];
}

const fileOf = (at) => String(at ?? "").replace(/:\d+(-\d+)?$/, ""), lineOf = (at) => Number(/:(\d+)/.exec(String(at ?? ""))?.[1]) || 0;
// The card a finding sits on: the one it breaks (a call: the calling card), else the card whose code (or a component
// on it: a Lambda in a template) is in its file, the one nearest its line. null: none on the map.
export function cardOf(f, arch, components = []) {
  const nodes = arch?.nodes ?? [], hit = f.breaks?.node ?? f.breaks?.from;
  if (hit !== undefined && nodes.some((n) => n.id === hit)) return hit;
  const spots = [...nodes.map((n) => [n.id, n.at ?? n.evidence]), ...(components ?? []).filter((c) => nodes.some((n) => n.id === c.node)).map((c) => [c.node, c.at])];
  const here = spots.filter(([, at]) => fileOf(at) === f.file).sort((a, b) => Math.abs(lineOf(a[1]) - f.line) - Math.abs(lineOf(b[1]) - f.line));
  return here[0]?.[0] ?? null;
}

// The way from an entry to a finding on the map: {entry (the access row), nodes, edges (indexes), crosses, stated}.
// The entries the finding names (`reachable_from`, stated by the analysis), else every way in whose card leads to the
// finding's card over calls (derived from the map); the shortest wins. An external caller of the entry's card starts
// the way. null: no way in found.
export function wayIn(f, ai) {
  const a = ai?.arch, edges = a?.edges ?? [], card = cardOf(f, a, ai?.components), access = ai?.access ?? [];
  const named = (f.reachable_from ?? []).map((id) => access.find((x) => x.id === id)).filter(Boolean), stated = named.length > 0;
  const bfs = (from) => { // edge indexes from `from` to the finding's card, or null
    if (from === card) return [];
    const prev = new Map([[from, null]]), queue = [from];
    while (queue.length) { const at = queue.shift(); for (const [e, k] of edges.map((e, k) => [e, k])) if (e.from === at && !prev.has(e.to)) { prev.set(e.to, k); if (e.to === card) { const way = []; for (let n = card; prev.get(n) !== null; n = edges[prev.get(n)].from) way.unshift(prev.get(n)); return way; } queue.push(e.to); } }
    return null;
  };
  const ways = (stated ? named : entriesOf(access)).filter((x) => x.node !== undefined && (card !== null || stated)).map((x) => ({ x, way: card === null ? null : bfs(x.node) })).filter((w) => stated || w.way);
  if (!ways.length) return stated ? { entry: named[0], nodes: [], edges: [], crosses: false, stated, card } : null;
  const best = ways.sort((p, q) => (p.way?.length ?? 99) - (q.way?.length ?? 99))[0];
  const caller = edges.map((e, k) => [e, k]).find(([e]) => e.to === best.x.node && a.nodes.find((n) => n.id === e.from)?.type === "external");
  const path = [...(caller ? [caller[1]] : []), ...(best.way ?? [])];
  return { entry: best.x, nodes: [...new Set([...(caller ? [caller[0].from] : []), best.x.node, ...path.map((k) => edges[k].to)])].filter((n) => n !== undefined), edges: path,
    crosses: path.some((k) => edges[k].crosses), stated, card, reaches: best.way !== null };
}

const REACH = { public: "anyone on the internet can reach it", authenticated: "a signed-in caller can reach it", internal_only: "only something inside can reach it", unknown: "the analysis could not tell from where it can be reached" };
const REACH_ORDER = ["public", "authenticated", "internal_only", "unknown"];
// "Way in: Front desk client → handler (FrontDesk HttpApi event; from the internet, check: in the code; opened by this
// PR). Stated by the analysis." and how reachable the analysis says it is.
function reachLines(f, ai) {
  const w = wayIn(f, ai), name = (id) => flat(ai?.arch?.nodes?.find((n) => n.id === id)?.label ?? id);
  const entry = w && `${flat(w.entry.resource)}; ${w.entry.public ? "from the internet" : "from inside"}, check: ${checkOf(w.entry)}${w.entry.opened_by_pr ? "; opened by this PR" : ""}`;
  return [
    Boolean(f.reachability) && `- **Reachable:** ${REACH[f.reachability] ?? f.reachability}. ${f.reachable_from?.length ? "Stated by the analysis, with the way in it names." : f.reachability === "unknown" ? "" : "Stated by the analysis, which names no way in."}`.trim(),
    w && `- **Way in:** ${w.nodes.length ? `${w.nodes.map(name).join(" → ")} (${entry})` : entry}.${w.crosses ? " It crosses a trust boundary." : ""} ${w.stated ? "The analysis names this way in" : "Derived from the map"}${w.stated && !w.reaches ? "; the map shows no call from it to the finding's card" : ""}.`,
    !w && Boolean(ai?.arch) && "- **Way in:** none found on the map.",
  ];
}

// Most reachable first (public, authenticated, inside only, unknown), then a way over a trust boundary, then severity.
const byReach = (list, ai) => list.map((f) => ({ f, r: REACH_ORDER.indexOf(f.reachability ?? "unknown"), c: wayIn(f, ai)?.crosses ? 0 : 1 }))
  .sort((p, q) => p.r - q.r || p.c - q.c || (RANK[p.f.severity] ?? 9) - (RANK[q.f.severity] ?? 9)).map(({ f }) => f);

// ---- context for an agent that checks findings

// Everything an agent needs to check the given findings, and nothing it should take as an order: each finding with
// its claim, preconditions, certainty, reachability, criteria and fix; the whole map with the way from the entry to
// each finding in red; exposure and blast radius; the threat model when the security run made one; what this PR
// cannot tell; the pictures of the findings' layers. data: {pr, head, ai, statusOf, threats}.
export function verifyContextMd(findings, { pr, head, ai = null, statusOf = () => "open", threats = null } = {}) {
  const list = byReach(findings ?? [], ai), a = ai?.arch, ways = list.map((f) => [f, wayIn(f, ai)]), name = (id) => flat(a?.nodes?.find((n) => n.id === id)?.label ?? id);
  const path = { nodes: ways.flatMap(([, w]) => w?.nodes ?? []), edges: ways.flatMap(([, w]) => w?.edges ?? []) };
  const zoned = (a?.zones ?? []).length > 0, loose = zoned ? (a?.nodes ?? []).filter((n) => !(a.zones ?? []).some((z) => z.id === n.zone)) : [];
  const unknown = [
    ...list.filter((f) => f.preconditions?.length).map((f) => `- ${flat(f.title)} holds only if: ${f.preconditions.map(flat).join("; ")}.`),
    ...list.filter((f) => f.certainty === "assumed").map((f) => `- ${flat(f.title)} is assumed: it depends on something that could not be checked.`),
    ...list.filter((f) => f.reachability && f.reachability !== "unknown" && !f.reachable_from?.length).map((f) => `- How far ${flat(f.title)} can be reached (${String(f.reachability).replace(/_/g, " ")}) is the analysis' word only: it names no way in.`),
    ...list.filter((f) => f.reachability === "unknown").map((f) => `- From where ${flat(f.title)} can be reached: the analysis could not tell.`),
    loose.length > 0 && `- ${count(loose.length, "card")} of the map ${loose.length === 1 ? "is" : "are"} in no trust zone: ${loose.map((n) => flat(n.label ?? n.id)).join("; ")}.`,
  ].filter(Boolean);
  const steps = (ai?.steps ?? []).filter((s) => (s.findings ?? []).some((x) => list.some((f) => (f.ids ?? [f.id]).includes(x.id))) && s.visuals?.length);
  const tm = threats ?? ai?.threats ?? [], where = (t) => { const w = t.where ?? {}, x = (ai?.access ?? []).find((r) => r.id === (typeof w === "string" ? w : w.access ?? w.id));
    return x ? `${flat(x.resource)} (${x.id})` : w.from !== undefined ? `${name(w.from)} → ${name(w.to)}` : flat(typeof w === "string" ? w : JSON.stringify(w)); };
  return doc(prLine({ pr, head }), "", `# Context to check ${list.length === 1 ? "a finding" : count(list.length, "finding")}`, "",
    ...list.flatMap((f, k) => [`## ${list.length > 1 ? `${k + 1}. ` : ""}${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks: ai?.asks ?? [], h: "###", extra: reachLines(f, ai) })]),
    ["## The map", "", !a ? "The analysis has no architecture picture for this PR." : [
      path.edges.length ? "The way from the entry to each finding is red." : "No way from an entry to these findings is on the map.", "", ...mermaidFlow(a, { path }), "",
      ...ways.filter(([, w]) => w?.nodes.length).map(([f, w]) => `- ${flat(f.title)}: ${w.nodes.map(name).join(" → ")}${w.card && !w.nodes.includes(w.card) ? ` (the finding sits on ${name(w.card)})` : ""}`), ""]],
    exposureMd(ai, "##"), blastMd(ai, "##"),
    tm.length > 0 && ["## Threat model", "", "From the security review: each place this PR opens or changes, the threat to it, and what was found.", "",
      ...table(["Id", "Where", "Boundary", "Threat", "Findings", "Result", "Note"], tm.map((t) => [t.id, where(t), typeof t.boundary === "string" ? t.boundary : t.boundary ? "yes" : "no", t.threat, (t.findings ?? []).join(", "), String(t.result ?? "").replace(/_/g, " "), t.note]))],
    unknown.length > 0 && ["## Not known from this PR", "", ...unknown, ""],
    steps.length > 0 && steps.map((s) => [`## Pictures of the layer "${flat(s.title)}"`, "", ...s.visuals.map((v) => visualMd(v))]));
}

// ---- the Resilience page as it stands, nothing folded: the verdict and its counts, the parts this PR adds (what each
// solves, costs and the simpler way), every path in its open form (blockers first: its verdict, the way as a Mermaid
// flowchart over the cards, what fails and who sees it, the retry ladder and the time budget as tables, a race as a
// table and a Mermaid sequence, a state's rule with its writers, the action, the probe with its script and output),
// the calls with their limits (the map's marks), other checks, the clean ones, what is not checkable, what nothing
// shows before the merge and what to watch after it. probes: review.js probesNow() (a probe's state, result, script
// and output), else the run's proposals; findings: the merged ones, for the titles behind a path's ids; cost: the
// run's; code: rowsOf(file) for the code blocks (a path's places, the ladder's lines).
const actorId = (k) => `A${k}`;
const STRENGTH = { runs_pr_code: "runs PR code", forced_schedule: "forced schedule", models_env: "models the environment" };
const BASE = { already_on_base: "already on the base", new_in_pr: "new in this PR", unknown: "unknown on the base", not_on_base: "not on the base" };
const ADD_RESULT = { justified: "justified", questionable: "questionable", unjustified: "solves nothing here" };
const excerpt = (text, max) => { const l = String(text ?? "").replace(/\s+$/, "").split("\n"); return l.length > max ? [...l.slice(0, max), `… (${l.length - max} more lines)`] : l; };
const fenced = (lang, lines) => { const tick = lines.some((l) => l.includes("```")) ? "````" : "```"; return [`${tick}${lang}`, ...lines, tick]; };
export function resilienceMd({ pr, head, res = null, names = new Map(), arch = null, findings = [], statusOf = () => "open", probes = null, cost = null, code = null }) {
  if (!res) return doc(prLine({ pr, head }), "", "# Resilience", "", "The resilience review has not run on this PR.");
  const cx = codeContext(code), nm = (id) => flat(names.get(id) ?? arch?.nodes?.find((n) => n.id === id)?.label ?? id);
  const byId = (id) => findings.find((f) => (f.ids ?? [f.id]).includes(id)), titles = (ids) => [...new Set((ids ?? []).map(byId).filter(Boolean))];
  const listed = resShown(res), order = listed.paths, num = (id) => listed.nums.get(id) ?? 0, say = listed.say; // the run's ids as the numbers shown
  const probeOf = (p) => (probes ?? res.probes ?? []).find((x) => x.id === p.probe || x.of === p.id);
  // The cards a path passes, in the order of its steps: a card, a call (both ends), a place (the card of its file).
  const edgeAt = (s) => { const e = /^e(\d+)$/.exec(String(s)); return e ? arch?.edges?.[Number(e[1])] ?? null : null; };
  const cardsOf = (p) => { const out = []; for (const s of p.steps ?? []) for (const id of edgeAt(s) ? [edgeAt(s).from, edgeAt(s).to] : [resCardOf(s, arch)]) if (id && !out.includes(id)) out.push(id); return out; };
  // The way as a picture: the cards it passes and the calls between them (pr.js viaOf's `via`, else its call steps and
  // every call between two cards it reaches), numbered in the map's order.
  const wayPic = (p) => { const ids = cardsOf(p), calls = [...new Set([...(p.via ?? []), ...(p.steps ?? [])].map(edgeAt).filter(Boolean))];
    const edges = (calls.length ? calls : (arch?.edges ?? []).filter((e) => ids.includes(e.from) && ids.includes(e.to))).filter((e) => ids.includes(e.from) && ids.includes(e.to));
    return ids.length < 2 || !edges.length ? [] : ["", ...mermaidFlow({ nodes: ids.map((id) => ({ id, label: nm(id) })), edges: edges.map((e, k) => ({ from: e.from, to: e.to, label: `${k + 1}. ${transitionText(e)}`.replace(/\. $/, ".") })) }), ""]; };
  // The way in words, as the page's line has it: each step's card, a call's both ends, a place without a card as it is.
  const wayOf2 = (p) => [...new Set((p.steps ?? []).flatMap((s) => (edgeAt(s) ? [nm(edgeAt(s).from), nm(edgeAt(s).to)] : /^e\d+$/.test(String(s)) ? [] : [nm(resCardOf(s, arch) ?? s)])).filter(Boolean))].join(" → ");
  const silent = (p) => (p.signal ? p.signal === "none" : !p.visible);
  const verdictOf = (p) => (p.wired ? `Blocks once wired: ${flat(p.wired.reason)}${p.wired.today ? `. Not today: ${flat(p.wired.today)}` : ""}`
    : p.blocker ? `${p.blocker.unclear ? "Blocker? old or new unclear" : "Blocker"}: ${flat(p.blocker.reason)}`
    : p.same_cause ? `same cause as path ${num(p.same_cause)}`
    : p.result === "mitigated" ? (p.limited_by ? `limited at \`${p.limited_by}\`` : "limited, no guard named")
    : p.result === "finding" ? (p.pre_existing === true ? "finding, already on the base" : "finding") : String(p.result ?? "").replace(/_/g, " "));
  // Old or new is said once: by the path where the diff dates it, else by the probe's run on the base (views.js probeBaseWord).
  const probeMd = (x, byDiff = false) => { if (!x) return ["- **Probe:** none proposed for this path."];
    const done = x.status === "done", bw = probeBaseWord(x, byDiff, BASE), base = bw ? `${bw.word}${x.base.line ? ` (${flat(x.base.line)})` : ""}` : x.base ? flat(x.base) : null;
    return [`- **Probe:** ${flat(x.claim ?? x.kind ?? "a script")} (${[x.kind && resWord(x.kind), STRENGTH[x.strength] ?? x.strength].filter(Boolean).join(", ")})`,
      `  - State: ${done ? `${String(x.result ?? "").replace(/_/g, " ")}${x.number ? `, ${flat(x.number)}` : ""}${x.head ? ` at ${String(x.head).slice(0, 7)}` : ""}${x.ms ? `, ${(x.ms / 1000).toFixed(1)} s` : ""}` : x.status === "running" ? "running" : "proposed, not run yet"}`,
      done && base && `  - On the base: ${base}`, done && Boolean(x.reason) && `  - ${flat(x.reason)}`,
      done && x.network_barrier !== undefined && x.network_barrier !== null && `  - Ran ${x.network_barrier ? "in a sandbox, without network" : "without a sandbox"}`,
      done && Boolean(x.script) && ["", "Probe script:", "", ...fenced("python", excerpt(x.script, 40)), ""],
      done && Boolean(x.output) && ["Probe output:", "", ...fenced("", excerpt(x.output, 20)), ""]]; };
  const path = (p, k) => {
    const fs = titles(p.findings), places = [...new Set([p.blocker?.at, p.limited_by, ...(p.steps ?? []), ...(p.ladder ?? []).map((r) => r.at)].filter((s) => /:\d+/.test(String(s ?? ""))))];
    const race = p.race?.steps?.length ? ["", `Race on ${flat(p.race.shared ?? "shared state")}${p.race.pattern ? ` (${flat(p.race.pattern)})` : ""}${p.race.possible_today === false ? `. Not possible today${p.race.note ? `: ${flat(p.race.note)}` : ""}` : ""}:`, "",
      ...table(["Step", "Who", "What", "Where"], p.race.steps.map(([who, text, at], j) => [`${j + 1}${j === p.race.breaks_at ? " (breaks here)" : ""}`, who, text, at ? `\`${at}\`` : ""])),
      "```mermaid", "sequenceDiagram", ...(p.race.actors ?? []).map((a, j) => `  participant ${actorId(j)} as ${alias(a)}`),
      ...p.race.steps.map(([who, text], j) => `  Note over ${actorId(Math.max(0, (p.race.actors ?? []).findIndex((a) => a === who || a.endsWith(` ${who}`))))}: ${ent(`${j === p.race.breaks_at ? "breaks here: " : ""}${text}`, /[#"<>|:;`]/g)}`), "```",
      typeof p.race.oncall === "string" && p.race.oncall && `What on-call sees: ${flat(p.race.oncall)}`, ""] : [];
    return [`### ${k + 1}. ${flat(p.trigger)}: ${flat(p.end)}`, "",
      `- **Verdict:** ${verdictOf(p)}`,
      wayOf2(p) && `- **Way:** ${wayOf2(p)}`,
      (p.failing ?? []).filter((x) => x !== "silent").length > 0 && `- **Fails by:** ${p.failing.filter((x) => x !== "silent").map(resWord).join(", ")}`,
      `- **Seen:** ${silent(p) ? "no, silent: no alarm, no log line, no metric names it" : flat(p.seen_as || p.seen || (p.signal ? `it shows in ${resWord(p.signal)}` : "yes"))}`,
      silent(p) && Boolean(p.seen_as) && `- **What on-call sees:** ${flat(p.seen_as)}`,
      Boolean(p.also_security) && "- Also in Security: a finding of this path is a security finding.",
      p.possible_today === false && !p.wired && "- Not possible today.",
      fs.length > 0 && [`- **Findings (${fs.length}):**`, ...fs.map((f) => `  - ${findingLine(f, statusOf(f))}`)],
      Boolean(p.action) && `- **Action:** ${flat(p.action)}`,
      Boolean(p.note) && `- **Note:** ${flat(p.note)}`,
      "", ...wayPic(p),
      p.ladder?.length > 0 && ["Retries and redeliveries on this path:", "", ...table(["Step", "Factor", "Where", "Note"], p.ladder.map((r) => [r.name, r.factor, r.at ? `\`${r.at}\`` : "", r.note ?? ""])), Boolean(p.product) && `Together: ${flat(p.product)}`, ""],
      p.budget && [`Time budget: worst case ${p.budget.value_s} s against the ${p.budget.limit_s} s timeout${p.budget.at ? ` (\`${p.budget.at}\`)` : ""}${p.budget.note ? `. ${flat(p.budget.note)}` : ""}`, ""],
      ...race,
      p.writers?.length > 0 && [`State ${flat(p.state ?? "")}${p.invariant ? `. Rule: ${flat(p.invariant)}` : ""}`, "",
        ...table(["", "Who", "Where", "Guard", ""], p.writers.map((w) => [w.kind === "R" ? "reads" : "writes", nm(w.node), w.at ? `\`${w.at}\`` : "", w.guard ?? "", w.breaks ? "breaks the rule" : ""]))],
      !p.ladder?.length && !p.budget && !p.race?.steps?.length && !p.writers?.length && [`(${resNoPicture(p)}.)`, ""],
      "",
      ...probeMd(probeOf(p), datedByDiff(p)), "",
      ...places.flatMap((s) => cx.at(s)), ""];
  };
  const parts = resVerdictParts(order), paths = res.paths ?? [], checks = res.checks ?? [], clean = checks.filter((c) => c.result === "clean"), ncheck = checks.filter((c) => c.result === "not_checkable");
  const other = checks.filter((c) => c.result !== "clean" && c.result !== "not_checkable");
  const check = (c) => `- ${flat(resWord(c.check))}${c.result !== "clean" && c.result !== "not_checkable" ? ` (${resWord(c.result)})` : ""}: ${flat(say(c.why) ?? "")}${c.at ? ` (\`${c.at}\`)` : ""}${titles(c.findings).length ? `. Findings: ${titles(c.findings).map((f) => flat(f.title)).join("; ")}` : ""}`;
  const w = resWatch(res, arch), watch = w.watch.length || w.before.length || (res.blind_spots ?? []).length ? w.watch.map((x) => `${flat(x.text)}${x.at ? ` (\`${x.at}\`)` : ""}`) : (res.watch ?? []).map(flat);
  const nc = [...ncheck.map((c) => `${flat(resWord(c.check))}: ${flat(say(c.why) ?? "")}`), ...(res.not_checked ?? []).filter((x) => !resToolText(x)).map((x) => flat(say(x)))];
  const adds = res.additions ?? [];
  const add = (x) => [`- **${flat(x.what)}**${x.kind ? ` (${flat(x.kind)})` : ""}${x.at ? ` at \`${x.at}\`` : ""}: ${ADD_RESULT[x.result] ?? flat(x.result)}`,
    Boolean(x.purpose) && `  - For: ${flat(x.purpose)}`, Boolean(x.solves) && `  - Solves: ${dot(x.solves)}${x.likelihood ? ` (${resWord(x.likelihood)})` : ""}.`,
    ...Object.entries(x.cost ?? {}).filter(([, v]) => v).map(([k2, v]) => `  - Costs ${resWord(k2)}: ${dot(v)}.`),
    Boolean(x.simpler) && `  - Simpler: ${flat(x.simpler)}`,
    x.works_today === false && `  - Works today: no, ${flat(x.broken_by || "the run says it does not")}`, x.works_today === true && "  - Works today: yes.",
    Boolean(x.next) && `  - Next: ${flat(x.next)}`, titles(x.findings).length > 0 && `  - Findings: ${titles(x.findings).map((f) => flat(f.title)).join("; ")}`];
  const lim = (d) => [d.timeout?.s !== undefined && d.timeout?.s !== null && `timeout ${d.timeout.s} s${d.timeout.source ? ` (${flat(d.timeout.source)})` : ""}`,
    d.retry && `retry ${d.retry.attempts ?? "?"}×${d.retry.backoff ? `, ${flat(d.retry.backoff)}` : ""}${d.retry.exhausted ? `, then ${resWord(d.retry.exhausted)}` : ""}`,
    d.trigger && `trigger: ${[d.trigger.batch && `batch ${d.trigger.batch}`, d.trigger.max_receive ? `max ${d.trigger.max_receive} receives` : "no receive limit", d.trigger.dlq ? "DLQ" : "no DLQ", d.trigger.visibility_s && `visibility ${d.trigger.visibility_s} s`].filter(Boolean).join(", ")}`,
    d.throttle && `throttle: ${flat(d.throttle)}`].filter(Boolean).join("; ");
  const callOf = (d) => { const e = /^e(\d+)$/.exec(String(d.edge ?? "")), x = e ? arch?.edges?.[Number(e[1])] : null; return x ? `${nm(x.from)} → ${nm(x.to)}` : d.node ? nm(d.node) : ""; };
  const blockers = order.filter((p) => p.blocker).length;
  // Dependencies that fail or are overloaded: a line each, its cases under it with the path (by its number here) that
  // shows how the case spreads, and what happens then.
  const depRows = resDepRows(res, order), down = depRows.flatMap((d) => [`- ${flat(d.dep)} (${[d.what, d.entry && `from ${flat(d.entry)}`, d.at].filter(Boolean).join(", ")})`,
    ...d.cases.map((c) => `  - ${flat(c.text)}${c.number ? `, path ${c.number}` : c.at ? ` (${c.at})` : ""}${c.effect ? `. ${flat(c.effect)}` : ""}`),
    ...(d.open.length ? [`  - The code cannot tell: ${d.open.join(", ")}.`] : [])]);
  const trees = faultTrees(res, order, num);
  return doc(prLine({ pr, head }), "", "# Resilience", "",
    parts ? [parts.head, parts.counts.length > 0 && parts.counts.join(" · ")] : flat(res.summary ?? (paths.length ? "No path grows without limit or doubles an effect." : "")),
    [`${count(paths.length, "path")}`, `${count(clean.length, "check")} clean`, `${ncheck.length + (res.not_checked ?? []).length} not checkable`, res.head && `analysis of ${String(res.head).slice(0, 7)}`, cost !== null && cost !== undefined && `$${Number(cost).toFixed(2)}`].filter(Boolean).join(" · "),
    res.older && "This analysis read an older head of the PR.", Boolean(res.edgeNote) && "This run is older than the numbered calls of the picture, so a ladder or a mark may sit one call off. A new run fixes that.", "",
    adds.length > 0 && [`## Parts this PR adds (${adds.length})`, "", flat(res.additionsLine ?? `This PR adds ${count(adds.length, "part")}.`), "", ...adds.flatMap(add), ""],
    [`## Paths (${order.length}${blockers ? `, ${blockers} ${blockers === 1 ? "blocks" : "block"} the merge` : order.length ? ", all limited" : ""})`, "", "The ways a failure spreads, blockers first, each in full.", "", ...order.flatMap(path)],
    arch?.nodes?.length > 0 && ["## Map", "", "The map the paths run on: the systems as frames, every card and call.", "", ...mermaidFlow(mapArch(arch, [], []), { systems: true }), "",
      ...arch.nodes.filter((n) => n.description).map((n) => `- **${nm(n.id)}:** ${flat(n.description)}`), ""],
    (res.deps ?? []).length > 0 && [`## Calls and their limits (${res.deps.length})`, "", "What the map marks at a call: its timeout, retries and how a queue redelivers.", "",
      ...table(["Call", "Where", "Mode", "Limits"], res.deps.map((d) => [callOf(d), d.at ? `\`${d.at}\`` : "", d.mode ?? "", lim(d)]))],
    down.length > 0 && [`## When a dependency fails (${depRows.length})`, "", ...down, ""],
    trees.length > 0 && [`## When a dependency fails, step by step (${trees.length})`, "", FAULT_NOTE, "", ...trees.flatMap(({ tree }) => [`### ${flat(tree.title)}`, "", ...mermaidFlow(faultFlow(tree)), ""])],
    timelineMd(timelineOf(res, arch), num),
    other.length > 0 && [`## Other checks (${other.length})`, "", ...other.map(check), ""],
    clean.length > 0 && [`## Checked, clean (${clean.length})`, "", ...clean.map(check), ""],
    nc.length > 0 && [`## Not checkable (${nc.length})`, "", ...nc.map((x) => `- ${x}`), ""],
    w.before.length > 0 && [`## Before merge, not observable (${w.before.length})`, "", ...w.before.map((x) => `- ${flat(x.text)}${x.at ? ` (\`${x.at}\`)` : ""}`), ""],
    [`## After merge, watch (${watch.length})`, "", ...(watch.length ? watch.map((x) => `- ${x}`) : ["Nothing named."]), ""]);
}
