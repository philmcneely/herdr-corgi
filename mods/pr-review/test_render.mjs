// Run: node test_render.mjs  (the review view rendered against stand-ins for gpui-kit, gpui-base and herdr: the first
// render, the Files list's layout and scrolling (autoFold), 0 / 3 / 310 files, the Architecture page with the Ask drawer
// open, folded and squeezing, a layer's findings and the Findings tab. An exception, a null or non-finite number given to an element, a bad virtual-list size
// or key fails it; a ReferenceError here once showed in Herdr as "This view could not be re-rendered — Null".)
import assert from "node:assert/strict";
import { S, cx, ok } from "./render_stub.mjs";

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, stepKey } = await import("./pr.js");
const { foldOnOpen } = await import("./views.js");
const { renderMini } = await import("./review.js");

function review(files) {
  const target = { url: "https://github.com/o/r/pull/1", repo: "o/r", number: 1, title: "t" };
  S.store.set("review.target", target);
  const v = new PrReview(); v.init({}, cx);
  let text = "";
  for (let i = 0; i < files; i++) {
    const n = 5 + ((i * 37) % 120);
    text += `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,${n} +1,${n} @@\n${"+x\n".repeat(n)}`;
  }
  v.prSel = target; v.patch = files ? splitPatch(text) : [];
  v.hunks = hunksOf(v.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  v.byId = new Map(v.hunks.map((h) => [h.id, h])); v.fileHunks = new Map();
  for (const h of v.hunks) v.fileHunks.set(h.path, [...(v.fileHunks.get(h.path) ?? []), h]);
  v.collapsed = new Set(foldOnOpen(v.patch));
  return v;
}
const files = () => S.lists.find((l) => l.id === "rv-list-files");
const layout = (at) => { const l = files(); if (l) { const s = Math.floor(l.n * at); l.render({ start: s, end: Math.min(l.n, s + 40) }, cx); } };

for (const n of [0, 3, 310]) {
  const v = review(n);
  v.tab = "files"; v.page = null;
  ok(`${n} files: first render`, () => v.render(cx));
  ok(`${n} files: wheel before any layout`, () => v.autoFold(cx));
  for (const at of [0, 0.3, 0.95, 0.5, 0.05]) ok(`${n} files: scroll to ${at}`, () => { v.render(cx); layout(at); v.autoFold(cx); v.render(cx); layout(at); });
  ok(`${n} files: a range from a longer list`, () => { v.vis = { start: 99999, end: 100040 }; v.autoFold(cx); v.render(cx); });
  if (n === 310) assert.ok(v.overBudget.size > 0 && files().n < 10000, "a big PR folds some files and stays under the list's limit");
  v.ai = { cut: [], exact: true, visuals: [], asks: [], model: "sonnet", title: "t", summary: "s", steps: [{ title: "a", why: "w", hunks: [], questions: [], risk: "low" }],
    arch: { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "x" }] } };
  v.tab = "steps"; v.page = "arch";
  for (const [drawer, winW] of [[null, 900], ["open", 900], ["open", 1900], ["collapsed", 900]]) {
    v.deep.drawer[v.deepKey()] = drawer; v.winW = winW;
    ok(`${n} files: Architecture page, drawer ${drawer} at ${winW} px`, () => v.render(cx));
  }
  // A clicked card with its layer opened: the layer's explanation, questions and picture in the card.
  v.ai.arch.nodes[0].at = "src/a.ts:3";
  const lf = { id: "a1", reviewer: "analysis", step: "k", file: "src/f0.ts", line: 2, end: 2, severity: "high", category: "scope", title: "Unrelated", detail: "d", suggestion: "s" };
  v.ai = { ...v.ai, steps: [...v.ai.steps, { title: "b", why: "w", text: "x", hunks: [], questions: ["q?"], risk: "high", evidence: ["src/a.ts:1"], findings: [lf], // a new analysis, as the view gets one
    visuals: [{ kind: "flow", title: "f", nodes: [{ id: "n1", label: "N1", at: "src/a.ts:3" }, { id: "n2", label: "N2" }], edges: [{ from: "n1", to: "n2", label: "y" }] }] }] };
  v.archFocus = "a"; v.cardLayersOpen = null; // the first (riskiest) layer starts open
  ok(`${n} files: Architecture page, a card with its layer analysis open below the details`, () => v.render(cx));
  assert.deepEqual(v.cardLayers.list, [v.ai.steps[1]]);
  v.cardLayersOpen = new Map([[`a|${stepKey(v.ai.steps[1])}`, false]]);
  ok(`${n} files: Architecture page, the layer closed (its highlight still shows)`, () => v.render(cx));
  v.archFocus = null; v.page = null; v.cur = 1;
  ok(`${n} files: the same layer open in the Layers view`, () => v.render(cx));
  // Its picture is a row of the diff list, right after the layer's head; a question names the file the analysis gives.
  assert.deepEqual(v.items.slice(v.at.s1, v.at.s1 + 2).map((it) => it.t), ["step", "vis"], "a layer's picture sits over its code");
  // A state diagram over the code: open with its transitions as rows while a finding sits at one, folded otherwise.
  const sm = { kind: "state_machine", title: "Loan", nodes: [{ id: "s1", label: "S1", evidence: "src/a.ts:1" }, { id: "s2", label: "S2" }], transitions: [{ from: "s1", to: "s2", event: "go", evidence: "src/f0.ts:2" }, { from: "s2", to: "s1", event: "back" }] };
  v.ai.steps[1].visuals = [sm];
  const steps = () => S.lists.find((l) => l.id === "rv-list-steps"), rows = () => { const l = steps(); if (l) l.render({ start: 0, end: l.n }, cx); };
  ok(`${n} files: a state diagram with a finding at a transition`, () => { v.render(cx); rows(); });
  assert.deepEqual(v.items.slice(v.at.s1 + 1, v.at.s1 + 4).map((it) => it.t), ["vis", "vtr", "vtr"]);
  v.toggleVis("vis|1|0");
  ok(`${n} files: the state diagram folded`, () => { v.render(cx); rows(); });
  assert.deepEqual(v.items.slice(v.at.s1 + 1, v.at.s1 + 2).map((it) => it.t), ["visfold"]);
  v.ai.steps[1].visuals = [{ kind: "flow", title: "f", nodes: [{ id: "n1", label: "N1", at: "src/a.ts:3" }, { id: "n2", label: "N2" }], edges: [{ from: "n1", to: "n2", label: "y" }] }];
  assert.deepEqual([v.asked({ questionFiles: ["src/a.ts", ""] }, "q?", 0), v.asked({ questionFiles: ["src/a.ts", ""] }, "q?", 1), v.asked({}, "q?", 0)], ["a.ts — q?", "q?", "q?"]);
  // Its analysis finding: in the layer above, and in the Findings tab (read live from the analysis, linked to its layer).
  assert.deepEqual(v.findings().map((f) => f.id), ["a1"]); assert.equal(v.layerOf(v.findings()[0]), 1);
  v.tab = "findings";
  ok(`${n} files: the Findings tab with an analysis finding`, () => v.render(cx));
  if (n === 3) {
    // One finding per defect: the security reviewer's finding and an AI suggestion on its line with the same claim merge into it,
    // a suggestion alone on its line stays a note. Sent to Fix with a "fixed" report it is still unresolved: counted,
    // a blocker, a card in the diff; the layer lists it although the reviewer, not the analysis, leads it.
    v.find = { ...v.find, list: [{ id: "s1", reviewer: "security", file: "src/f0.ts", line: 2, end: 2, severity: "high", title: "Unrelated change", detail: "d", suggestion: "" }],
      status: { a1: { s: "progress", fixHead: "h0", at: "2024-01-01" } }, reports: { a1: { id: "a1", status: "fixed", commit: "22e31c88f2", note: "done" } } };
    const sug = (line, severity, reason) => ({ key: `src/f0.ts:+${line}:${reason}`, hunk: v.hunks[0].id, path: "src/f0.ts", line, old: false, severity, reason });
    v.ai = { ...v.ai, suspects: [sug(2, "medium", "Unrelated change"), sug(4, "low", "a nit")] };
    const [f] = v.findings();
    assert.deepEqual([v.findings().length, f.id, f.ids, f.security, v.sourcesOf(f)], [1, "a1", ["s1", "a1", f.ids[2]], true, "Security review: high · Analysis: high · AI note: medium"]);
    // Its card in the diff carries what the other sources say in their own words (F4).
    assert.deepEqual(v.findRows(f).map(([l]) => l).filter((l) => ["Analysis", "Security review", "AI note"].includes(l)).length, f.sources.filter((y) => y.title !== f.title || y.detail !== f.detail).length);
    assert.ok(v.findRows(f).some(([l, x]) => l === "AI note" && x.startsWith("(medium) Unrelated change")));
    assert.deepEqual(v.openSugs().map((s) => s.reason), ["a nit"]);
    assert.equal(v.fstatus(f), "progress");
    assert.deepEqual([v.counts().unresolved, v.counts().sent, v.counts().security, v.openFindings().length], [1, 1, 1, 1]);
    assert.match(v.blockersNow().find((b) => b.finding === "a1").why, /unresolved high finding · fix sent, not verified/);
    assert.equal(v.fixLine(f), "commit 22e31c88 · agent reports fixed · not verified");
    assert.deepEqual(v.fixFacts(f).map(([k]) => k), ["Commit", "Report", "Check"]);
    assert.deepEqual(v.layerFindings(v.ai.steps[1]).map((x) => x.id), ["a1"]);
    v.ffocus = "a1";
    ok("the Findings tab: a merged finding open, with a fix sent", () => v.render(cx));
    // Its steps with the fix's details open, the owner of its file, and quick wins first once a finding has an effort.
    v.fstep = { id: "a1", key: "sent" }; v.fsort = true; v.ai = { ...v.ai, components: [{ name: "F0", at: "src/f0.ts:1", owner: "@team" }] };
    ok("the Findings tab: a step's details open, an owner, sorted by effort", () => v.render(cx));
    v.command("finding-step:sent", cx); assert.equal(v.fstep, null, "the step's click again folds it");
    v.command("findings-sort:", cx); assert.equal(v.fsort, false);
    // A click in a picture ends the drag its press began: later mouse moves no longer pull the picture back to the
    // place that was clicked (its mouse-up never reaches the root, the card's on_click stops it).
    { const s = v.hsOf("rv-arch-canvas"); Object.assign(s, { x: 300, maxX: 900, contentW: 1800, visW: 900 });
      const press = () => { v.hsDrag = { id: "rv-arch-canvas", x0: 100, from: s.x }; };
      for (const click of [() => v.archOpts("arch").onFocus("n1", cx), () => v.jumpTo("src/f0.ts:1", cx), () => v.secCard(null, cx)]) {
        press(); click(); s.x = 40; v.hsMove({ position: { x: 600 } }, cx); assert.equal(s.x, 40, "a click left no drag behind");
      }
      press(); v.hsMove({ position: { x: 60 } }, cx); assert.equal(s.x, 80, "a real drag still pans: 40 px to the left moves it 40 to the right");
      press(); v.hsWheel("rv-arch-canvas", { delta: { x: -10, y: 0 }, modifiers: {} }, cx); assert.equal(v.hsDrag, null, "a wheel is never a drag");
      v.hsDrag = null; v.archFocus = null; s.x = 0; }
    // A finding outside the diff opens its file read-only (as a definition does); a jump that failed says so until the next one.
    { const calls = [], go = v.goDef, wt = v.worktree, ps = v.prSel; v.goDef = (d) => calls.push([d.path, d.line]); v.worktree = { ...wt, path: "/checkout" };
      v.jumpTo("library/loans.py:41", cx); v.jumpTo("src/f0.ts:1", cx); v.worktree = null; v.prSel = { ...v.prSel, space: false }; v.jumpTo("nowhere.py:3", cx);
      assert.deepEqual([calls, v.note], [[["library/loans.py", 41]], "Could not find nowhere.py:3 in the diff"]);
      v.jumpTo("src/f0.ts:1", cx); assert.equal(v.note, null, "the next jump clears it");
      // A jump from goDef never goes back to goDef, whatever the two make of the path (no loop).
      v.jumpTo("library/loans.py:41", cx, { fromDef: true }); assert.equal(calls.length, 1); assert.match(v.note, /^Could not find library\/loans.py:41/);
      v.jumpTo("src/f0.ts:1", cx);
      v.defFile = { path: "library/loans.py", line: 41, from: 0, lines: [], spans: [] }; v.command("file:src/f0.ts", cx); assert.equal(v.defFile, null, "a jump to a file shows the diff again");
      v.defFile = { path: "x", line: 1, from: 0, lines: [], spans: [] }; v.command("page:overview", cx); assert.equal(v.defFile, null); v.page = null; v.tab = "findings";
      v.goDef = go; v.worktree = wt; v.prSel = ps; }
    v.tab = "files"; v.page = null; v.sug = v.openSugs()[0].key;
    ok("the diff: the finding's card and the note, opened", () => { v.render(cx); layout(0); });
    assert.deepEqual(v.items.filter((it) => ["find", "fact", "sug"].includes(it.t)).map((it) => it.t), ["find", "fact", "sug"], "a fix sent stays in the diff; one note, no buttons");
    // Cards in the diff: a security finding from high on starts open; folded, a card is one row without buttons.
    assert.equal(v.findOpen(f), true); assert.equal(v.findOpen({ ...f, security: false }), false);
    v.fopen = new Map([[f.id, false]]);
    ok("the diff: the finding's card folded", () => { v.render(cx); layout(0); });
    assert.deepEqual(v.items.filter((it) => ["find", "fact"].includes(it.t)).map((it) => it.t), ["find"]);
    v.fopen = null;
    v.dismiss(f, cx);
    assert.deepEqual([v.fstatus(v.findings()[0]), v.counts().unresolved], ["dismissed", 0]); assert.match(v.note, /all 3 sources of it/);
    v.find = { ...v.find, list: [], status: {}, reports: {} }; v.ai = { ...v.ai, suspects: [] }; v.sug = null; v.ffocus = null; v.note = null; v.tab = "findings";
    console.log("one finding per defect ok");
  }
  v.ai = { ...v.ai, steps: v.ai.steps.map((s) => ({ ...s, findings: [] })) };
  assert.deepEqual(v.findings(), [], "a finding the newest analysis no longer has is gone");
  v.tab = "files"; v.page = null; v.deep.drawer[v.deepKey()] = "open";
  ok(`${n} files: back to the list with the drawer open`, () => { v.render(cx); layout(0.5); v.autoFold(cx); });
}
// The Comments tab and the diff with GitHub's resolved and outdated threads, a bot's old and new comments, and a
// stale comment of yours (its line read "y" when written, "x" now).
{
  const { withThreadState } = await import("./threads.js");
  const v = review(3), g = (id, user, extra) => ({ id, path: "src/f0.ts", line: id, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at: `2024-01-0${id}`, commit_id: "c1", body: `b${id}`, ...extra });
  v.gh = withThreadState([g(1, "anna"), g(2, "anna", { in_reply_to_id: 1 }), g(3, "lint[bot]"), g(4, "lint[bot]", { commit_id: "c2" }), g(5, "bob", { line: null, original_line: 9, outdated: true })],
    [{ id: 1, resolved: true, outdated: false }]);
  v.head = "new";
  v.comments = [{ id: "s1", file: "src/f0.ts", start: 1, end: 1, old: false, text: "stale", code: "y", head: "old" }, { id: "s2", file: "src/f0.ts", start: 2, end: 2, old: false, text: "fresh", code: "x", head: "old" }];
  assert.deepEqual([...v.staleNow()], ["s1"]);
  assert.deepEqual([v.ghNow().resolved, v.ghNow().botsHidden, v.ghNow().list.map((x) => x.id)], [1, 1, [4, 5]], "resolved hidden, the bot's older commit hidden");
  v.tab = "comments"; v.page = null;
  ok("Comments tab: resolved, bots, outdated, stale", () => v.render(cx));
  assert.ok(v.commentRowsNow().find((r) => r.id === "s1").stale && v.commentRowsNow().find((r) => r.id === "gh5").outdated);
  v.showResolved = true; v.allBots = true;
  ok("Comments tab: resolved and all bot comments shown", () => v.render(cx));
  assert.ok(v.commentRowsNow().find((r) => r.id === "gh1").resolved);
  v.tab = "files";
  ok("Files: the cards with STALE, Resolved and an outdated comment at the file's end", () => { v.render(cx); layout(0); });
  const items = v.filesItems().items;
  assert.ok(items.some((it) => it.t === "gh" && it.loose && it.g.id === 5), "the outdated comment shows loose");
  assert.ok(items.some((it) => it.t === "gh" && !it.loose && it.g.id === 1), "a resolved thread under its line once shown");
}
// The left column. A layer is ticked by its files' "Viewed" boxes alone: not by opening its hunks, not by an old stored
// tick. A reviewer's finding counts at the layer of its file. "Needs your attention" lists the blockers, security first.
{
  const v = review(3), [h0, h1, h2] = v.hunks;
  const lf = { id: "a2", reviewer: "analysis", step: "k", file: "src/f0.ts", line: 1, end: 1, severity: "high", category: "bug", title: "Wrong sum", detail: "d", suggestion: "" };
  v.ai = { cut: [], exact: true, visuals: [], asks: [], model: "sonnet", title: "t", summary: "s", arch: { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "x" }] }, steps: [
    { title: "one", why: "w", text: "", hunks: [h0.id, h1.id], questions: [], risk: "high", order: 1, findings: [lf] }, { title: "two", why: "w", text: "", hunks: [h2.id], questions: [], risk: "low", order: 2, findings: [] }] };
  v.find = { ...v.find, list: [{ id: "s9", reviewer: "security", file: "src/f1.ts", line: 3, end: 3, severity: "high", title: "Open door", detail: "d", suggestion: "" },
    { id: "c9", reviewer: "claude", file: "src/f2.ts", line: 1, end: 1, severity: "medium", title: "Edge case", detail: "d", suggestion: "" }] };
  const [one, two] = v.steps();
  v.prog.visited = new Set(v.hunks.map((h) => h.id)); v.prog.checked = { [stepKey(one)]: true };
  assert.equal(v.done(one), false, "opening every hunk, or a tick stored by an older version, does not tick a layer");
  v.toggleSeen("src/f0.ts", cx); assert.equal(v.done(one), false, "one of its two files viewed");
  v.toggleSeen("src/f1.ts", cx); assert.deepEqual([v.done(one), v.done(two)], [true, false], "all its files viewed");
  assert.deepEqual(v.layerFindings(one).map((f) => f.id), ["a2", "s9"], "the reviewer's finding counts at the layer of its file");
  assert.deepEqual(v.layerFindings(two).map((f) => f.id), ["c9"]);
  assert.deepEqual(v.attention().map((a) => [a.label, a.security, a.at]), [["Open door", true, "f1.ts:3"], ["Rule not met: Conventional Commit title", false, ""], ["Wrong sum", false, "f0.ts:1"]],
    "the Overview's Before merge rows in their order (pr.js beforeMerge): security first; no layers and no medium finding");
  v.tab = "steps"; v.page = "arch";
  ok("Analysis tab beside a page: the pages on top, the attention box open", () => v.render(cx));
  const list = v.attention();
  assert.equal(v.attFolded(list), false, "on a page in a tall column (or one not measured yet) the box is open");
  v.paneH = 500; assert.equal(v.attFolded(list), true, "under the pages in a short column it starts folded");
  v.attFold = false; assert.equal(v.attFolded(list), false, "a click on its heading opens it");
  v.attFold = null; v.paneH = 900; v.page = null; assert.equal(v.attFolded(list), true, "a layer open: folded");
  v.command("files", cx); v.command("analysis", cx); assert.equal(v.tab, "steps", "pr-review.analysis is the Analysis tab");
  v.page = "arch";
  v.page = null; v.cur = 0;
  ok("Analysis tab with a layer open: the box folded, the layer's files with their ticks", () => v.render(cx));
  v.attFold = false;
  ok("Analysis tab with a layer open: the box unfolded by a click", () => v.render(cx));
  v.tab = "files";
  ok("Files tab: findings in words, the security mark, the ticks", () => v.render(cx));
  v.find = { ...v.find, status: { a2: { s: "progress", fixHead: "h0", at: "2024-01-01" } } };
  assert.deepEqual(v.attention().map((a) => a.sent), [false, false, true], "a fix sent stays a blocker and says so");
  v.tab = "steps"; v.attFold = false;
  ok("Analysis tab: a blocker with a fix sent", () => v.render(cx));
  v.dismiss(v.findingById("s9"), cx); v.dismiss(v.findingById("a2"), cx);
  assert.deepEqual(v.attention().map((a) => [a.label, a.severity]), [["Rule not met: Conventional Commit title", null]], "the findings settled: the title rule is left (a check has no severity)");
  v.tab = "steps"; v.prSel = { ...v.prSel, title: "feat: t" };
  ok("Analysis tab without blockers", () => v.render(cx));
  assert.deepEqual(v.attention(), []);
  // The Comments tab: a file's heading and a row's command land the diff at that file (the tab stays).
  v.tab = "files"; v.command("cfile:src/f2.ts", cx); assert.deepEqual([v.tab, v.top?.view, v.top?.key, v.fileFocus], ["comments", "files", "src/f2.ts", "src/f2.ts"]);
  console.log("left column ok");
}
// The minimized review: nothing without one, an entry with Resume and ✕ with one.
globalThis.__rv.store.set("review.minimized", null);
renderMini();
globalThis.__rv.store.set("review.minimized", { target: { url: "https://github.com/o/r/pull/7", number: 7, title: "feat: x", repo: "o/r" }, at: 1 });
renderMini();
globalThis.__rv.store.set("review.minimized", null);
console.log("render ok");
