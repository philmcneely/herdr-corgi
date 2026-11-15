// The review as Markdown, to copy and hand to an agent or a person ("Copy this page as Markdown"): the Overview, a
// finding or all unresolved ones, a layer, the architecture and the Security page. Pure: each function takes the
// analysis as review.js holds it (pr.js mapReview), the merged findings (pr.js mergeFindings) and their states, and
// returns text that starts with the PR and commit it is about. Pictures are Mermaid: an agent reads it as text and
// GitHub draws it. A security finding is in here in full: this is for the person's own use, nothing is posted.
import { taskList, taskHead, verdictParts, findingCounts, componentLine, CERTAINTY, SEVERITY_SCALE, levels } from "./pr.js";
import { transitionText } from "./arch.js";
import { resPathView } from "./views.js";
import { resWord, resToolText, resVerdict, resWatch } from "./views.js"; // wave R2: the page's words, verdict and watch list

const STATE = { open: "Unresolved", progress: "Fix sent", fixed: "Fixed", dismissed: "Dismissed", recheck: "Unresolved, line changed" };
const SOURCE = { analysis: "Analysis", security: "Security review", claude: "Claude code review", codex: "Codex review", ai: "AI note" };
const ASK = { met: "met", partly: "partly", broken: "broken", not_done: "not done", extra: "extra" };
const KIND = { architecture: "Architecture", flow: "Flow", sequence: "Sequence", state_machine: "State diagram", steps: "Steps" };
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const unresolved = (st) => st !== "fixed" && st !== "dismissed";
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The parts of a text, nested as they come; "" is a blank line, false and null are left out (so a condition on a
// string that may be empty is written Boolean(x) && …).
const doc = (...parts) => `${parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false).join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;

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
export function mermaidFlow({ nodes = [], edges = [], groups = [], zones = [] }, { path = null } = {}) {
  const all = uniq(nodes), known = new Set(all.map((n) => n.id));
  for (const e of edges) for (const id of [e.from, e.to]) if (id !== undefined && !known.has(id)) { known.add(id); all.push({ id, label: id, outside: true }); }
  const id = idsOf(all, "n"), zs = (zones ?? []).filter((z) => z?.id !== undefined);
  const frames = zs.length ? zs.map((z, k) => ({ key: `zone${k}`, label: `${z.name ?? z.id}${z.trust ? ` (trust: ${z.trust})` : ""}`, own: (n) => n.zone === z.id }))
    : groups.map((g, k) => ({ key: `group${k}`, label: `${g.label ?? g.id}${g.kind ? ` (${g.kind})` : ""}`, own: (n) => n.group === g.id }));
  const card = (n, pad) => `${pad}${id.get(n.id)}["${quoted(n.label ?? n.id)}${notes(n)}"]${cardStatus(n) ? `:::${cardStatus(n)}` : ""}`;
  const loose = all.filter((n) => !frames.some((f) => f.own(n)));
  const used = new Set(all.map(cardStatus).filter(Boolean));
  const drawn = edges.map((e, k) => [e, k]).filter(([e]) => id.has(e.from) && id.has(e.to)), lit = new Set(path?.edges ?? []), onPath = (path?.nodes ?? []).filter((n) => id.has(n));
  return fence(["flowchart LR",
    ...frames.flatMap((f) => { const own = all.filter(f.own); return own.length ? [`  subgraph ${f.key}["${quoted(f.label)}"]`, ...own.map((n) => card(n, "    ")), "  end"] : []; }),
    ...loose.map((n) => card(n, "  ")),
    ...drawn.map(([e]) => {
      const text = `${quoted(transitionText(e))}${notes(e, [cardStatus(e), e.crosses && "crosses a trust boundary"])}`.trim();
      return `  ${id.get(e.from)} ${e.source === "spec" ? "-.->" : e.crosses ? "==>" : "-->"}${text ? `|"${text}"|` : ""} ${id.get(e.to)}`;
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
export function visualMd(v, h = "###") {
  const edges = [...(v.edges ?? []), ...(v.transitions ?? [])], nodes = uniq(v.nodes);
  const lv = v.kind === "steps" ? levels(nodes, edges) : null;
  const body = v.kind === "state_machine" ? mermaidState(v) : v.kind === "sequence" ? mermaidSequence(v)
    : v.kind === "steps" ? [...nodes].sort((a, b) => lv.get(a.id) - lv.get(b.id)).map((n, k) => `${k + 1}. ${flat(n.label ?? n.id)}${n.note ? `: ${flat(n.note)}` : ""}${n.at ? ` (\`${n.at}\`)` : ""}`)
    : mermaidFlow({ nodes, edges });
  return [`${h} ${KIND[v.kind] ?? v.kind}${v.title ? `: ${flat(v.title)}` : ""}`, "", ...body, ""];
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
function findingBody(f, { status = "open", asks = [], h = "##", extra = [] }) {
  const broken = asks.filter((a) => (a.findings ?? []).some((x) => f.ids.includes(x)) || (f.criteria ?? []).includes(a.id));
  const others = (f.sources ?? []).filter((s) => s.title !== f.title || s.detail !== f.detail);
  return [
    `- **Severity:** ${f.severity}${SEVERITY_SCALE[f.severity] ? `. On this scale, ${f.severity} means: ${SEVERITY_SCALE[f.severity]}` : ""}${f.impact ? `. Here: ${String(f.impact).replace(/_/g, " ")}` : ""}.`,
    `- **Where:** ${where(f)}`,
    `- **State:** ${STATE[status] ?? status}`,
    (f.sources ?? []).length > 0 && `- **Found by:** ${f.sources.map((s) => `${SOURCE[s.reviewer] ?? s.reviewer} (${s.severity})`).join(", ")}`,
    Boolean(f.category) && `- **Category:** ${f.category}${f.security && f.category !== "security" ? ", security" : ""}`,
    Boolean(f.certainty) && `- **Certainty:** ${CERTAINTY[f.certainty]}`,
    f.preconditions?.length > 0 && ["- **Preconditions:**", ...f.preconditions.map((p) => `  - ${flat(p)}`)],
    Boolean(f.certainty) && !f.preconditions?.length && "- **Preconditions:** none, it always happens",
    broken.length > 0 && ["- **Breaks these criteria:**", ...broken.map((a) => `  - ${ASK[a.state] ?? a.state}: ${flat(a.text)}`)],
    ...extra,
    "",
    Boolean(f.effect) && [`${h} Effect`, "", f.effect.trim(), ""],
    Boolean(f.detail) && [`${h} Detail`, "", f.detail.trim(), ""],
    Boolean(f.suggestion) && [`${h} Suggestion`, "", f.suggestion.trim(), ""],
    others.length > 0 && [`${h} Also reported as`, "", ...others.map((s) => `- ${SOURCE[s.reviewer] ?? s.reviewer} (${s.severity}): ${flat(s.title)}${s.detail ? `. ${flat(s.detail)}` : ""}`), ""],
  ];
}

export const findingMd = (f, { pr, head, status = "open", asks = [] } = {}) => doc(prLine({ pr, head }), "", `# Finding: ${flat(f.title)}`, "", findingBody(f, { status, asks }));

const bySeverity = (list) => [...list].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
const sevCount = (list) => ["high", "medium", "low"].map((k) => [k, list.filter((f) => f.severity === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
const numbered = (list, statusOf, asks, h) => list.flatMap((f, k) => [`${h} ${k + 1}. ${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks, h: `${h}#` })]);

// Every unresolved finding, most severe first.
export function findingsMd(findings, { pr, head, statusOf = () => "open", asks = [] } = {}) {
  const list = bySeverity(findings.filter((f) => unresolved(statusOf(f))));
  return doc(prLine({ pr, head }), "", `# ${count(list.length, "unresolved finding")}${list.length ? `: ${sevCount(list)}` : ""}`, "", numbered(list, statusOf, asks, "##"));
}

// ---- the Overview

// checks: pr.js preMergeChecks; related: related.py's context (stacked_on).
export function overviewMd({ pr, head, ai = null, findings = [], statusOf = () => "open", checks = [], related = null }) {
  const list = taskList(ai?.asks ?? [], findings, ai?.unlinked ?? [], statusOf), verdict = ai || findings.length ? verdictParts(list, findingCounts(findings, statusOf), { failed: checks.filter((c) => c.ok === false).length }) : [];
  const line = (f) => `- ${findingLine(f, statusOf(f))}`;
  const ask = (r) => [`- **${ASK[r.ask.state] ?? r.ask.state}**: ${flat(r.ask.text)}`, Boolean(r.ask.why) && `  - Why: ${flat(r.ask.why)}`, r.unlinked && "  - No finding backs this state.", ...r.findings.map((f) => `  ${line(f)}`)];
  const marked = list.rows.filter((r) => list.marked && r.ask.acceptance), rest = list.rows.filter((r) => !marked.includes(r)), hasTask = list.rows.length + list.extra.length > 0;
  const mark = (ok) => (ok === true ? "passed" : ok === false ? "failed" : ok === null ? "pending" : "n/a");
  const rules = [...checks.filter((c) => !c.rule).map((c) => `- ${mark(c.ok)}: ${flat(c.name)}${c.ok !== true && c.why ? `. ${flat(c.why)}` : ""}`),
    ...(ai?.rules ?? []).map((r) => `- ${mark(r.status === "pass" ? true : r.status === "fail" ? false : undefined)}: ${flat(r.rule)} (${[r.source, r.where && `\`${r.where}\``].filter(Boolean).join(", ")})${r.why ? `. ${flat(r.why)}` : ""}`)];
  return doc(prLine({ pr, head }), "", `# Review overview: ${flat(pr.title)}`, "",
    verdict.length > 0 && `**Verdict:** ${verdict.map((p) => p.text).join(" · ")}`,
    ai?.mergeRisk && `**Merge risk:** ${ai.mergeRisk.level}${ai.mergeRisk.why ? `. ${flat(ai.mergeRisk.why)}` : ""}`,
    related?.stacked_on && `**Stacked on:** #${related.stacked_on.number} ${flat(related.stacked_on.title)}${related.stacked_on.url ? ` (${related.stacked_on.url})` : ""}. This PR merges after it.`,
    componentLine(ai?.componentCounts) && `**Components:** ${componentLine(ai.componentCounts)}`,
    !ai && "No analysis of this diff yet: the findings below come from the reviewers.", "",
    (hasTask || list.security.length + list.other.length > 0) && [`## ${hasTask ? `Check against the task: ${taskHead(list)}` : "Unresolved findings"}`, "",
      list.security.length > 0 && ["### Security", "", ...list.security.map(line), ""],
      marked.length > 0 && ["### Acceptance criteria", "", ...marked.map(ask), ""],
      rest.length > 0 && [`### ${list.marked ? "Also in the description" : "Criteria"}`, "", ...rest.map(ask), ""],
      list.extra.length + list.other.length > 0 && [`### ${hasTask ? "Not in the task" : "Other findings"}`, "", ...list.extra.map(ask),
        hasTask && list.other.length > 0 && `- ${count(list.other.length, "unresolved finding")} ${list.other.length === 1 ? "belongs" : "belong"} to no criterion:`, ...list.other.map((f) => `${hasTask ? "  " : ""}${line(f)}`), ""]],
    Boolean(ai?.summary) && ["## What changed", "", ai.summary.trim(), ""],
    (ai?.behaviorPoints?.length || ai?.behavior) && ["## Behavior", "", ai.behaviorPoints?.length ? ai.behaviorPoints.map((x) => `- ${flat(x.text)}${x.source === "spec" ? " (spec only)" : ""}${x.evidence ? ` (\`${x.evidence}\`)` : ""}`) : ai.behavior.trim(), ""],
    rules.length > 0 && ["## Repo rules and checks", "", ...rules, ""]);
}

// ---- a layer

// step: a layer of the analysis; n: its number as shown; files: the files its hunks are in; findings: the layer's.
export function layerMd(step, { pr, head, n = null, files = [], findings = [], statusOf = () => "open" } = {}) {
  const open = bySeverity(findings.filter((f) => unresolved(statusOf(f))));
  const flow = (f) => [`- \`${flat(f.function)}\`${f.at ? ` at \`${f.at}\`` : ""}`,
    ...(f.inputs ?? []).map((i) => `  - in: \`${flat(i.name)}\` (${flat(i.type)})${i.example ? `, for example \`${flat(i.example)}\`` : ""}`),
    f.output && `  - out: ${flat(f.output.type)}${f.output.example ? `, for example \`${flat(f.output.example)}\`` : ""}`,
    f.side_effects?.length > 0 && `  - side effects: ${f.side_effects.map(flat).join("; ")}`, f.calls?.length > 0 && `  - calls: ${f.calls.map((c) => `\`${flat(c)}\``).join(", ")}`];
  return doc(prLine({ pr, head }), "", `# Layer${n ? ` ${n}` : ""}: ${flat(step.title)}`, "",
    Boolean(step.risk) && `**Risk:** ${step.risk === "skim" ? "low, skimmed by the analysis" : step.risk}`, Boolean(step.why) && `**Why it matters:** ${flat(step.why)}`, "",
    Boolean(step.text) && [step.text.trim(), ""],
    files.length > 0 && ["## Files", "", ...files.map((f) => `- \`${f}\``), ""],
    step.questions?.length > 0 && ["## Questions to check", "", ...step.questions.map((q, k) => `- ${step.questionFiles?.[k] ? `\`${step.questionFiles[k]}\`: ` : ""}${flat(q)}`), ""],
    [`## Findings: ${open.length ? `${open.length} unresolved, ${sevCount(open)}` : "none unresolved"}`, "", ...open.map((f) => `- ${findingLine(f, statusOf(f))}`), ""],
    step.visuals?.length > 0 && ["## Pictures", "", ...step.visuals.map((v) => visualMd(v))],
    step.flows?.length > 0 && ["## Functions with example values", "", ...step.flows.map(flow), ""]);
}

// ---- the architecture

// The map as a Mermaid flowchart, the cards with what they are, where an unresolved finding breaks the flow, the
// components with owner and what is to operate, then the analysis' other pictures of the whole PR.
export function architectureMd({ pr, head, ai, findings = [], statusOf = () => "open" }) {
  const a = ai?.arch, nodes = a?.nodes ?? [], name = (id) => flat(nodes.find((n) => n.id === id)?.label ?? id);
  // With trust zones the diagram's frames are the zones: each card names its group and zone here instead.
  const zones = a?.zones ?? [], group = (n) => flat((a.groups ?? []).find((g) => g.id === n.group)?.label ?? ""), zone = (n) => { const z = zones.find((x) => x.id === n.zone); return z ? `${flat(z.name ?? z.id)} (${z.trust ?? "trust not stated"})` : "none"; };
  const breaks = bySeverity(findings.filter((f) => f.breaks && unresolved(statusOf(f))));
  const st = (k) => nodes.filter((n) => cardStatus(n) === k).length;
  const sums = [["new", st("new")], ["changed", st("changed")], ["removed", st("removed")]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
  return doc(prLine({ pr, head }), "", "# Architecture impact", "",
    !a && "The analysis has no architecture picture for this PR.",
    a && [`${count(nodes.length, "card")}${sums ? `: ${sums}` : ""}. A card's class in the diagram is its status; a dashed call is only in the spec${(a.zones ?? []).length ? "; the frames are trust zones, a thick call crosses a trust boundary" : ""}.`, componentLine(ai.componentCounts) && `${componentLine(ai.componentCounts)}.`, "", ...mermaidFlow(a), "",
      "## Cards", "", ...nodes.map((n) => `- **${flat(n.label ?? n.id)}** (${[cardStatus(n) ?? "unchanged", n.type, n.source === "spec" && "spec only", zones.length && group(n) && `in ${group(n)}`, zones.length && `zone: ${zone(n)}`, n.at && `\`${n.at}\``].filter(Boolean).join(", ")})${n.description ? `: ${flat(n.description)}` : ""}`), ""],
    breaks.length > 0 && ["## Where the flow breaks", "", ...breaks.map((f) => `- ${f.breaks.node ? `Card ${name(f.breaks.node)}` : `Call ${name(f.breaks.from)} → ${name(f.breaks.to)}`}: ${findingLine(f, statusOf(f))}`), ""],
    ai?.components?.length > 0 && ["## Components", "", ...table(["Component", "Kind", "Status", "Where", "Owner", "To operate"],
      ai.components.map((c) => [c.name, c.kind, c.status, c.at ? `\`${c.at}\`` : "", c.owner ?? "no owner", (c.operate ?? []).join("; ")]))],
    ai?.visuals?.length > 0 && ["## Other pictures", "", ...ai.visuals.map((v) => visualMd(v))]);
}

// ---- the Security page

const AREAS = ["authentication", "authorization", "input_validation", "secrets", "permissions", "personal_data", "dependencies"];
const scopeRows = (checked) => table(["Area", "Result", "Note"], (checked ?? []).map((c) => [String(c.area ?? "").replace(/_/g, " "), String(c.result ?? "").replace(/_/g, " "), c.note ?? ""]));
// The unresolved security findings in full, who can reach what (the analysis' access list) and what was looked at:
// the analysis' security areas and each reviewer run that looked at one (or does not say what it looked at) with what
// it read, checked and skipped. runs: pr.js runsOf.
export function securityMd({ pr, head, ai = null, findings = [], statusOf = () => "open", runs = {} }) {
  const list = bySeverity(findings.filter((f) => f.security && unresolved(statusOf(f)))), own = (ai?.scope?.checked ?? []).filter((c) => AREAS.includes(c.area));
  const shown = Object.entries(runs).filter(([kind, r]) => kind === "security" || !r.scope?.checked?.length || r.scope.checked.some((c) => AREAS.includes(c.area)));
  const run = ([kind, r]) => [`### ${SOURCE[kind] ?? kind}: ${r.state ?? "not run"}${r.model ? ` (${r.model})` : ""}`, "", Boolean(r.error) && `Error: ${flat(r.error)}`,
    r.scope?.read?.length > 0 && `Read: ${r.scope.read.map(flat).join("; ")}`, "", ...scopeRows(r.scope?.checked), r.scope?.skipped?.length > 0 && ["Skipped:", ...r.scope.skipped.map((s) => `- ${flat(s)}`)], ""];
  const ordered = byReach(list, ai);
  return doc(prLine({ pr, head }), "", "# Security", "", `${count(list.length, "unresolved security finding")}${list.length ? `: ${sevCount(list)}` : ""}.${list.length > 1 ? " Most reachable first: from the internet before signed-in callers before inside only, then over a trust boundary, then severity." : ""}`, "",
    ordered.length > 0 && ["## Findings", "", ...ordered.flatMap((f, k) => [`### ${k + 1}. ${flat(f.title)}`, "", findingBody(f, { status: statusOf(f), asks: ai?.asks ?? [], h: "####", extra: reachLines(f, ai) })])],
    exposureMd(ai, "##"), blastMd(ai, "##"),
    grantsOf(ai?.access).length > 0 && ["## Rights granted", "", ...table(["Resource", "Kind", "Who", "May", "Auth", "Used by the code", "Where"],
      grantsOf(ai.access).map((x) => [x.resource, x.kind, x.principal, (x.actions ?? []).join("; "), x.auth, x.used === undefined ? "" : x.used ? "yes" : "no", x.at ? `\`${x.at}\`` : ""]))],
    ["## What was checked", "", "Each list is the model's own report of what it looked at.", "",
      own.length > 0 && ["### Analysis", "", ...scopeRows(own)], !own.length && ["### Analysis", "", ai ? "This analysis does not say which areas it checked." : "No analysis of this diff yet.", ""],
      ...shown.map(run), !shown.length && "No reviewer has looked at security."]);
}

// ---- ways in, the way to a finding, what a taken-over zone may do

// A way in: everything public, and routes, endpoints and APIs; the other access rows are rights granted. How it is
// checked: `auth_kind` (none | code | gateway | iam) when the analysis has it, else the first word of the free text.
// ponytail: the same rule as views.js surfaceOf/exposureOf (Security page package); use those once both are merged.
const isEntry = (x) => Boolean(x.public) || /route|endpoint|api|url|http|gateway|ingress/i.test(String(x.kind ?? ""));
const unchecked = (x) => (x.auth_kind ? x.auth_kind === "none" : /^(|none|no|nothing|unauthenticated|-|–)$/i.test(String(x.auth ?? "").trim().replace(/[\s.(:;,].*$/, "")));
const entriesOf = (access) => (access ?? []).filter(isEntry).map((x, k) => ({ x, k, r: !x.public ? 2 : unchecked(x) ? 0 : 1 })).sort((a, b) => a.r - b.r || a.k - b.k).map(({ x }) => x);
const grantsOf = (access) => (access ?? []).filter((x) => !isEntry(x));
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
    const rights = access.filter((x) => names.has(norm(x.principal)));
    const out = (a?.edges ?? []).filter((e) => own.some((n) => n.id === e.from) && zoneOf(e.to) !== z.id);
    const reached = [...new Set(out.map((e) => zoneOf(e.to)).filter(Boolean))].map((id) => zones.find((x) => x.id === id)).filter(Boolean);
    const free = [...new Set(out.filter((e) => !zoneOf(e.to)).map((e) => e.to))];
    const can = rights.length ? `it can ${rights.map(right).join("; ")}` : "no right in this PR names it";
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

// ---- the Resilience page: its paths (blockers first) with their ladder as text, budget, race as a Mermaid sequence,
// the action and the probe; then other checks, not checkable and what to watch after the merge.
const actorId = (k) => `A${k}`;
export function resilienceMd({ pr, head, res = null, names = new Map(), arch = null }) {
  if (!res) return doc(prLine({ pr, head }), "", "# Resilience", "", "The resilience review has not run on this PR.");
  const name = (s) => (/^e\d+$/.test(s) ? null : names.get(s) ?? s);
  const order = [...(res.paths ?? [])].map((p) => resPathView(p, res)).sort((a, b) => Number(Boolean(b.blocker)) - Number(Boolean(a.blocker)));
  const probe = (p) => (res.probes ?? []).find((x) => x.id === p.probe || x.of === p.id);
  const path = (p, k) => {
    const pr2 = probe(p), way = [...new Set((p.steps ?? []).map(name).filter(Boolean))].join(" → ");
    const race = p.race?.steps?.length ? ["", "```mermaid", "sequenceDiagram", ...(p.race.actors ?? []).map((a, j) => `  participant ${actorId(j)} as ${quoted(a)}`),
      ...p.race.steps.slice(0, 6).map(([who, text], j) => `  Note over ${actorId(Math.max(0, (p.race.actors ?? []).indexOf(who)))}: ${ent(`${j === p.race.breaks_at ? "breaks here: " : ""}${text}`, /[#"<>|:;`]/g)}`), "```"] : [];
    return [`## ${k + 1}. ${flat(p.trigger)}: ${flat(p.end)}`, "",
      `- Verdict: ${p.blocker ? `Blocker: ${flat(p.blocker.reason)}` : p.result === "mitigated" ? `limited${p.limited_by ? ` at ${p.limited_by}` : ""}` : String(p.result ?? "").replace(/_/g, " ")}`,
      way && `- Way: ${way}`, p.failing?.length && `- Failing: ${p.failing.map(resWord).join(", ")}`, `- Seen: ${(p.signal ? p.signal === "none" : !p.visible) ? "no, silent" : flat(p.seen_as || p.seen || (p.signal ? resWord(p.signal) : "yes"))}`,
      ...(p.ladder ?? []).map((r) => `- ${flat(r.name)}: ${flat(r.factor)}${r.at ? ` (${r.at})` : ""}${r.note ? `, ${flat(r.note)}` : ""}`),
      p.product && `- Together: ${flat(p.product)}`,
      p.budget && `- Budget: worst case ${p.budget.value_s} s against ${p.budget.limit_s} s${p.budget.at ? ` (${p.budget.at})` : ""}${p.budget.note ? `: ${flat(p.budget.note)}` : ""}`,
      p.action && `- Action: ${flat(p.action)}`,
      pr2 && `- Probe: ${pr2.status === "done" ? `${String(pr2.result).replace(/_/g, " ")}${pr2.number ? `, ${flat(pr2.number)}` : ""}${pr2.head ? ` at ${String(pr2.head).slice(0, 7)}` : ""}` : "not run yet"}`,
      p.note && `- Note: ${flat(p.note)}`, ...race, ""];
  };
  const checks = (res.checks ?? []).filter((c) => c.result !== "not_checkable").map((c) => `- ${c.check}: ${String(c.result).replace(/_/g, " ")}${c.why ? `, ${flat(c.why)}` : ""}${c.at ? ` (${c.at})` : ""}`);
  const w = resWatch(res, arch), watch = w.watch.length || w.before.length || (res.blind_spots ?? []).length ? w.watch.map((x) => x.text) : res.watch ?? [];
  const nc = [...(res.checks ?? []).filter((c) => c.result === "not_checkable").map((c) => `${c.check}: ${c.why ?? ""}`), ...(res.not_checked ?? []).filter((x) => !resToolText(x))];
  return doc(prLine({ pr, head }), "", "# Resilience", "", flat(resVerdict(order) ?? res.summary ?? ""), res.head ? `Analysis of ${String(res.head).slice(0, 7)}.` : "", "", ...order.map(path),
    checks.length ? ["## Other checks", "", ...checks, ""] : [], nc.length ? ["## Not checkable", "", ...nc.map((x) => `- ${flat(x)}`), ""] : [],
    w.before.length ? ["## Before merge, not observable", "", ...w.before.map((x) => `- ${flat(x.text)}${x.at ? ` (${x.at})` : ""}`), ""] : [],
    watch.length ? ["## After merge, watch", "", ...watch.map((x) => `- ${flat(x)}`)] : []);
}
