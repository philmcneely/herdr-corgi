// The Security page's picture "Where sensitive data goes": which sensitive field (a credential, a secret, personal
// data, what users wrote) takes which crossing of the boundary map and where it ends (a log, an error message, a
// queue, a store, a third party). No map of its own: a chip per kind of data over the step list; a chosen one lights
// its way on the boundary map (its cards in `path`, the crossings it takes in `crossed`). Pure: the security run's
// `data` and the page's crossings (views.js crossingsOf) → the model (dataflowOf) → Markdown (dataflowMd).
//
// Nothing is guessed. A run that names its data (security.data) is shown as it says; a protection or a retention rule
// it leaves empty is "not stated", and only then a step is marked. A run from before that field names what goes over
// a crossing only as words (gates[].carries): of those, a word that says its kind itself ("Authorization header") is
// shown as sorted by its name, without marks, and the rest is counted as not classified.

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const KINDS = ["credential", "secret", "personal", "content", "other"];
export const SINKS = ["log", "error", "queue", "store", "third_party", "response"];
const KIND_NOUN = { credential: ["credential", "credentials"], secret: ["secret", "secrets"], personal: ["personal field", "personal fields"], content: ["content field", "content fields"], other: ["sensitive field", "sensitive fields"] };
const SINK_VERB = { log: "Written to a log at", error: "Put into an error message at", queue: "Kept on a queue at", store: "Stored at", third_party: "Sent to a third party at", response: "Returned in a response at" };
const KEEPS = ["log", "queue", "store"]; // where it stays: a retention rule is to name
// What is marked at a step, worst first: [key, one field …, several fields …, at the step].
export const FLAGS = [["log", "reaches a log", "reach a log", "in a log"], ["error", "reaches an error message", "reach an error message", "in an error message"],
  ["public", "crosses a public boundary with no protection stated", "cross a public boundary with no protection stated", "over a public boundary, no protection stated"],
  ["retention", "is kept with no retention rule stated", "are kept with no retention rule stated", "kept, no retention rule stated"]];
const FLAG = Object.fromEntries(FLAGS.map(([k, , , at]) => [k, at]));
// A carried part's kind by its own name, only where the name says it (an older run): never a bare "token" or "id".
const BY_NAME = [["credential", /\b(authori[sz]ation|bearer|api[-_ ]?key|passwords?|passwd|cookies?|session[-_ ]?(id|token|cookie)|(access|refresh|id)[-_ ]?token|credentials?)\b/i],
  ["secret", /\b(secrets?|private[-_ ]?key|signing[-_ ]?key)\b/i], ["personal", /\b(e-?mail|phone number|iban|card number|passport|date of birth)\b/i]];
export const kindByName = (name) => BY_NAME.find(([, re]) => re.test(String(name ?? "")))?.[0] ?? null;

export const NOTE = "As the security run read the code: where each kind of sensitive data starts, the crossings it takes and where it ends. Data the run did not name is not in it.";
export const NOTE_OLD = "Sorted by their names alone, from what this run says goes over each crossing. Where the data ends and how it is protected is not known.";
export const RERUN = "This run is from before the security review named sensitive data: run it again for the ways, where the data ends and how it is protected.";

// data: the run's list ([{id, name, kind, steps: [{node, at, sink, protected, retention}]}]), or not an array for a
// run from before the field; arch: the picture; crossings: views.js crossingsOf's rows (their order is their number).
// → null when there is nothing to show, else {items, total, line, note, old, unclassified, unclassifiedLine, rerun};
//   item: {id, name, kind, byName, path: [card ids], crossed: [crossing keys], way, steps: [{n, text, at, node,
//   cross: its crossing's number or null, crossKey, flags: [key], head, tail}], flags: [{key, text, step}]}.
export function dataflowOf({ data = null, arch = null, crossings = [] } = {}) {
  const rows = crossings ?? [], nodes = arch?.nodes ?? [], edges = arch?.edges ?? [], node = (id) => nodes.find((n) => n.id === id) ?? null;
  const label = (id) => flat(node(id)?.label ?? (arch?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id));
  const outside = (id) => id === "internet" || node(id)?.type === "external";
  const zones = (r) => `${flat(r.from?.name)} → ${flat(r.to?.name)}`;
  if (!Array.isArray(data)) return fromCarries(rows, zones);
  // The crossing a step takes: the row whose line runs from the step before to this card (a way in: from outside).
  const between = (a, b) => (a && b ? rows.findIndex((r) => r.ends?.to === b && (r.ends.from === a || (r.edge !== undefined && edges[r.edge]?.from === a) || (r.kind === "entry" && outside(a)))) : -1);
  const open = (r) => r.kind === "entry" || r.from?.trust === "public" || r.to?.trust === "public";
  const items = data.filter((d) => d && flat(d.name) && Array.isArray(d.steps) && d.steps.some((s) => s?.node)).map((d, i) => {
    const kind = KINDS.includes(d.kind) ? d.kind : "other", list = d.steps.filter((s) => s?.node), flags = [];
    const steps = list.map((s, k) => {
      const prev = k ? list[k - 1].node : null, c = prev !== s.node ? between(prev, s.node) : -1, r = c >= 0 ? rows[c] : null, sink = SINKS.includes(s.sink) ? s.sink : null;
      const prot = flat(s.protected) || null, keep = flat(s.retention) || null;
      const mine = [sink === "log" && !prot && "log", sink === "error" && !prot && "error", r && open(r) && !prot && "public", KEEPS.includes(sink) && !keep && "retention"].filter(Boolean);
      for (const key of mine) flags.push({ key, step: k + 1, text: `${FLAG[key]} (step ${k + 1})` });
      const says = Boolean(r || sink || prot), at = flat(s.at) || null;
      // head, tail: the sentence around its place, for a page that shows the place as a link of its own
      const head = `${sink ? SINK_VERB[sink] : k ? "Passes" : "Starts at"} ${label(s.node)}${r ? `, over crossing ${c + 1} (${zones(r)})` : ""}`;
      const tail = `${says ? ` Protected by: ${prot ?? "not stated"}.` : ""}${KEEPS.includes(sink) ? ` Kept until: ${keep ?? "not stated"}.` : ""}`;
      return { n: k + 1, node: s.node, at, sink, cross: r ? c + 1 : null, crossKey: r?.key ?? null, flags: mine, protected: prot, retention: keep, head, tail, text: `${head}${at ? ` (${at})` : ""}.${tail}` };
    });
    const path = steps.map((s) => s.node).filter((id, k, all) => id !== all[k - 1]);
    return { id: flat(d.id) || `d${i + 1}`, name: flat(d.name), kind, byName: false, path, crossed: [...new Set(steps.map((s) => s.crossKey).filter(Boolean))], steps, flags,
      way: steps.filter((s, k) => !k || s.node !== steps[k - 1].node).map((s) => `${s.cross ? `‖${s.cross} ` : ""}${label(s.node)}`).join(" → ") };
  });
  if (!items.length) return null;
  return { items, total: items.length, line: lineOf(items), note: NOTE, old: false, unclassified: 0, unclassifiedLine: null, rerun: null };
}

// "1 personal field reaches a log, 1 more to check": the worst mark first, in the words of its kind.
function lineOf(items) {
  const noun = (list) => { const kinds = new Set(list.map((x) => x.kind)), [one, many] = KIND_NOUN[kinds.size === 1 ? [...kinds][0] : "other"]; return `${list.length} ${list.length === 1 ? one : many}`; };
  const marked = FLAGS.map(([key, one, many]) => [items.filter((x) => x.flags.some((f) => f.key === key)), one, many]).filter(([list]) => list.length);
  if (!marked.length) return `${plural(items.length, "kind")} of sensitive data, none marked: every log, sink and public crossing on ${items.length === 1 ? "its way" : "their ways"} states its protection`;
  const [list, one, many] = marked[0], rest = new Set(marked.slice(1).flatMap(([l]) => l).filter((x) => !list.includes(x)));
  return `${noun(list)} ${list.length === 1 ? one : many}${rest.size ? `, ${rest.size} more to check` : ""}`;
}

// An older run: the words its checks say go over a crossing. A word that names its kind is an item with the
// crossings that carry it (no marks: the run was not asked how it is protected); the others are only counted.
function fromCarries(rows, zones) {
  const by = new Map(); let unclassified = 0;
  rows.forEach((r, k) => {
    const parts = [].concat(r.carries ?? []).map(flat).filter(Boolean);
    if (parts.some((p) => !kindByName(p))) unclassified++;
    for (const p of parts) { const kind = kindByName(p); if (!kind) continue; const key = p.toLowerCase(); if (!by.has(key)) by.set(key, { name: p, kind, at: [] }); by.get(key).at.push([r, k + 1]); }
  });
  if (!by.size && !unclassified) return null;
  const items = [...by.values()].map((x, i) => ({ id: `n${i + 1}`, name: x.name, kind: x.kind, byName: true, path: [...new Set(x.at.flatMap(([r]) => [r.ends?.from, r.ends?.to]).filter(Boolean))], crossed: x.at.map(([r]) => r.key), flags: [],
    way: x.at.map(([r, n]) => `‖${n} ${zones(r)}`).join(", "),
    steps: x.at.map(([r, n], k) => { const head = `Goes over crossing ${n} (${zones(r)})`, tail = " Its kind is read from its name; this run does not say how it is protected.", at = flat(r.at) || null;
      return { n: k + 1, node: r.ends?.to ?? null, at, sink: null, cross: n, crossKey: r.key, flags: [], protected: null, retention: null, head, tail, text: `${head}${at ? ` (${at})` : ""}.${tail}` }; }) }));
  const unclassifiedLine = unclassified ? `${plural(unclassified, "crossing carries", "crossings carry")} data this run did not classify.` : null;
  return { items, total: items.length, old: true, unclassified, unclassifiedLine, note: NOTE_OLD, rerun: RERUN,
    line: [items.length && `${plural(items.length, "field")} sorted by name`, unclassified && unclassifiedLine.replace(/\.$/, "")].filter(Boolean).join(", ") };
}

// An item's way in one line, for the page and its Markdown: "Way: Client → ‖1 API handler." (‖n: crossing n).
export const wayLine = (x) => `Way: ${x.way}.${x.crossed.length ? "" : " It takes no crossing of the map."}`;

// An item's way as a flowchart for Mermaid: its cards, a line per step (a crossing says its number), and a card of
// its own for where it ends outside the cards (a log, an error message, a third party, a response).
export function dataflowPic(item, label = (id) => id) {
  const nodes = [], edges = [], put = (id, text) => { if (!nodes.some((n) => n.id === id)) nodes.push({ id, label: text }); return id; };
  const OUT = { log: "log", error: "error message", third_party: "third party", response: "response" };
  let prev = null;
  for (const s of item.steps) {
    if (!s.node) continue;
    const id = put(s.node, label(s.node));
    if (prev && prev !== id) edges.push({ from: prev, to: id, label: s.cross ? `crossing ${s.cross}` : "", crosses: Boolean(s.cross) });
    if (OUT[s.sink]) edges.push({ from: id, to: put(`\0${s.sink}:${id}`, OUT[s.sink]), label: s.flags.length ? "to check" : "" });
    prev = id;
  }
  return { nodes, edges };
}

// The section of Copy as Markdown: per kind of data its way, its steps as a numbered list, what is marked, and the
// way as a flowchart. flow: markdown.js mermaidFlow; label: a card's name. [] without a model.
export function dataflowMd(m, flow, label = (id) => id) {
  if (!m) return [];
  return [`## Where sensitive data goes (${m.total})`, "", `${m.line[0].toUpperCase()}${m.line.slice(1)}.`, "", m.note, "", ...(m.rerun ? [m.rerun, ""] : []),
    ...m.items.flatMap((x) => { const pic = dataflowPic(x, label);
      return [`### ${x.name} (${x.kind}${x.byName ? ", by its name" : ""})`, "", wayLine(x), "", ...x.steps.map((s) => `${s.n}. ${s.text}`), "",
        ...(x.flags.length ? [`To check: ${x.flags.map((f) => f.text).join("; ")}.`, ""] : []), ...(pic.edges.length ? [...flow(pic), ""] : [])]; })];
}
