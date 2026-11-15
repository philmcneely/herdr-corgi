// The Resilience page's picture "Timing": do the timeouts, retries and pauses of the layers fit together, or does an
// outer timeout run out while something inside still retries? Per call of the run (resilience.deps) a small group of
// bars over seconds: the limit it runs inside as a frame (the call's timeout, a function's timeout, a queue message's
// visibility), under it what runs inside (the attempts with the pauses between them, a batch's worst run). Where the
// sum passes the frame, the place is marked. Pure: the run's data → rows in seconds (timelineOf) → px (timelineLayout)
// → Markdown (timelineMd). stack.js timelineView draws it.
//
// Nothing is guessed: a length the run does not state in seconds (an attempt's own timeout, a pause named only in
// words) has no length here (s: null, drawn as a dashed open bar), and a sum with such a part is "at least".

const sec = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const pos = (x) => (sec(x) > 0 ? x : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// "7 s", "0.25 s", "15 min", "4 days": seconds as the page says them.
export const fmtS = (s) => (s < 120 ? `${+s.toFixed(s < 10 ? 2 : s < 100 ? 1 : 0)} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
// The first file:line a text names ("Lambda Globals.Timeout (template.yaml:8)", "library/mailer.py:14-20").
const placeOf = (...texts) => { for (const x of texts) { const m = /[\w./-]+\.\w+:\d+/.exec(String(x ?? "")); if (m) return m[0]; } return null; };

const RANK = { over: 0, open: 1, tight: 2, fits: 3 };
const worst = (vs) => vs.filter(Boolean).sort((a, b) => RANK[a.kind] - RANK[b.kind])[0] ?? null;

// A run against the limit it runs inside. min: the seconds that are stated; unknown: what is not ("3 attempts").
function verdictOf(min, unknown, limit) {
  if (!limit) return { kind: "open", text: "? no timeout stated" };
  if (min > limit.s) return { kind: "over", text: `✗ ${unknown ? "at least " : ""}${fmtS(min - limit.s)} over the ${limit.what}` };
  if (unknown) return { kind: "open", text: min > 0 ? `? ${min < limit.s ? fmtS(limit.s - min) : "no time"} left for ${unknown} of unstated length` : "? not stated in seconds" };
  return { kind: "fits", text: `✓ fits the ${limit.what}` };
}

// The path that shows a call's timing on the page: the one whose budget is this call's, else one that takes the call,
// a request's path for a call in a request, a retry's or timeout's otherwise.
function pathOf(d, paths, over) {
  const on = (p) => (d.edge ? [...(p.via ?? []), ...(p.steps ?? [])].includes(d.edge) : (p.steps ?? []).includes(d.at));
  const kinds = d.request_path ? ["request"] : ["timeout", "retry"];
  // several paths can run through one batch over its timeout: the one that names it, else a retry's or timeout's
  const mine = over ? paths.filter((p) => p.budget?.over_s > 0 && p.budget.at === d.at) : [];
  return (mine.find((p) => (p.failing ?? []).includes("over_timeout")) || mine.find((p) => kinds.includes(p.kind)) || mine[0] || paths.find((p) => on(p) && kinds.includes(p.kind)) || paths.find(on) || null)?.id ?? null;
}

// One call as a group of rows, or null when the run gives it no number to draw.
function groupOf(d, k, name, edges, paths) {
  const e = edges[Number(/^e(\d+)$/.exec(d.edge ?? "")?.[1] ?? -1)], t = d.trigger ?? null, r = d.retry ?? null;
  const fn = pos(t?.fn_timeout_s), own = pos(d.timeout?.s), src = flat(d.timeout?.source);
  const limit = fn ? { what: "function timeout", s: fn } : own ? { what: "timeout", s: own } : null;
  const rows = [], n = Number.isInteger(r?.attempts) ? r.attempts : 0, each = pos(r?.attempt_s), stated = Array.isArray(r?.backoff_s);
  const limitRow = (what, s, at, tip) => ({ kind: "limit", label: what, s, at, tip, min: s ?? 0, cells: { timeout: s === null ? "not stated" : fmtS(s) }, verdict: null });
  if (n > 1 || (n === 1 && each)) {
    const segs = []; let at = 0;
    const add = (kind, s) => { segs.push({ kind, from: at, to: at + (s ?? 0), open: s === null }); at += s ?? 0; };
    for (let i = 0; i < n; i++) {
      add("attempt", each);
      // a pause after the last attempt only when the run states one (the mailer sleeps after its last try too)
      if (i < n - 1 || (stated && r.backoff_s.length >= n)) add("pause", stated ? sec(r.backoff_s[i]) : null);
    }
    const ua = segs.filter((s) => s.kind === "attempt" && s.open).length, up = segs.filter((s) => s.kind === "pause" && s.open).length, pauses = segs.filter((s) => s.kind === "pause");
    const unknown = [ua && plural(ua, "attempt"), up && plural(up, "pause")].filter(Boolean).join(" and "), words = flat(r.backoff);
    rows.push({ kind: "run", label: !r.layer || r.layer === "none" ? "retry" : /retr|redeliver/i.test(r.layer) ? flat(r.layer) : `${flat(r.layer)} retry`, segs, min: at, unknown, unstated: up > 0 && !stated, at: placeOf(r.at) ?? d.at ?? null, tip: [words && `Backoff in the run's words: ${words}`, r.on && `on ${flat(r.on)}`].filter(Boolean).join("\n"),
      cells: { attempts: `${plural(n, "attempt")}${each ? ` of up to ${fmtS(each)}` : ""}`,
        backoff: !pauses.length ? "" : !up ? `pauses of ${listOf(pauses.map((s) => fmtS(s.to - s.from)))}` : words && words !== "none" ? `pauses in the run's words: ${words}` : "pauses not stated",
        sum: !unknown ? fmtS(at) : at > 0 ? `at least ${fmtS(at)}` : "not stated" },
      verdict: verdictOf(at, unknown, limit) });
  }
  if (pos(t?.batch) && pos(t?.worst_record_s)) {
    const total = t.batch * t.worst_record_s;
    rows.push({ kind: "run", label: "worst batch", segs: [{ kind: "work", from: 0, to: total, open: false }], min: total, unknown: "", at: d.at ?? null, tip: "The batch size times the longest one record can take.",
      cells: { sum: `${plural(t.batch, "record")} × ${fmtS(t.worst_record_s)} = ${fmtS(total)}` }, verdict: verdictOf(total, "", limit) });
  }
  if (!rows.length && !(fn && pos(t?.visibility_s))) return null;
  const frames = [limitRow(limit?.what ?? "timeout", limit?.s ?? null, placeOf(src) ?? d.at ?? null, src)];
  if (pos(t?.visibility_s)) {
    // A queue hides a message for its visibility time; the function has to be done by then, and the rule for a
    // function on a queue is six times its timeout (the run's budget rule), said as a rule, not as a failure.
    const vis = t.visibility_s, v = !fn ? null : fn > vis ? { kind: "over", text: `✗ ${fmtS(fn - vis)} shorter than the function timeout` }
      : vis < 6 * fn ? { kind: "tight", text: `! under 6 × the function timeout (${fmtS(6 * fn)})` } : { kind: "fits", text: "✓ at least 6 × the function timeout" };
    frames.push({ ...limitRow("message visibility", vis, placeOf(r?.at) ?? d.at ?? null, "After this time the queue shows the message again and delivers it once more."), verdict: v });
  }
  const all = [...frames, ...rows];
  if (!all.some((x) => x.min > 0)) return null;
  const verdict = worst(all.map((x) => x.verdict));
  return { key: d.edge ?? d.at ?? `d${k}`, title: e ? `${name(e.from)} → ${name(e.to)}` : d.node ? name(d.node) : d.at || "a call", entry: flat(d.entry) || null, at: d.at || null,
    limit, rows: all, verdict, path: pathOf(d, paths, verdict?.kind === "over") };
}

// The run's calls as groups of rows in seconds, the ones over their limit first; at most `max` rows are drawn, the
// calls left out are counted (more). → {groups, more, moreLine, total, line, note, rerun}; null when no call has a number.
// res: the page's block (pr.js withResilience) or the raw one; arch: the map, for the calls' names.
export function timelineOf(res, arch = null, max = 12) {
  const nodes = arch?.nodes ?? [], name = (id) => nodes.find((x) => x.id === id)?.label ?? id, deps = res?.deps ?? [];
  const all = deps.map((d, k) => groupOf(d, k, name, arch?.edges ?? [], res?.paths ?? [])).filter(Boolean)
    .sort((a, b) => (RANK[a.verdict?.kind] ?? 9) - (RANK[b.verdict?.kind] ?? 9));
  if (!all.length) return null;
  const groups = []; let rows = 0;
  for (const g of all) { if (groups.length && rows + g.rows.length > max) break; groups.push(g); rows += g.rows.length; }
  const by = (k) => all.filter((g) => g.verdict?.kind === k).length;
  const parts = [[by("over"), "over"], [by("open"), "not stated"], [by("tight"), "tight"], [by("fits"), "fits"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
  const unstated = all.flatMap((g) => g.rows).filter((x) => x.unstated).length;
  const more = all.length - groups.length;
  return { groups, more, moreLine: more ? `${plural(more, "more call")} with a timeout or a retry ${more === 1 ? "is" : "are"} not shown.` : null, total: all.length, line: `${plural(all.length, "call")}: ${listOf(parts)}`,
    note: "From the timeouts, retries and pauses this run read in the code; nothing was measured. A dashed bar is a length the code does not state.",
    // A run from before the pauses came in seconds (retry.backoff_s): its retries stay open, and a new run states them.
    rerun: unstated > 0 && !deps.some((d) => Array.isArray(d.retry?.backoff_s) || pos(d.retry?.attempt_s))
      ? `${plural(unstated, "retry", "retries")} of this run ${unstated === 1 ? "names its" : "name their"} pauses only in words, so ${unstated === 1 ? "its" : "their"} bars stay open. A new run states them in seconds.` : null };
}

// A step for about five ticks on an axis of `max` seconds.
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
const stepOf = (max) => STEPS.find((s) => max / s <= 6) ?? Math.ceil(max / 5 / 86400) * 86400;

// The groups with px: per group its scale (max_s, ticks), per row its bars {x, w, kind: limit|attempt|pause|work,
// open, cut}, the part over the limit (over {x, w}) and the limit's line (limitX). One scale for all groups when
// their longest bars are within a factor of four of each other, else each group its own (own: true), which the page
// says. Inside a group a bar far longer than its limit (more than eight times) is cut at the edge (cut), with its
// length as text beside it. An open bar has no length in seconds: OPEN px, or 40 % of the track when its whole row is open.
export const TL = { W: 400, OPEN: 9 };
export function timelineLayout(model, W = TL.W) {
  if (!model) return null;
  const reach = model.groups.map((g) => {
    const ends = g.rows.map((r) => r.min).filter((s) => s > 0), limits = g.rows.filter((r) => r.kind === "limit" && r.s > 0).map((r) => r.s);
    return Math.min(Math.max(...ends), limits.length ? 8 * Math.min(...limits) : Infinity);
  });
  const own = Math.max(...reach) / Math.min(...reach) > 4;
  const groups = model.groups.map((g, k) => {
    const max_s = (own ? reach[k] : Math.max(...reach)) * 1.1, px = (s) => Math.round((Math.min(s, max_s) / max_s) * W), step = stepOf(max_s);
    const ticks = Array.from({ length: Math.floor(max_s / step) + 1 }, (_x, i) => ({ s: i * step, x: px(i * step), label: i ? fmtS(i * step) : "0" }));
    const limitX = g.limit ? px(g.limit.s) : null;
    const rows = g.rows.map((r) => {
      if (r.kind === "limit") return { ...r, bars: [r.s === null ? { x: 0, w: W, kind: "limit", open: true } : { x: 0, w: Math.max(2, px(r.s)), kind: "limit", open: false, cut: r.s > max_s }] };
      const bars = r.min === 0 ? [{ x: 0, w: Math.round(W * 0.4), kind: "attempt", open: true }]
        : r.segs.filter((s) => s.open || s.to > s.from).map((s) => (s.open ? { x: px(s.from), w: TL.OPEN, kind: s.kind, open: true } : { x: px(s.from), w: Math.max(2, px(s.to) - px(s.from)), kind: s.kind, open: false }));
      const over = g.limit && r.min > g.limit.s ? { x: limitX, w: Math.max(4, px(r.min) - limitX) } : null;
      return { ...r, bars, over, cut: r.min > max_s };
    });
    return { ...g, max_s, ticks, limitX, rows };
  });
  return { ...model, groups, own, W };
}

// "## Timing (n)" for Copy as Markdown: the note, a table (layer, timeout, attempts, backoff, sum, verdict) with a row
// for every run and every limit that is judged, and a Mermaid gantt of the stated seconds when it can carry them
// (whole seconds, no bar a hundred times another: a gantt has one axis); else the table alone. [] without a model.
const cell = (s) => flat(s).replace(/\|/g, "\\|");
const task = (s) => flat(s).replace(/[:;#,]/g, " ").replace(/\s+/g, " ").trim();
export function timelineMd(model, num = () => 0) {
  if (!model) return [];
  const rows = model.groups.flatMap((g) => g.rows.filter((r) => r.kind === "run" || r.verdict).map((r) => [`${g.title}${g.entry ? `, from ${g.entry}` : ""}: ${r.label}`,
    r.kind === "limit" ? r.cells.timeout : g.limit ? `${fmtS(g.limit.s)} (${g.limit.what})` : "not stated", r.cells.attempts ?? "", r.cells.backoff ?? "", r.cells.sum ?? "",
    `${r.verdict?.text ?? ""}${r.verdict && r.verdict.kind !== "fits" && g.path && num(g.path) ? `, path ${num(g.path)}` : ""}`]));
  const head = ["Layer", "Timeout", "Attempts", "Backoff", "Sum", "Verdict"];
  const known = model.groups.flatMap((g) => g.rows.flatMap((r) => (r.kind === "limit" ? (r.s ? [r.s] : []) : r.segs.filter((s) => !s.open && s.to > s.from).flatMap((s) => [s.to - s.from, s.to]))));
  const gantt = known.length > 1 && known.every(Number.isInteger) && Math.max(...known) <= 100 * Math.min(...known);
  return [`## Timing (${model.total})`, "", `${model.line}.`, "", model.note, "",
    `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`), "",
    ...(gantt ? ["```mermaid", "gantt", "  title Timing in seconds", "  dateFormat X", "  axisFormat %s",
      ...model.groups.flatMap((g) => [`  section ${task(g.title)}`, ...g.rows.flatMap((r) => (r.kind === "limit" ? (r.s ? [`  ${task(r.label)} ${fmtS(r.s)} :done, 0, ${r.s}`] : [])
        : r.segs.map((s, i) => ({ ...s, n: r.segs.slice(0, i + 1).filter((x) => x.kind === s.kind).length })).filter((s) => !s.open && s.to > s.from).map((s) => `  ${task(s.kind === "work" ? r.label : `${r.label} ${s.kind} ${s.n}`)} (${fmtS(s.to - s.from)}) :${g.limit && s.to > g.limit.s ? "crit, " : ""}${s.from}, ${s.to}`)))]), "```", ""] : []),
    ...(model.moreLine ? [model.moreLine, ""] : []),
    ...(model.rerun ? [model.rerun, ""] : [])];
}
