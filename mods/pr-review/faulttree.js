// The Resilience page's fault tree for a case of "When a dependency fails": when dependency X is slow, overloaded or
// down, answers wrong or comes back, what follows from it, step by step, down to what a caller and on-call see. The
// root is the case (resilience.downstream[].cases[]) with what the code does at its line, then, from the path the run
// names for it (the one that shows how the case spreads), that path's repeats (its retry ladder), where it ends and
// its verdict, and as leaves what is seen outside: what the caller gets, what on-call sees (or that nothing shows
// it), and whether it can happen today. Pure: → a picture {kind, title, nodes, edges} the flow engine draws (stack.js
// faultTreeView, arch.js archLayout) and markdown.js writes as a Mermaid flowchart.
//
// Nothing is read anew and nothing is guessed: every card is a field of the case or of its path. A case without a
// path has no tree: its row on the page already says all the run knows about it.
import { WHEN_IS } from "./pr.js";

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const HANDLED = { yes: "✓ handled", partly: "~ partly handled", no: "✗ not handled", not_checkable: "? not checkable" };
export const FAULT_NOTE = "Put together from each case and the path the run names for it; a step the run does not name is not drawn.";

// A path's verdict in a word or two, as its row on the page says it.
const verdictOf = (p) => (p.blocker ? (p.blocker.unclear ? "blocker? old or new unclear" : "blocker") : p.wired ? "blocks once wired" : p.result === "mitigated" ? "limited" : p.result === "not_assessed" ? "not assessed" : "finding");

// dep: an entry of resilience.downstream; c: one of its cases; path: the case's path in the page's shape (views.js
// resPathView) or null; number: that path's number on the page. A card's `at` is its line in the code, or
// "path:<id>" for the card that stands for the path (a click opens it on the page). null: fewer than three cards.
export function faultTree(dep, c, path = null, number = null) {
  if (!dep || !c) return null;
  const nodes = [], edges = [], add = (from, label, n) => { nodes.push(n); if (from) edges.push({ from, to: n.id, label }); return n.id; };
  const title = `${flat(dep.dep)} ${WHEN_IS[c.when] ?? flat(c.when)}`;
  let last = add(null, "", { id: "case", label: title, description: [HANDLED[c.handled] ?? flat(c.handled), flat(c.how)].filter(Boolean).join(": "), at: c.at || dep.at || undefined });
  if (path) {
    const ladder = Array.isArray(path.ladder) ? path.ladder : [];
    if (ladder.length) last = add(last, "repeats", { id: "again", label: flat(path.product) || ladder.map((r) => r.factor).join(" "), description: ladder.map((r) => `${flat(r.name)} ${r.factor}`).join("; "), at: ladder.find((r) => r.at)?.at });
    last = add(last, "ends in", { id: "end", label: `Path ${number ?? path.id}: ${verdictOf(path)}`, description: flat(path.end), at: `path:${path.id}` });
  }
  if (flat(c.effect)) add(last, "", { id: "caller", label: "The caller gets", description: flat(c.effect) });
  if (path) {
    const silent = path.signal ? path.signal === "none" : path.visible === false, seen = flat(path.seen_as || path.seen);
    if (silent || seen) add("end", "", { id: "oncall", label: silent ? "✕ silent" : "On-call sees", description: seen || "No alarm, no log line and no metric names it." });
    const today = path.wired?.today ?? (path.possible_today === false ? path.note || "something else keeps it from happening" : null);
    if (today) add("end", "", { id: "today", label: "Not possible today", description: flat(today).replace(/^not possible today:?\s*/i, "") });
    else if (path.possible_today === true) add("end", "", { id: "today", label: "Possible today", description: "It can happen as the code stands." });
  }
  return nodes.length < 3 ? null : { kind: "tree", title: `${title}${dep.entry ? `, from ${flat(dep.entry)}` : ""}`, nodes, edges };
}

// Every decided case's tree, in the order of the page: [{k: the dependency's index, when, tree}]. A case the code
// cannot decide has none: nothing follows from it that the run could name. paths: the page's paths (resPathView),
// num(id): a path's number there.
export function faultTrees(res, paths = [], num = () => null) {
  return (res?.downstream ?? []).flatMap((d, k) => (d.cases ?? []).filter((c) => c.handled !== "not_checkable").map((c) => { const p = c.path ? paths.find((x) => x.id === c.path) ?? null : null; return { k, when: c.when, tree: faultTree(d, c, p, p ? num(p.id) : null) }; }))
    .filter((x) => x.tree);
}

// A tree for a Mermaid flowchart (markdown.js mermaidFlow): each card's words in its label, since a text has no tooltip.
export const faultFlow = (tree) => ({ nodes: tree.nodes.map((n) => ({ id: n.id, label: n.description ? `${n.label}: ${n.description}` : n.label })), edges: tree.edges });
