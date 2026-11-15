// Run: node perf_bench.mjs [--big] [--top]  (what each page and state costs to draw: time, elements built, builder
// calls, list rows, and how often the mod's own functions run in a frame that changes nothing. Counted in Node with
// the render stand-ins; Herdr's script engine is far slower than Node, so compare counts and ratios, not ms.)
// Also the harness of test_perf.mjs. Nothing here is loaded by the mod.
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { S, cx as base } from "./render_stub.mjs";

// Every top-level function of the mod's modules counts its calls and time while P.on (a source rewrite at load, so
// the mod's code carries no counters).
const P = (globalThis.__perf = { on: false, stat: new Map(), stack: [] });
globalThis.__prof = (name, fn, self, args) => {
  if (!P.on) return fn.apply(self, args);
  let s = P.stat.get(name);
  if (!s) P.stat.set(name, (s = { n: 0, incl: 0, self: 0 }));
  s.n++; const t0 = performance.now(); P.stack.push(0);
  try { return fn.apply(self, args); } finally {
    const dt = performance.now() - t0, child = P.stack.pop();
    s.incl += dt; s.self += dt - child;
    if (P.stack.length) P.stack[P.stack.length - 1] += dt;
  }
};
const HERE = new URL(".", import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (!url.startsWith(HERE) || !url.endsWith(".js")) return r;
    const file = url.slice(HERE.length, -3);
    return { ...r, source: String(r.source).replace(/^(export )?function (\w+)\(/gm, (_m, ex, n) => `${ex ?? ""}function ${n}(...__a) { return globalThis.__prof("${file}.${n}", ${n}__impl, this, __a); }\nfunction ${n}__impl(`) };
  },
});

const FIXTURES = new URL("../../demo/fixtures/review/", import.meta.url);
export const hasFixtures = existsSync(FIXTURES);
export const fx = (name) => readFileSync(new URL(name, FIXTURES), "utf8");

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, hash, reviewRequest } = await import("./pr.js");
const { foldOnOpen } = await import("./views.js");
const { bigReview } = await import("./perf_fixture.mjs");
// The view's own methods count too.
for (const k of Object.getOwnPropertyNames(PrReview.prototype)) {
  const d = Object.getOwnPropertyDescriptor(PrReview.prototype, k);
  if (k === "constructor" || typeof d.value !== "function") continue;
  const fn = d.value;
  PrReview.prototype[k] = function (...a) { return globalThis.__prof(`view.${k}`, fn, this, a); };
}

// What a frame asked of Herdr besides drawing: redraws, timers, shared-state writes, commands run, files read.
export const N = { notify: 0, after: 0, every: 0, spawn: 0, exec: 0, read: 0, shared: 0 };
const late = [];
// timers: what was left for after the frame (cx.timer.after), run by later().
const timers = [];
export const cx = { ...base, notify() { N.notify++; }, timer: { after(_ms, f) { N.after++; timers.push(f); }, every() { N.every++; } },
  spawn(fn) { N.spawn++; void Promise.resolve().then(() => fn(cx)).catch((e) => { if (e?.message !== "stub") late.push(e?.stack ?? String(e)); }); } };
export const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const set0 = S.store.set.bind(S.store);
S.store.set = (k, v) => { N.shared++; return set0(k, v); };

export const PR2 = () => ({ diff: fx("pr2.diff"), analysis: fx("analysis-s.json"), findings: fx("findings-s.json") });
export const BIG = (o) => bigReview(PR2(), o);

// A review opened the way test_smoke.mjs opens one.
export async function openReview({ diff, analysis, findings }) {
  const url = "https://github.com/saefty/corgi-demo/pull/2", target = { url, repo: "saefty/corgi-demo", number: 2, title: "feat(events): loan events", base: "main" };
  S.store.clear(); S.files.clear(); S.props = null; S.spaces = null;
  S.store.set("review.target", target);
  S.files.set(`/h/pr-data/findings/${hash(url)}.json`, findings);
  const v = new PrReview(); v.init({}, cx);
  v.prSel = target; v.patch = splitPatch(diff);
  await v.applyResume(cx);
  v.hunks = hunksOf(v.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  v.byId = new Map(v.hunks.map((h) => [h.id, h])); v.fileHunks = new Map();
  for (const h of v.hunks) v.fileHunks.set(h.path, [...(v.fileHunks.get(h.path) ?? []), h]);
  v.collapsed = new Set(foldOnOpen(v.patch));
  v.ctx = JSON.parse(fx("ctx.json")); v.head = v.ctx?.head ?? null;
  await v.loadFindings(cx);
  // The analysis where loadAi reads it: the first frame asks for the model's cached one.
  S.files.set(reviewRequest({ url, pr: url, worktree: null, files: v.patch, hunks: v.hunks, model: v.aiModel ?? "sonnet", context: v.ctxReq(), dir: "/h/pr-data/cache" }).latest, analysis);
  v.loadAi(cx, "cache"); await settle();
  if (!v.ai) throw new Error("the analysis was not read");
  v.securityNow(cx); v.publish();
  v.winW = 1600; v.listH = 900; // a window, so widths and heights are the real ones
  await settle();
  return v;
}

// The PR panel beside the chat (main.js without a part) on a list of PRs, then with one chosen and its diff.
export async function openPanel({ diff }, prsN = 40) {
  S.store.clear(); S.files.clear(); S.props = {};
  const now = Date.now(), iso = (d) => new Date(now - d * 86400000).toISOString();
  const prs = Array.from({ length: prsN }, (_x, k) => ({ url: `https://github.com/saefty/corgi-demo/pull/${k + 2}`, repo: k % 4 ? "saefty/corgi-demo" : "o/else", number: k + 2, title: `PR ${k + 2}: a change`, state: k % 5 === 4 ? "merged" : "open",
    updatedAt: iso(k % 9), at: iso(k % 9), session: "s1234567", sessionTitle: "a session", head: `feat/x${k}`, headSha: "abc", base: "main" }));
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs }));
  S.spaces = [{ id: "sA", active: true, folder: "/h/a" }];
  S.exec = async (cmd, args) => { N.exec++; return cmd === "gh" && args[1] === "diff" ? { code: 0, stdout: diff, stderr: "" } : { code: 1, stdout: "", stderr: "stub" }; };
  const v = new PrReview(); v.init({}, cx); await settle();
  v.setupFirst = false; // not the first-run Setup page (nothing is installed in the stand-ins): it would cover the list and the diff
  v.spaceSlug = { root: "/h/a", slug: "saefty/corgi-demo" };
  return { v, prs };
}

// One frame: the view, then the rows a window shows of every virtual list (the first `rows` of each; lists inside
// rows join the queue). Returns what it built.
export function frame(v, rows = 60) {
  S.errs.length = 0; S.lists.length = 0; S.clicks.clear();
  const n0 = { ...S.n }, t0 = performance.now();
  v.render(cx);
  const items = S.lists.reduce((x, l) => x + l.n, 0);
  for (let k = 0; k < S.lists.length && k < 50; k++) S.lists[k].render({ start: 0, end: Math.min(S.lists[k].n, rows) }, cx);
  if (S.errs.length) throw new Error(S.errs.join("\n"));
  return { ms: performance.now() - t0, el: S.n.el - n0.el, call: S.n.call - n0.call, items };
}
// What the frames left for after them, run now: a slice of a map's layout (stack.js layoutPump), the syntax colours, a focus.
export function later() { for (const f of timers.splice(0)) f(cx); }
// Frames until none leaves anything for later: the state as it stands once the window is quiet.
export function settled(v) { for (let k = 0; k < 8; k++) { frame(v); if (!timers.length) return; later(); } timers.length = 0; }
// The same with the tasks the timers start (a map's layout search runs in slices of a task): until nothing is left.
export async function quiet(v, ms = 60000) {
  for (const t0 = performance.now(); ;) {
    frame(v); await settle();
    if (!timers.length) return;
    later(); await settle();
    if (performance.now() - t0 > ms) throw new Error("the view did not come to rest");
  }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// A state measured: the first frame (cold), then `k` more that change nothing (warm: the median, and the functions
// that ran in one of them). calls: name -> times run in one warm frame.
export async function measure(v, k = 7) {
  for (const key of Object.keys(N)) N[key] = 0;
  timers.length = 0;
  const cold = frame(v), n1 = { ...N };
  await quiet(v); // what the first frame left for later is done, the caches are filled
  for (const key of Object.keys(N)) N[key] = 0;
  P.stat.clear(); P.on = true; const one = frame(v); P.on = false;
  const stat = new Map([...P.stat].map(([name, s]) => [name, { ...s }])), asked = { ...N };
  const warm = Array.from({ length: k }, () => frame(v).ms);
  return { cold, coldAsked: n1, warm: { ...one, ms: median(warm) }, asked, stat, calls: (name) => stat.get(name)?.n ?? 0 };
}

// How often the mod's functions ran while f did: name ("pr.mergeFindings", "view.rowsFor") -> times.
export function counted(f) {
  P.stat.clear(); P.on = true;
  try { f(); } finally { P.on = false; }
  const stat = new Map([...P.stat].map(([name, s]) => [name, s.n]));
  return (name) => stat.get(name) ?? 0;
}

// The states of a review, by name: each puts the view there.
export const STATES = {
  "Files (as opened)": (v) => v.command("files", cx),
  "Files (all open)": (v) => { v.command("files", cx); v.collapsed = new Set(); },
  "Findings": (v) => { v.command("findings", cx); v.ffocus = null; },
  "Findings, one open": (v) => { v.command("findings", cx); v.command(`finding:${v.findings()[0].id}`, cx); },
  "Comments": (v) => v.command("comments", cx),
  "Walkthrough, a layer": (v) => { v.command("steps", cx); v.page = null; v.command("step:0", cx); },
  "Overview": (v) => { v.command("steps", cx); v.command("page:overview", cx); },
  "Architecture": (v) => { v.command("steps", cx); v.command("page:arch", cx); v.command("card:", cx); },
  "Architecture, a card": (v) => { v.command("steps", cx); v.command("page:arch", cx); v.command(`card:${v.ai.arch.nodes[1].id}`, cx); },
  "Security": (v) => { v.command("steps", cx); v.command("page:blast", cx); },
  "Resilience": (v) => { v.command("steps", cx); v.command("page:res", cx); },
  "Markdown preview": (v) => { v.command("steps", cx); v.command("page:overview", cx); v.command("copy-md", cx); },
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (!hasFixtures) { console.error("perf_bench: needs demo/fixtures/review of the repository"); process.exit(1); }
  const top = process.argv.includes("--top"), sets = [["PR #2", PR2()], ...(process.argv.includes("--big") ? [["big", BIG()]] : [])];
  const f1 = (x) => x.toFixed(1).padStart(7), i = (x, w = 7) => String(x).padStart(w);
  for (const [name, data] of sets) {
    const t0 = performance.now(), v = await openReview(data);
    console.log(`\n## ${name}: ${v.patch.length} files, ${v.hunks.reduce((n, h) => n + h.rows.length, 0)} diff rows, ${v.findings().length} findings, ${v.ai.arch.nodes.length} cards (opened in ${(performance.now() - t0).toFixed(0)} ms)`);
    console.log(`${"state".padEnd(24)} ${"cold ms".padStart(7)} ${"warm ms".padStart(7)} ${"elem".padStart(7)} ${"calls".padStart(7)} ${"items".padStart(7)}  per warm frame: layout / functions run / notify, timers, shared writes`);
    for (const [state, go] of Object.entries(STATES)) {
      go(v); await settle();
      const m = await measure(v), fns = [...m.stat.values()].reduce((n, s) => n + s.n, 0);
      console.log(`${state.padEnd(24)} ${f1(m.cold.ms)} ${f1(m.warm.ms)} ${i(m.warm.el)} ${i(m.warm.call)} ${i(m.warm.items)}  ${m.calls("arch.archLayout")} / ${fns} / ${m.asked.notify}, ${m.asked.after}, ${m.asked.shared}`);
      if (top) for (const [fn, s] of [...m.stat].sort((a, b) => b[1].self - a[1].self).slice(0, 8)) console.log(`    ${fn.padEnd(34)} ${i(s.n, 6)}× self ${f1(s.self)} ms  incl ${f1(s.incl)} ms`);
      if (v.mdPrev) v.command("md-close", cx);
    }
    // The panel beside the chat.
    const { v: p, prs } = await openPanel(data);
    const rows = [];
    p.picking = true; rows.push(["Panel, the list", await measure(p)]);
    p.memo.clear(); p.context = null; N.exec = 0; p.choose(prs[0], cx); await settle(); const execs = N.exec;
    rows.push(["Panel, a PR chosen", await measure(p)]);
    if (p.files[1]) { p.pick(p.files[Math.min(12, p.files.length - 1)].path, cx); await settle(); rows.push(["Panel, another file", await measure(p)]); }
    for (const [state, m] of rows) {
      console.log(`${state.padEnd(24)} ${f1(m.cold.ms)} ${f1(m.warm.ms)} ${i(m.warm.el)} ${i(m.warm.call)} ${i(m.warm.items)}  ${m.calls("arch.archLayout")} / ${[...m.stat.values()].reduce((n, s) => n + s.n, 0)} / ${m.asked.notify}, ${m.asked.after}, ${m.asked.shared}`);
      if (top) for (const [fn, s] of [...m.stat].sort((a, b) => b[1].self - a[1].self).slice(0, 8)) console.log(`    ${fn.padEnd(34)} ${i(s.n, 6)}× self ${f1(s.self)} ms  incl ${f1(s.incl)} ms`);
    }
    console.log(`(choosing a PR in the panel ran ${execs} commands)`);
    S.exec = null;
  }
  await settle();
  if (late.length) { console.error(late.join("\n")); process.exit(1); }
}
