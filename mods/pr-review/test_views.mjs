// Run: node test_views.mjs  (the panel's picking / selected state, the in-progress cap, a flow visual as archLayout input)
import assert from "node:assert/strict";
import { panelState, bodyTab, capped, flowArch, IN_PROGRESS_MAX, wheelStep, GESTURE_MS, byState, listRows, riskSignal, progressText, pendingText } from "./views.js";
import { scopeTable, runSummary, exposureOf, surfaceOf } from "./views.js";
import { archLayout } from "./arch.js";

// Picking until something is chosen; PRs ▾ goes back to picking without dropping the choice.
assert.equal(panelState({ chosen: null, picking: false }), "picking");
assert.equal(panelState({ chosen: { url: "u" }, picking: false }), "selected");
assert.equal(panelState({ chosen: { url: "u" }, picking: true }), "picking");
assert.equal(panelState({ chosen: "branch", picking: false }), "selected");
assert.equal(bodyTab("walk"), "walk");
assert.equal(bodyTab("diff"), "diff");
assert.equal(bodyTab(undefined), "diff");

// In progress: three, then "Show all (n)".
const six = [1, 2, 3, 4, 5, 6];
assert.equal(IN_PROGRESS_MAX, 3);
assert.deepEqual(capped(six), { shown: [1, 2, 3], more: 3 });
assert.deepEqual(capped(six, true), { shown: six, more: 0 });
assert.deepEqual(capped([1, 2]), { shown: [1, 2], more: 0 });
assert.deepEqual(capped([]), { shown: [], more: 0 });

// A flow: one implicit group, notes as descriptions, changed as status, transition text as labels, sources kept.
const flow = { kind: "flow", title: "One run", nodes: [
  { id: "job", label: "Job" }, { id: "rem", label: "sendDueReminders", changed: true, note: "new", source: "implemented", at: "src/loans/reminders.ts:3" },
  { id: "mail", label: "sendEmail", source: "existing" }, { id: "sms", label: "SMS", source: "spec" }],
  edges: [{ from: "job", to: "rem", label: "run" }, { from: "rem", to: "mail", label: "reminder", changed: true, source: "implemented" },
    { from: "rem", to: "sms", event: "due", guard: "opted in", source: "spec" }] };
const a = flowArch(flow);
assert.deepEqual(a.groups, [{ id: "flow", label: "", kind: "" }]);
assert.ok(a.nodes.every((n) => n.group === "flow"));
const rem = a.nodes.find((n) => n.id === "rem");
assert.equal(rem.description, "new"); assert.equal(rem.status, "changed"); assert.equal(rem.source, "implemented"); assert.equal(rem.at, "src/loans/reminders.ts:3");
assert.equal(a.nodes.find((n) => n.id === "job").status, undefined);
assert.equal(a.edges[1].status, "changed");
assert.equal(a.edges[2].label, "due [opted in]");
assert.equal(a.edges[2].source, "spec");
// Laid out like Architecture impact: left to right, one numbered path per edge, the spec one dashed.
const L = archLayout(a);
const x = new Map(L.nodes.map((n) => [n.id, n.x]));
assert.ok(x.get("job") < x.get("rem") && x.get("rem") < x.get("mail"));
assert.deepEqual(L.paths.map((p) => p.num), [1, 2, 3]);
assert.ok(L.paths.find((p) => p.to === "sms").dashed);
assert.equal(L.groups.length, 1);

// Its own groups stay; transitions count as edges too; an empty visual lays out empty.
const g = flowArch({ groups: [{ id: "api", label: "API", kind: "service" }], nodes: [{ id: "a", label: "A", group: "api" }], transitions: [{ from: "a", to: "a", label: "loop" }] });
assert.deepEqual(g.groups.map((x) => x.id), ["api"]);
assert.equal(g.nodes[0].group, "api");
assert.equal(g.edges.length, 1);
assert.equal(archLayout(flowArch({})).nodes.length, 0);
console.log("views: ok");

// Sideways scrollers: one axis per gesture, the offset clamped to [0, max].
{
  const run = (events, x = 0, max = 100) => { let g = null, used = []; for (const e of events) { const r = wheelStep(g, e, x, max); g = r.g; x = r.x; used.push(r.used); } return { axis: g?.axis, x, used }; };
  assert.deepEqual(run([{ dx: -10, dy: 2, t: 0 }, { dx: -5, dy: 30, t: 20 }]), { axis: "x", x: 15, used: [true, true] }, "starts sideways: stays sideways, the page gets nothing");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: 20 }]), { axis: "y", x: 0, used: [false, false] }, "starts down: the picture never moves in that gesture");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: GESTURE_MS + 1 }]), { axis: "x", x: 40, used: [false, true] }, "a pause ends the gesture");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: 10, phase: "started" }]), { axis: "x", x: 40, used: [false, true] }, "a new touch ends it too");
  assert.deepEqual(run([{ dy: -30, t: 0, shift: true }]), { axis: "x", x: 30, used: [true] }, "shift+wheel is sideways");
  assert.equal(run([{ dx: -500, t: 0 }]).x, 100, "clamped at max");
  assert.equal(run([{ dx: 500, t: 0 }], 20).x, 0, "clamped at 0");
  assert.deepEqual(run([{ dx: -10, t: 0 }], 0, 0), { axis: "x", x: 0, used: [false] }, "nothing to scroll: the page keeps the event");
  assert.equal(run([], 300).x, 300); assert.equal(wheelStep(null, { dy: 5, t: 0 }, 300, 100).x, 100, "an offset beyond a shrunk max is clamped");
  console.log("wheel ok");
}

// gh pr diff too large -> local fallback; other errors rethrow.
import { diffTooLarge, filesToDiff } from "./views.js";
assert.ok(diffTooLarge("could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)."));
assert.ok(diffTooLarge("... too_large ..."));
assert.ok(!diffTooLarge("HTTP 404: Not Found"));
assert.ok(!diffTooLarge(""));

// The files API as diff text, parsed by pr.js.
import { splitPatch } from "./pr.js";
const fs = splitPatch(filesToDiff([
  { filename: "a.js", status: "added", patch: "@@ -0,0 +1,2 @@\n+x\n+y" },
  { filename: "b.js", status: "removed", patch: "@@ -1 +0,0 @@\n-z" },
  { filename: "n.js", previous_filename: "o.js", status: "renamed", patch: "@@ -1 +1 @@\n-a\n+b" },
  { filename: "img.png", status: "modified", additions: 0, deletions: 0 },
]));
assert.deepEqual(fs.map((f) => [f.path, f.status, f.add, f.del, f.binary]), [["a.js", "added", 2, 0, false], ["b.js", "deleted", 0, 1, false], ["n.js", "renamed", 1, 1, false], ["img.png", "modified", 0, 0, true]]);
assert.equal(fs[2].from, "o.js");
assert.ok(filesToDiff([{ filename: "i.png", status: "modified" }]).includes("No diff from GitHub for this file"));

// Lock files and big changes fold when a review opens.
{
  const { foldOnOpen } = await import("./views.js");
  const f = (path, add = 1, del = 0) => ({ path, add, del });
  const out = foldOnOpen([f("package-lock.json"), f("web/yarn.lock"), f("Cargo.lock"), f("go.sum"), f("dist/app.min.js"), f("src/big.ts", 300, 150), f("src/small.ts", 10, 2), f("docs/locking.md")]);
  assert.deepEqual(out, ["package-lock.json", "web/yarn.lock", "Cargo.lock", "go.sum", "dist/app.min.js", "src/big.ts"]);
  assert.deepEqual(foldOnOpen(null), []);
}

// The Files list's room: the file in view first, the newest opened next, then nearest (below first); the cap holds.
{
  const { allocate, recenter, lastAtOrBelow, RECENT } = await import("./views.js");
  const files = ["a", "b", "c", "d", "e"].map((path, i) => ({ path, i, n: 10 }));
  const open = (o) => files.map((f) => f.path).filter((p) => !o.has(p));
  assert.deepEqual(open(allocate({ files, center: 2, cap: 30 })), ["b", "c", "d"]); // centre, then d (below) before b
  assert.deepEqual(open(allocate({ files, center: 2, cap: 20 })), ["c", "d"]);
  assert.deepEqual(open(allocate({ files, center: 0, cap: 30 })), ["a", "b", "c"]); // the top: in order
  assert.deepEqual(open(allocate({ files, center: 4, cap: 20 })), ["d", "e"]);
  assert.deepEqual(open(allocate({ files, center: 2, recent: ["a"], cap: 20 })), ["a", "c"]); // opened by you: before the neighbours
  const many = Array.from({ length: RECENT + 1 }, (_, k) => `r${k}`);
  assert.equal(allocate({ files: [{ path: many[RECENT], i: 9, n: 10 }, { path: "x", i: 1, n: 10 }], center: 0, recent: many, cap: 10 }).has("x"), false); // only the newest RECENT jump the queue
  assert.deepEqual([...allocate({ files: files.filter((f) => f.path !== "c"), center: 2, cap: 20 })].sort(), ["a", "e"]); // a collapsed file isn't offered, never in the set
  const big = allocate({ files: [{ path: "a", i: 0, n: 5 }, { path: "b", i: 1, n: 50 }, { path: "c", i: 2, n: 5 }], center: 0, cap: 20 });
  assert.deepEqual([...big], ["b"]); // the cap holds; smaller files further away still fit
  assert.equal(allocate({ files: [{ path: "a", i: 0, n: 50 }], center: 0, cap: 20 }).has("a"), true);

  assert.equal(lastAtOrBelow([0, 5, 9], 0), 0); assert.equal(lastAtOrBelow([0, 5, 9], 7), 1); assert.equal(lastAtOrBelow([0, 5, 9], 99), 2);
  // Items 20 px each; files start at items 0, 50, 100, 150; file 3 (items 150..) is folded: one item 150..151.
  const top = Array.from({ length: 153 }, (_, i) => i * 20), heads = [0, 50, 100, 150], folds = [[3000, 3020]];
  const at = (start, center, margin = 500) => recenter({ heads, top, folds, start, end: start + 10, center, margin });
  assert.equal(at(10, 0), null); // the file the room was given around: nothing changes
  assert.equal(at(55, 0), null); // another file, but the fold is far below (3000 > 65*20+500)
  assert.equal(at(120, 0), 2); // near the fold: open around file 2
  assert.equal(at(120, 2), null); // already there
  assert.equal(at(120, 0, 0), null); // margin 0: the fold isn't on screen yet
  assert.equal(recenter({ heads, top, folds: [], start: 120, end: 130, center: 0, margin: 500 }), null); // nothing folded
  assert.equal(recenter({ heads, top, folds: [[0, 20]], start: 55, end: 65, center: 3, margin: 500 }), null); // fold far above
  assert.equal(recenter({ heads, top, folds: [[0, 20]], start: 52, end: 62, center: 3, margin: 1500 }), 1); // fold above, near
  console.log("room ok");
}

// Under the Ask drawer: the scroll's max counts only the visible width.
{
  const { hsVisible } = await import("./views.js");
  const max = (contentW, measured, covered) => Math.max(0, contentW - hsVisible(measured, covered));
  assert.equal(max(1500, 1000, 0), 500);
  assert.equal(max(1500, 1000, 380), 880); // drawer open over the picture: 380 px more to scroll
  assert.equal(max(1500, 1000, 28), 528); // folded strip
  assert.equal(max(500, 1000, 380), 0); // fits beside the drawer
  assert.equal(hsVisible(300, 380), 100);
  console.log("hscroll ok");
}

// A jump lands at the top: the item to centre so the view sits just past the target (review.js settleTop).
{
  const { pastTop } = await import("./views.js");
  const rows = Array.from({ length: 100 }, () => 20); // 20 px each: item k spans 20k..20k+20
  // Target 10 (top 200), view 400: centring item 20 (centre 410) puts the view at 210, 10 px past the target's top.
  assert.equal(pastTop(rows, 10, 400), 20);
  const j = pastTop(rows, 10, 400), offset = j * 20 + 10 - 200;
  assert.ok(offset > 200 && offset < 220, "the target's top is cut off above, by less than one item");
  assert.equal(pastTop(rows, 0, 400), 10);
  assert.equal(pastTop(rows, 95, 400), 99, "less than a view below the target: the list's end");
  // A tall card where the centre would fall: the next item whose centre is past it.
  const mixed = [20, 20, 300, 20, 20, 20, 20];
  assert.equal(pastTop(mixed, 0, 200), 2, "centre of the card (190) is past 100");
  assert.equal(pastTop(mixed, 1, 500), 3, "the card's centre (190) is not past 270, the row after it is");
  console.log("jump to top ok");
}
// ---- the PR list (main.js picker)

// Mine mixes open and merged PRs: open and draft ones first, the rest in their own group; only open ones get a way
// into the review.
const mine = [{ url: "m1", state: "merged" }, { url: "o1", state: "open" }, { url: "c1", state: "closed" }, { url: "d1", state: "draft" }, { url: "m2", state: "merged" }];
assert.deepEqual(byState(mine).open.map((p) => p.url), ["o1", "d1"]);
assert.deepEqual(byState(mine).done.map((p) => p.url), ["m1", "c1", "m2"]);
assert.deepEqual(byState([]), { open: [], done: [] });

// One row per PR: a PR shown under "In progress" leaves the list below; one that is in progress but not shown there
// (over the cap) stays, and its row resumes instead of starting again.
const started = [{ url: "o1" }, { url: "x" }, { url: "y" }, { url: "d1" }];
const rows = listRows(mine, started, started.slice(0, 3));
assert.deepEqual(rows.list.map((p) => p.url), ["m1", "c1", "d1", "m2"]);
assert.equal(rows.above, 1);
assert.equal(rows.started.get("d1"), started[3]);
assert.equal(rows.started.has("m1"), false);
assert.deepEqual(listRows(mine, [], []).list, mine);

// The risk signal of a row comes from cached files only: the highest severity among the open findings (the analysis'
// own and the reviewers'), and whether one of them is about security. Nothing cached: nothing shown.
assert.equal(riskSignal({}), null);
assert.equal(riskSignal({ analysis: null, findings: undefined }), null);
const layers = { steps: [{ findings: [{ id: "a1", severity: "medium", category: "bug" }, { id: "a2", severity: "high", category: "security" }] }, { findings: [{ id: "a3", severity: "low", category: "structure" }] }, {}] };
const reviewers = [{ id: "r1", reviewer: "security", severity: "critical" }, { id: "r2", reviewer: "claude", severity: "medium" }];
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers }), { top: "critical", open: 5, security: true });
// A fixed or dismissed finding no longer counts; one with a fix sent (progress) still does.
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers, status: { r1: { s: "fixed" }, a2: { s: "progress" } } }), { top: "high", open: 4, security: true });
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers, status: { r1: { s: "dismissed" }, a2: { s: "fixed" } } }), { top: "medium", open: 3, security: false });
assert.deepEqual(riskSignal({ analysis: { steps: [] }, findings: [] }), { top: null, open: 0, security: false });
// ⛨ as in the review (pr.js isSecurity): by the finding's effect when it has one, not by who found it.
assert.equal(riskSignal({ findings: [{ id: "s", reviewer: "security", severity: "high", impact: "edge_case", category: "bug" }] }).security, false, "the security reviewer's bug is no security finding");
assert.equal(riskSignal({ findings: [{ id: "c", reviewer: "claude", severity: "high", impact: "unauthorized_access", category: "bug" }] }).security, true, "access without permission is, whoever found it");
assert.equal(riskSignal({ findings: [{ id: "d", reviewer: "claude", severity: "high", impact: "data_loss", category: "data" }] }).security, false, "data loss only with the category security");
// An analysis cached before layers had findings still loads.
assert.deepEqual(riskSignal({ analysis: {} }), { top: null, open: 0, security: false });

// The progress of a review in progress says "layers", like the review's tab, and leaves out what is zero.
assert.equal(progressText({ steps: 6, stepsChecked: 0, files: 9, filesViewed: 2, comments: 1, replies: 0, fixedThreads: 0, findingsOpen: 11 }), "0/6 layers · 2/9 files · 1 comment · 11 open findings");
assert.equal(progressText({ steps: 1, stepsChecked: 1, comments: 2, replies: 1, fixedThreads: 3, findingsOpen: 1 }), "1/1 layers · 2 comments · 1 reply · 3 fixed · 1 open finding");
assert.equal(progressText(), "");

assert.equal(pendingText([{ file: "a.py" }]), "1 pending comment in 1 file");
assert.equal(pendingText([{ file: "a.py" }, { file: "a.py" }, { file: "b.py" }]), "3 pending comments in 2 files");

// The review's left column. The order switch only matters when reading order and the analysis' order differ.
{
  const { orderDiffers, worst, byUrgency } = await import("./views.js");
  assert.equal(orderDiffers([{ order: 1 }, { order: 2 }, { order: 3 }]), false);
  assert.equal(orderDiffers([{ order: 2 }, { order: 1 }]), true);
  assert.equal(orderDiffers([]), false);
  // A row's findings in words: the highest severity with its count, all of them for the tooltip, security counted.
  assert.equal(worst([]), null);
  assert.deepEqual(worst([{ severity: "medium" }, { severity: "high", security: true }, { severity: "medium" }, { severity: "low" }]),
    { severity: "high", count: 1, total: 4, label: "1 high", words: "1 high, 2 medium, 1 low", security: 1 });
  assert.equal(worst([{ severity: "low" }, { severity: "low" }]).label, "2 low");
  // Blockers by severity, security first among equals, the rest in their order.
  const bs = [{ severity: "medium", title: "rule" }, { severity: "high", title: "bug" }, { severity: "low", title: "overlap" }, { severity: "high", title: "auth", finding: "s1" }, { severity: "high", title: "bug 2" }];
  assert.deepEqual(byUrgency(bs, (b) => b.finding === "s1").map((b) => b.title), ["auth", "bug", "bug 2", "rule", "overlap"]);
  assert.deepEqual(byUrgency(bs).map((b) => b.title), ["bug", "auth", "bug 2", "rule", "overlap"]);
  // "By focus" follows what the rows show: "Tests · 3 medium" after "SAM template · 1 high ⛨" (it came first by the
  // hidden field risk), security first among equals, then more findings, then reading order, no findings last.
  const { byFocus } = await import("./views.js");
  const L = (title, order, ...fs) => ({ title, order, fs });
  const ls = [L("events", 1, { severity: "high" }), L("tests", 2, { severity: "medium" }, { severity: "medium" }, { severity: "medium" }), L("docs", 3),
    L("template", 4, { severity: "high", security: true }), L("handler", 5, { severity: "high" }, { severity: "high" }), L("reminders", 6, { severity: "high" })];
  assert.deepEqual(byFocus(ls, (l) => l.fs).map((l) => l.title), ["template", "handler", "events", "reminders", "tests", "docs"]);
  // A layer's ways in and rights from the access rows at its files: public or opened by the PR; others do not count.
  const { layerAccess } = await import("./views.js");
  const acc = [{ resource: "FrontDesk Api", kind: "route", public: true, auth_kind: "code", at: "template.yaml:24" },
    { resource: "Queue", kind: "queue", principal: "FrontDesk function", actions: ["sqs:SendMessage"], public: false, opened_by_pr: true, at: "template.yaml:20" },
    { resource: "Old table", kind: "table", principal: "Job", actions: ["read"], public: false, at: "infra/db.yaml:3" }];
  assert.deepEqual(layerAccess(acc, ["deploy/template.yaml"]), { entries: 1, grants: 1,
    text: "This layer opens a public route (FrontDesk Api), and grants FrontDesk function sqs:SendMessage on Queue." });
  assert.equal(layerAccess(acc, ["infra/db.yaml", "src/a.py"]), null, "an old right the PR does not open");
  assert.equal(layerAccess([], ["a"]), null);
  // The analysis' head and age at the top of the column, amber once the PR moved on.
  const { analysisAge } = await import("./views.js");
  assert.deepEqual(analysisAge({ head: "abcdef123", exact: true, now: "abcdef123", age: "2 h ago" }), { stale: false, text: "Analysis of abcdef1, 2 h ago" });
  assert.deepEqual(analysisAge({ head: "abcdef123", exact: false, now: "9876543ff", age: "1 d ago" }), { stale: true, text: "Analysis of abcdef1, 1 d ago · the PR is at 9876543 now" });
  assert.deepEqual(analysisAge({ exact: true, age: "5 min ago" }), { stale: false, text: "Analysis of this diff, 5 min ago" }, "an analysis from before it saved its head");
  assert.equal(analysisAge({ exact: false, now: "9876543" }).text, "Analysis of an older diff");
  // "Before merge" counted by group: criteria each once (a finding that breaks two and a criterion without a finding),
  // resilience paths apart from what is not observable, other findings by severity; five shown, each group first.
  const { mergeGroups, mergeFirst } = await import("./views.js");
  const A = (id) => ({ id }), F = (id, severity = "high") => ({ id, severity });
  const bm = [{ kind: "security", finding: F("s1") }, { kind: "security", finding: F("s2") }, { kind: "resilience", path: "p1" }, { kind: "resilience", path: "p2" }, { kind: "resilience", path: "p3" },
    { kind: "resilience", path: null }, { kind: "criterion", finding: F("c1"), asks: [A("a1"), A("a2")] }, { kind: "criterion", finding: F("c2"), asks: [A("a1")] }, { kind: "ask", ask: A("a3"), asks: [A("a3")] },
    { kind: "rule" }, { kind: "finding", finding: F("h1") }, { kind: "finding", finding: F("h2") }, { kind: "verify" }];
  assert.deepEqual(mergeGroups(bm).map((g) => g.text), ["⛨ 2 security", "3 resilience paths", "1 not observable", "3 criteria", "1 check", "2 high", "1 fix to verify"]);
  assert.deepEqual(mergeFirst(bm, 5).map((r) => bm.indexOf(r)), [0, 1, 2, 5, 6], "every security row, then one of each group in order before a second of any");
  assert.deepEqual(mergeFirst(bm.slice(2), 5).map((r) => bm.slice(2).indexOf(r)), [0, 3, 4, 7, 8]);
  assert.deepEqual(mergeFirst(bm.slice(0, 3), 5).length, 3);
  assert.deepEqual(mergeGroups(bm.slice(7), [bm[6]]).map((g) => g.text), ["1 criterion", "1 check", "2 high", "1 fix to verify"], "the criteria a shown row breaks are not counted again");
  // By cause: the later finding of a cause goes while the first is open, and the first row names its place.
  const { byCause } = await import("./views.js");
  const tok = { id: "a1", ids: ["a1"] }, tpl = { id: "a2", ids: ["a2"], same_cause: "a1" }, other = { id: "a3", ids: ["a3"] };
  const cr = [{ kind: "security", finding: tok, where: "handler.py:9" }, { kind: "finding", finding: tpl, where: "template.yaml:14" }, { kind: "finding", finding: other, where: "x.py:1" }];
  assert.deepEqual(byCause(cr, [tok, tpl, other]).map((r) => [r.where, r.also ?? null]), [["handler.py:9", ["template.yaml:14"]], ["x.py:1", null]]);
  assert.equal(byCause(cr, [tpl, other]).length, 3, "the first one fixed: the later one stands for the cause again");
  // A session log priced once per reply (a reply spans lines), cache reads at a tenth; a fix's estimate and cost so far.
  const { sessionCost, sessionDir, fixEstimate, fixCostLine } = await import("./views.js");
  const msg = (id, ts, u) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-sonnet-5-5", usage: u } });
  const log = [msg("m1", "2026-11-15T00:00:00Z", { input_tokens: 1000, output_tokens: 1000 }), msg("m1", "2026-11-15T00:00:00Z", { input_tokens: 1000, output_tokens: 1000 }),
    msg("m2", "2026-11-15T00:01:00Z", { cache_read_input_tokens: 1000000 }), "not json", JSON.stringify({ type: "user" })].join("\n");
  const sc = sessionCost(log);
  assert.deepEqual([Number(sc.usd.toFixed(4)), sc.ms, sc.replies], [0.212, 60000, 2], "1000 in at $2 + 1000 out at $10 + 1M cache reads at $0.20");
  assert.equal(sessionDir("/h/.claude-private", "/h/.herdr/worktrees/x/fix-2-ab"), "/h/.claude-private/projects/-h--herdr-worktrees-x-fix-2-ab");
  assert.equal(fixEstimate("sonnet"), "about $0.15 and 1 min");
  assert.match(fixEstimate("opus"), /, estimated from Sonnet runs$/);
  assert.deepEqual([fixCostLine(0.12, "sonnet").text, fixCostLine(0.31, "sonnet").over, fixCostLine(0.31, "sonnet", 2).over], ["$0.12 so far", true, false]);
  assert.equal(fixCostLine(0.31, "sonnet").text, "$0.31 so far · above the usual cost; stop it in its tab");
  // A finished run is offered as Re-run with its age and head, not as a first Run.
  const { runLabel } = await import("./views.js");
  assert.equal(runLabel(null, "about $0.27, 1 min"), "Run (about $0.27, 1 min)");
  assert.equal(runLabel({ state: "failed" }, "about $0.27, 1 min"), "Run again (about $0.27, 1 min)");
  assert.equal(runLabel({ state: "done", head: "ccddf9524aec" }, "about $0.27, 1 min", "1 h ago"), "Re-run (about $0.27, 1 min) · last run 1 h ago on ccddf95");
  assert.equal(runLabel({ state: "done" }, null), "Re-run · last run");
  assert.equal(runLabel({ state: "done", head: "ccddf95" }, "about $0.13, 1 min", "13 h ago", true), "Re-run (about $0.13, 1 min)", "the popup says the last run in its line");
  // The state hints at the top of the Analysis tab: checkout, an analysis waiting for it, reviewer runs.
  const { stateHints } = await import("./views.js");
  assert.deepEqual(stateHints({ checkout: { busy: true }, pendingRun: true, runs: { security: { busy: true }, claude: { at: "x" } }, names: { security: "Security review" } }).map((h) => [h.key, h.text, Boolean(h.spin)]),
    [["checkout", "Checking out the PR head: the analysis starts once it is there…", true], ["run-security", "Security review is running…", true]]);
  assert.deepEqual(stateHints({ checkout: { error: "no such ref" }, pendingRun: true }).map((h) => [h.text, Boolean(h.error)]), [["Could not check out the PR head: no such ref", true]]);
  assert.deepEqual(stateHints({ pendingRun: true }).map((h) => h.key), ["wait"]);
  assert.deepEqual(stateHints({}), []);
  // A note about an action: an error stays (no ttl), anything else goes after NOTE_TTL.
  const { noteRule, NOTE_TTL } = await import("./views.js");
  for (const e of ["Could not verify: no checkout", "Not posted: GitHub takes line comments only on lines of the PR diff.", "Nothing to send: add a comment first",
    "Select a line first (click its number; shift-click: a range)", "No loan_id on a.py:3", "Line 4 of a.py is not in the shown diff", "Opened it, but Could not save"])
    assert.deepEqual(noteRule(e), { error: true, ttl: null }, e);
  for (const ok of ["Posted to GitHub: https://x", "Dismissed \"x\" (Analysis). It stays in the Findings tab under Dismissed", "Dry run: nothing posted, the payload is in ~/x",
    "No fix to verify yet: no fix agent has reported a commit", "Marked done: it leaves the open reviews"])
    assert.deepEqual(noteRule(ok), { error: false, ttl: NOTE_TTL }, ok);
}
// ---- a finding's facts, its card's line, the rows' heights, the sequence diagram (the diff and a layer's head)
import { factRows, findingAnchor, wrapCount, seqLayout, IMPACT, SEVERITY_SCALE, SEQ, textWidth } from "./views.js";

// An open card says why the finding has its severity, what it does, how sure the claim is and what it depends on.
assert.deepEqual(factRows({ severity: "high", impact: "unauthorized_access", effect: "Anyone can call /late.", certainty: "assumed", preconditions: ["TOKEN is not set", "no authorizer"] }), [
  ["Severity", "high, because it allows access without permission."], ["Effect", "Anyone can call /late."],
  ["Certainty", "Assumed: it depends on something that could not be checked."], ["Preconditions", "TOKEN is not set; no authorizer"]]);
// No preconditions means it always happens; a finding from an older analysis has no such fields and gets no rows.
assert.deepEqual(factRows({ severity: "medium", effect: "Two mails.", certainty: "derived", preconditions: [] }).at(-1), ["Preconditions", "None: it always happens."]);
assert.deepEqual(factRows({ severity: "high", title: "x", detail: "y", preconditions: [] }), []);
assert.deepEqual(factRows(null), []);
// Reach: how sure the way from outside is, apart from the flaw (C2 D2: the card said only "Certainty: Derived").
const tok = factRows({ severity: "high", impact: "unauthorized_access", certainty: "derived", preconditions: [], path_certainty: "assumed",
  path_why: "assumed: depends on the HTTP API passing `Authorization: Bearer ` through." });
assert.deepEqual(tok.find(([k]) => k === "Reach"), ["Reach", "Assumed: Depends on the HTTP API passing `Authorization: Bearer ` through."]);
assert.deepEqual(factRows({ severity: "low", impact: "untested", path_certainty: "derived" }).find(([k]) => k === "Reach"), ["Reach", "Derived: it follows from the code that was read."]);
// The scale names every impact under the severity it fixes.
assert.equal(SEVERITY_SCALE.split("\n").length, 3);
for (const [sev, why] of Object.values(IMPACT)) assert.ok(SEVERITY_SCALE.split("\n").find((l) => l.startsWith(`${sev}:`)).includes(why));

// A card sits under the first line with code from the finding's line on: not under an empty one.
const fr = [{ kind: " ", number: 7, text: "import os" }, { kind: "+", number: 8, text: "" }, { kind: "-", number: 8, text: "old" }, { kind: " ", number: 9, text: "TOKEN = 1" }, { kind: "gap" }, { kind: "+", number: 30, text: "x" }];
assert.equal(findingAnchor(fr, 8, 8), 9);
assert.equal(findingAnchor(fr, 8, 16), 9);
assert.equal(findingAnchor(fr, 7, 9), 7);
assert.equal(findingAnchor(fr, 10, 10), 10); // the next code is far below: it stays on its own line
assert.equal(findingAnchor([], 3), 3);
// Not into the next function (reminders.py:35 on PR #2 is a blank line before `def overdue`): it stays on its line.
const fn = [{ kind: " ", number: 34, text: "    return len(late)" }, { kind: " ", number: 35, text: "" }, { kind: " ", number: 36, text: "" }, { kind: " ", number: 37, text: "def overdue(loans, on=None):" }];
assert.deepEqual([findingAnchor(fn, 35), findingAnchor(fn, 37), findingAnchor([{ kind: "+", number: 5, text: "export async function f() {" }], 4)], [35, 37, 4]);
// Nor out of a YAML block (template.yaml:9 is a blank line after `Timeout: 10`, before `Resources:`).
const ym = [{ kind: " ", number: 8, text: "    Timeout: 10" }, { kind: " ", number: 9, text: "" }, { kind: " ", number: 10, text: "Resources:" }];
assert.deepEqual([findingAnchor(ym, 9), findingAnchor([{ kind: " ", number: 7, text: "import os" }, ...ym.slice(1)], 9)], [9, 10]);

// Lines of a wrapped text: at words, a long word inside, a newline always.
assert.equal(wrapCount("", 300), 1);
assert.equal(wrapCount("one two", 300), 1);
assert.equal(wrapCount("a\nb", 300), 2);
assert.equal(wrapCount("word ".repeat(40).trim(), 300), Math.ceil(40 / Math.floor((300 + 4.16) / (4 * 7.3 * 1.04 + 4.16)))); // 9 words a line
assert.ok(wrapCount("x".repeat(200), 300) >= 5);
assert.ok(wrapCount("FRONT_DESK_TOKEN ".repeat(10), 400) > wrapCount("front desk token ".repeat(10), 400)); // capitals are wider
assert.ok(wrapCount("some text that wraps", 100, 13.5) >= wrapCount("some text that wraps", 100, 10));

// A sequence diagram: a column per participant, a row per call in order, from the caller's lifeline to the callee's.
const sq = seqLayout({ nodes: [{ id: "a", label: "Client" }, { id: "b", label: "Handler" }, { id: "c", label: "Store" }],
  edges: [{ from: "a", to: "b", label: "GET /late" }, { from: "b", to: "c", event: "late", action: "reads" }, { from: "b", to: "b", label: "check" }, { from: "c", to: "a", label: "200" }, { from: "a", to: "zz", label: "nowhere" }] }, 900);
assert.deepEqual(sq.cols.map((c) => c.x), [150, 450, 750]); // 900 px for three: the picture spreads over its room
assert.equal(sq.width, 900);
assert.deepEqual(sq.calls.map((c) => [c.n, c.x1, c.x2, c.text]), [[1, 150, 450, "GET /late"], [2, 450, 750, "late / reads"], [3, 450, 450, "check"], [4, 750, 150, "200"]]);
assert.equal(seqLayout({ nodes: [{ id: "a" }, { id: "b" }] }, 5000).width, 2 * SEQ.MAX); // and at most SEQ.MAX a column
assert.deepEqual(sq.calls.map((c) => c.y), [0, 1, 2, 3].map((k) => SEQ.HEAD + SEQ.PAD + k * SEQ.ROW));
assert.equal(sq.height, SEQ.HEAD + 2 * SEQ.PAD + 4 * SEQ.ROW);
assert.equal(seqLayout({ nodes: [{ id: "a" }, { id: "b" }] }, 100).width, 2 * SEQ.MIN); // never narrower than SEQ.MIN a column
assert.equal(seqLayout(null, 500).calls.length, 0);
// A synthetic sequence with many participants, a call to itself, calls back to the left and long texts (the
// owner's broken picture, rebuilt without its content): every call has a row with its number, its text ends inside
// the picture, a long participant name gets a second line, and the room decides whether it scrolls.
{
  const nodes = ["Reader", "Article action bar with a long component name", "Watchlist hook", "Account API", "List page", "Cache"].map((label, k) => ({ id: `p${k}`, label }));
  const E = (from, to, label) => ({ from: `p${from}`, to: `p${to}`, label });
  const v = { kind: "sequence", nodes, edges: [E(0, 1, "Click save while signed in"), E(1, 2, "mutate({ articleId, saved: true })"), E(2, 3, "POST /user/me/watchlist (optimistic update first)"),
    E(0, 4, "GET /list -> server shell"), E(4, 3, "GET /user/me/watchlist"), E(5, 5, "check the session and the consent of the reader"), E(4, 0, "Remove -> undo note"),
    E(5, 2, "after 5 s: mutate({ saved: false })"), E(2, 3, "DELETE /user/me/watchlist/:id")] };
  const wide = seqLayout(v, 1500), narrow = seqLayout(v, 600);
  assert.deepEqual([wide.width, narrow.width], [1500, 6 * SEQ.MIN]); // 1500 px: no scroll; 600: six columns at SEQ.MIN, it scrolls
  for (const Q of [wide, narrow]) {
    assert.deepEqual(Q.calls.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7, 8, 9], "no call goes missing");
    assert.ok(Q.calls.every((c) => c.tx >= 4 && c.tx + Math.min(c.tw, textWidth(c.caption, 11.5) + 8) <= Q.width - 4), "every text ends inside the picture");
    assert.equal(Q.head, SEQ.HEAD2, "the long name goes on a second line");
  }
  const self = wide.calls[5], back = wide.calls[6];
  assert.deepEqual([self.x1 === self.x2, self.caption.startsWith("6. "), back.x2 < back.x1], [true, true, true]);
  // The call to itself on the last column: its text goes left of the lifeline, never over its loop (x1 .. x1 + 22).
  for (const Q of [wide, narrow]) { const c = Q.calls[5]; assert.ok(c.tx + c.tw <= c.x1 - 6 && c.tx >= 4, `${c.tx} ${c.tw} ${c.x1}`); }
  assert.equal(seqLayout({ nodes: nodes.slice(0, 2).map((n) => ({ ...n, label: "A" })), edges: [] }, 600).head, SEQ.HEAD);
}

// The gutter marks of a finding's lines go over the rows that are shown: a range to line 1e9 (a model wrote it) marks
// three rows and allocates nothing; a range that is no range marks nothing.
import { rangeMarks } from "./views.js";
const mr = [{ kind: " ", number: 7 }, { kind: "-", number: 8 }, { kind: "+", number: 8 }, { kind: "gap" }, { kind: "+", number: 30 }];
assert.deepEqual([...rangeMarks(mr, [{ line: 8, end: 1e9, mark: "a" }, { line: 7, end: 7, mark: "b" }])], [[7, "b"], [8, "a"], [30, "a"]]);
assert.equal(rangeMarks(mr, [{ line: 7.5, end: 9, mark: "x" }, { line: 9, end: 7, mark: "x" }, { line: 7, end: Infinity, mark: "x" }, { line: "7", end: 8, mark: "x" }, { line: 7, end: undefined, mark: "x" }]).size, 0);

// The height of a Markdown text: paragraphs, a list and a fenced code block each count, with a gap between blocks.
import { mdHeight, MD } from "./views.js";
assert.equal(mdHeight("", 600), 21);
assert.equal(mdHeight("One line with `code`.", 600), 21);
assert.equal(mdHeight("One.\n\nTwo.\n\nThree.", 600), 3 * 21 + 2 * MD.GAP);
assert.equal(mdHeight("Do this:\n\n- one\n- two\n- three", 600, 20), 20 + MD.GAP + 3 * (20 + MD.ITEM_GAP));
assert.equal(mdHeight("Fix it.\n\n```python\na = 1\nb = 2\nc = 3\n```", 600), 21 + MD.GAP + MD.CODE_PAD + 3 * MD.CODE_LH);
assert.equal(mdHeight("```suggestion\nreturn 1\n```", 600), MD.CODE_PAD + MD.CODE_LH); // a GitHub suggestion is a code block
assert.equal(mdHeight("```\nopen to the end", 600), MD.CODE_PAD + MD.CODE_LH);
// A code line longer than the block wraps; a list item has less room than a paragraph; a heading is taller.
assert.ok(mdHeight("```\n" + "x".repeat(120) + "\n```", 300) >= MD.CODE_PAD + 4 * MD.CODE_LH);
const long = "word ".repeat(30).trim();
assert.ok(mdHeight(`- ${long}`, 300) >= mdHeight(long, 300));
assert.ok(mdHeight("# Title", 600) > mdHeight("Title", 600));
// It never gives less than the plain wrapped text does, so nothing that fit before is cut now.
for (const w of [200, 420, 900]) assert.ok(mdHeight(long, w) >= 21 * wrapCount(long, w));

// ---- the Security page: what each run checked, and a run in words
{
  const analysis = { checked: [{ area: "authentication", result: "finding", note: "empty token" }, { area: "secrets", result: "clean", note: "" }, { area: "tests", result: "weird" }] };
  const runs = { security: { state: "done", scope: { checked: [{ area: "secrets", result: "not_checked", note: "out of scope" }, { area: "dependencies", result: "clean", note: "none new" }] } },
    claude: { state: "done", scope: null }, codex: { state: "failed", error: "no output" } };
  const tab = scopeTable(analysis, runs);
  assert.deepEqual(tab.cols, ["analysis", "security"], "only runs that reported a scope get a column");
  assert.deepEqual(tab.rows.map((r) => r.area), ["authentication", "secrets", "tests", "dependencies"]);
  assert.deepEqual(tab.rows[1].cells, { analysis: { result: "clean", note: "" }, security: { result: "not_checked", note: "out of scope" } });
  assert.equal(tab.rows[0].cells.security, null, "an area a run does not cover is empty, not clean");
  assert.equal(tab.rows[2].cells.analysis.result, "not_checked", "an unknown result is never read as clean");
  assert.deepEqual(scopeTable(null, {}), { cols: [], rows: [] }); // an older analysis, nothing run
  assert.deepEqual(scopeTable(undefined, undefined), { cols: [], rows: [] });
  assert.equal(runSummary(null), "not run"); assert.equal(runSummary({ state: null }), "not run");
  assert.equal(runSummary({ state: "running" }), "running");
  assert.equal(runSummary({ state: "failed", error: "Codex review: no findings file" }), "failed: Codex review: no findings file");
  assert.equal(runSummary({ state: "done", count: 0 }), "no findings"); assert.equal(runSummary({ state: "done", count: 2 }), "2 findings");
  assert.equal(runSummary({ state: "done", count: 2 }, 1), "1 finding", "the count on the list now wins over the run's own");
}

// ---- the Security page: the attack surface from the access rows
{
  assert.equal(exposureOf({ public: true, auth: "none" }), "open"); assert.equal(exposureOf({ public: true, auth: "" }), "open");
  assert.equal(exposureOf({ public: true }), "open"); assert.equal(exposureOf({ public: true, auth: "None (no authorizer on the route)" }), "open");
  assert.equal(exposureOf({ public: true, auth: "bearer token checked in handler.py" }), "public");
  assert.equal(exposureOf({ public: true, auth: "nonce check in the handler" }), "public", "a word that only starts like none is a check");
  assert.equal(exposureOf({ public: false, auth: "none" }), "internal"); assert.equal(exposureOf(null), "internal");
  assert.equal(exposureOf({ public: true, auth: "nothing checks it", auth_kind: "code" }), "public", "auth_kind wins over the free text");
  assert.equal(exposureOf({ public: true, auth: "bearer token", auth_kind: "none" }), "open");
  const access = [{ resource: "role policy", kind: "queue", public: false, auth: "IAM" }, { resource: "admin route", kind: "route", public: false, auth: "IAM" },
    { resource: "api", kind: "route", public: true, auth: "an authorizer" }, { resource: "bucket", kind: "bucket", public: true, auth: "none" }];
  const s = surfaceOf(access);
  assert.deepEqual(s.entries.map((x) => [x.resource, x.exposure, x.k]), [["bucket", "open", 3], ["api", "public", 2], ["admin route", "internal", 1]], "most exposed first; a public bucket is a way in");
  assert.deepEqual(s.grants.map((x) => x.resource), ["role policy"]);
  assert.deepEqual(surfaceOf(undefined), { entries: [], grants: [] });
}

// ---- the Security page: order of the findings, the way in the PR opens unasked, a zone's rights
{
  const { reachLevel, secOrder, extraWays, zoneRights, blastLine } = await import("./views.js");
  assert.equal(reachLevel({ reachability: "authenticated" }, [{ exposure: "open" }]), "authenticated", "the analysis' word wins");
  assert.equal(reachLevel({}, [{ exposure: "internal" }, { exposure: "public" }]), "authenticated", "derived: the most exposed way in");
  assert.equal(reachLevel({}, [{ exposure: "open" }]), "public"); assert.equal(reachLevel({ reachability: "moon" }), "unknown");
  assert.deepEqual(secOrder([{ f: { id: "t", severity: "high", impact: "unauthorized_access" }, level: "authenticated", crosses: true }]).map((r) => [r.level, r.why]),
    [["public", "Reachable from the internet, over a trust boundary, high severity."]], "the broken check itself: whoever reaches the check reaches it (C2 D2)");
  const f = (id, severity) => ({ id, severity });
  const o = secOrder([{ f: f("a", "high"), level: "internal_only", crosses: true }, { f: f("b", "low"), level: "public", crosses: false }, { f: f("c", "medium"), level: "public", crosses: true },
    { f: f("d", "high"), level: "public", crosses: true }, { f: f("e", "high"), level: "unknown", crosses: null }]);
  assert.deepEqual(o.map((r) => r.f.id), ["d", "c", "b", "a", "e"]);
  assert.equal(o[0].why, "Reachable from the internet, over a trust boundary, high severity.");
  assert.equal(o[4].why, "Not known from where it can be reached, high severity.", "no zones: nothing said about boundaries");
  // PR #2: the extra ask "/remind" sits in handler.py; the route's card is the handler. Two extras on one way, or one
  // extra on two ways: no match. A way in the PR does not open: no match.
  const route = { k: 0, opened_by_pr: true, files: ["template.yaml", "library/handler.py"] }, other = { k: 1, opened_by_pr: true, files: ["library/api.py"] };
  const x1 = { id: "x1", state: "extra", files: ["library/handler.py"] };
  assert.deepEqual(extraWays([{ id: "c1", state: "broken", files: ["library/handler.py"] }, x1], [route, other]).map((m) => [m.entry.k, m.ask.id]), [[0, "x1"]]);
  assert.deepEqual(extraWays([x1, { id: "x2", state: "extra", files: ["template.yaml"] }], [route]), []);
  assert.deepEqual(extraWays([{ ...x1, files: ["library/handler.py", "library/api.py"] }], [route, other]), []);
  assert.deepEqual(extraWays([x1], [{ ...route, opened_by_pr: false }]), []); assert.deepEqual(extraWays(undefined, undefined), []);
  const zones = [{ id: "z_net", name: "Internet", trust: "public" }, { id: "z_fd", name: "FrontDesk function", trust: "authenticated" }, { id: "z_c", name: "Consumer", trust: "internal" }];
  const nodes = [{ id: "caller", zone: "z_net" }, { id: "handler", label: "handler", zone: "z_fd" }, { id: "consumer", zone: "z_c" }];
  const access = [{ resource: "LoanEvents", principal: "FrontDesk function", actions: ["sqs:SendMessage"], used: false }, { resource: "Loans", principal: "Consumer", actions: ["sqs:ReceiveMessage"], used: true }];
  const zr = zoneRights(zones, nodes, [{ node: "handler" }], access);
  assert.deepEqual(zr.map((z) => [z.zone.id, z.rights.map((r) => r.resource)]), [["z_fd", ["LoanEvents"]]], "only zones with a way in");
  assert.equal(blastLine(zr[0]), "If FrontDesk function is compromised, it can sqs:SendMessage on LoanEvents (granted, never used).");
  assert.equal(blastLine({ zone: zones[2], rights: [] }), "If Consumer is compromised, it holds no right the analysis names.");
  assert.deepEqual(zoneRights([], nodes, [{ node: "handler" }], access), []);
}

// ---- old and new side by side: which rows stand next to each other
import { pairRows } from "./views.js";
const kinds = (s) => [...s].map((c) => ({ kind: c === "g" ? "gap" : c === "n" ? "" : c }));
const pairs = (s) => pairRows(kinds(s)).map((p) => (p.full !== undefined ? `=${p.full}` : `${p.l ?? "_"}|${p.r ?? "_"}`)).join(" ");
assert.equal(pairs("@  "), "=0 1|1 2|2", "context: the same line on both sides");
assert.equal(pairs("@ -+ "), "=0 1|1 2|3 4|4", "changed: the removed line beside the added one");
assert.equal(pairs("++"), "_|0 _|1", "added only: nothing on the left");
assert.equal(pairs("-- "), "0|_ 1|_ 2|2", "removed only: nothing on the right");
assert.equal(pairs("---+"), "0|3 1|_ 2|_", "more removed than added: the rest has nothing beside it");
assert.equal(pairs("-+++ "), "0|1 _|2 _|3 4|4", "more added than removed");
assert.equal(pairs(" -+ -+"), "0|0 1|2 3|3 4|5", "two blocks with a line between them pair on their own");
assert.equal(pairs("-+-+"), "0|1 2|3", "blocks written one after the other pair one by one");
assert.equal(pairs("+-"), "_|0 1|_", "an added line before a removed one is not its change");
assert.equal(pairs(" g @-+n"), "0|0 =1 2|2 =3 4|5 =6", "a gap that still hides lines, a hunk header and a note take the whole width");
assert.equal(pairs(""), "");

// ---- long code lines wrap
import { wrapCode, wrapHeight, codeCols, sliceSpans } from "./views.js";
assert.deepEqual(wrapCode("short", 80), [0], "a line that fits does not break");
assert.deepEqual(wrapCode("x".repeat(80), 80), [0], "exactly the width: one line");
assert.deepEqual(wrapCode("x".repeat(25), 10), [0, 10, 20], "no place to break: at the width exactly");
assert.deepEqual(wrapCode("aaaaaaaa bbbbbbbbbbbbbbbbbbbb", 12), [0, 9, 21], "after the last space in the line's last third");
assert.deepEqual(wrapCode("call(firstarg,second)", 16), [0, 14], "after a comma");
assert.deepEqual(wrapCode("a bbbbbbbbbbbbbbbbbbbbbbb", 12), [0, 12, 24], "a space early in the line does not make a short line");
assert.equal(wrapCode("x".repeat(1000), 10, 5).length, 5, "at most max visual lines");
assert.deepEqual(wrapCode("", 80), [0]);
assert.equal(wrapHeight([0], 22), 22);
assert.equal(wrapHeight([0, 40, 80], 22), 66, "three visual lines, three rows high");
assert.equal(codeCols(122 + 12 + 780, 122, 7.8), 100);
assert.equal(codeCols(10, 122, 7.8), 8, "never below 8 columns");
const sp = [{ start: 0, end: 5, kind: "kw" }, { start: 6, end: 14, kind: "fn", ref: true }, { start: 20, end: 22, kind: "str" }];
assert.deepEqual(sliceSpans(sp, 0, 10), [{ start: 0, end: 5, kind: "kw" }, { start: 6, end: 10, kind: "fn", ref: true }], "a span over the break is split");
assert.deepEqual(sliceSpans(sp, 10, 20), [{ start: 0, end: 4, kind: "fn", ref: true }], "its second half starts the next line");
assert.deepEqual(sliceSpans(sp, 14, 20), [], "nothing between spans");

// ---- side by side: which half a press hit
import { pairSide } from "./views.js";
assert.deepEqual(pairSide(100, 1000, 3, 4), { side: "l", ri: 3, x: 100, w: 500 });
assert.deepEqual(pairSide(600, 1000, 3, 4), { side: "r", ri: 4, x: 100, w: 500 }, "x from the right half's left edge");
assert.deepEqual(pairSide(500, 1000, null, 4), { side: "r", ri: 4, x: 0, w: 500 }, "the middle belongs to the right half");
assert.equal(pairSide(10, 1000, null, 4).ri, null, "an empty left half: no row");
import { diffModeOf, HALF_GUTTER, codeCols as cc } from "./views.js";
const wide = 2 * (HALF_GUTTER + 12 + 80 * 7.8);
assert.equal(diffModeOf(null, wide, 7.8), "split", "two halves of 80 columns fit: side by side");
assert.equal(cc(wide / 2, HALF_GUTTER, 7.8), 80);
assert.equal(diffModeOf(null, wide - 20, 7.8), "unified", "a little narrower: one column");
assert.equal(diffModeOf("unified", wide * 2, 7.8), "unified", "the person's choice goes first");
assert.equal(diffModeOf("split", 400, 7.8), "split");
assert.equal(diffModeOf("bogus", 400, 7.8), "unified");
import { oneSided } from "./views.js";
const rowsOf = (s) => [{ kind: "@" }, ...[...s].map((kind) => ({ kind }))];
assert.equal(oneSided(rowsOf("+++")), true, "a new file");
assert.equal(oneSided(rowsOf("--")), true, "a deleted file");
assert.equal(oneSided(rowsOf(" ++")), false, "context: a changed file");
assert.equal(oneSided(rowsOf("-+")), false, "a line changed");

// A card's tint over the background is one opaque colour, so the grid does not show through a card.
{
  const { solidOver } = await import("./views.js");
  {
    assert.equal(solidOver("#000000", "#ffffff80"), "#808080");
    assert.equal(solidOver("#101010", "#202020"), "#202020", "an opaque colour stays");
    assert.equal(solidOver("#000", "#fff"), "#ffffff");
    assert.equal(solidOver("rgb(0,0,0)", "#ffffff80"), "#ffffff80", "an unknown base: unchanged");
  }
}

// ---- the PR list: at most three marks, security first
import { rowMarks } from "./views.js";
assert.deepEqual(rowMarks({ top: "high", security: true }, { priority: 1, type: "Feature", chips: ["High security risk", "Feature", "Low effort"] }).map((m) => m.text), ["⛨ high", "P1", "Feature"]);
assert.deepEqual(rowMarks({ top: "medium", security: false }, null).map((m) => [m.text, m.security]), [["medium", false]]);
assert.deepEqual(rowMarks(null, { priority: 3, type: "Docs" }).map((m) => m.text), ["P3", "Docs"]);
assert.equal(rowMarks({ top: "low" }, { priority: 2, type: "Fix" }).length, 3);

// ---- the stack in the review's bar
import { stackOf } from "./views.js";
assert.deepEqual(stackOf({ stacked_on: { number: 1, url: "u1" } }, 2).map((p) => [p.number, Boolean(p.self)]), [[1, false], [2, true]], "PR #2 on top of #1");
assert.deepEqual(stackOf({ stacked_above: [{ number: 2, url: "u2" }] }, 1).map((p) => [p.number, Boolean(p.self)]), [[1, true], [2, false]], "PR #1 under #2");
assert.equal(stackOf({ stacked_on: null, stacked_above: [] }, 3), null);
assert.equal(stackOf(null, 3), null, "no context yet");

// ---- a layer's "Depends on" chips: clicks placed by x from the right end
import { chipAt, textW } from "./views.js";
assert.equal(chipAt(950, 1000, [80, 100]), 1, "the last chip ends at the right end");
assert.equal(chipAt(850, 1000, [80, 100]), 0, "the one before it, a gap to the left");
assert.equal(chipAt(897, 1000, [80, 100]), -1, "the gap between them");
assert.equal(chipAt(700, 1000, [80, 100]), -1);
assert.ok(textW("Loan status model", 12.5) > textW("Model", 12.5));

// ---- the findings behind an area's "Finding" in "What each run checked"
{
  const { areaFindings } = await import("./views.js");
  const src = (k) => [{ reviewer: k }];
  const list = [{ id: "t", title: "Front desk token defaults to empty", category: "security", sources: src("security") },
    { id: "q", title: "Queue.publish never sends to SQS", category: "bug", sources: src("security") },
    { id: "m", title: "Reminder mailed twice", category: "bug", sources: src("claude") },
    { id: "n", title: "New behavior is untested", category: "test", sources: src("claude") }];
  assert.deepEqual(areaFindings("authentication", "security", list).map((f) => f.id), ["t"]);
  assert.deepEqual(areaFindings("authentication", "claude", list), [], "only that run's findings");
  assert.deepEqual(areaFindings("correctness", "claude", list).map((f) => f.id), ["m"]);
  assert.deepEqual(areaFindings("concurrency", "claude", list).map((f) => f.id), ["m"]);
  assert.deepEqual(areaFindings("tests", "claude", list).map((f) => f.id), ["n"]);
  assert.deepEqual(areaFindings("dependencies", "security", list), []);
}

// ---- findings at a state diagram's transitions
{
  const { transitionMarks } = await import("./views.js");
  const v = { kind: "state_machine", nodes: [{ id: "a" }, { id: "b" }], transitions: [{ from: "a", to: "b", evidence: "library/status.py:14" }, { from: "b", to: "a", at: "status.py:29-31" }, { from: "b", to: "b" }] };
  const f = (id, file, line, severity, end) => ({ id, file, line, end, severity });
  const m = transitionMarks(v, [f("x", "library/status.py", 14, "medium"), f("y", "library/status.py", 30, "low"), f("z", "library/status.py", 28, "high", 29), f("w", "library/loans.py", 14, "high")]);
  assert.deepEqual([...m].map(([i, x]) => [i, x.findings.map((g) => g.id), x.severity]), [[0, ["x"], "medium"], [1, ["y", "z"], "high"]]);
  assert.equal(transitionMarks(v, []).size, 0); assert.equal(transitionMarks(null, null).size, 0);
}

// ---- a way in whose check an open finding can pass
{
  const { exposureNow, surfaceOf, EXPOSURE } = await import("./views.js");
  const api = { exposure: "public" };
  assert.equal(exposureNow(api, [{ impact: "unauthorized_access" }]), "failopen"); assert.equal(EXPOSURE.failopen, "Auth, can fail open");
  assert.equal(exposureNow(api, [{ impact: "data_loss" }]), "public"); assert.equal(exposureNow(api), "public");
  assert.equal(exposureNow({ exposure: "open" }, [{ impact: "unauthorized_access" }]), "open", "nothing checks it anyway");
  assert.equal(exposureNow({ exposure: "internal" }, [{ impact: "unauthorized_access" }]), "internal");
  assert.deepEqual(surfaceOf([{ resource: "a", public: true, auth: "token" }, { resource: "b", public: true, auth: "none" }]).entries.map((x) => x.resource), ["b", "a"], "the order is unchanged");
}

// ---- contradictions in "What each run checked"
{
  const { scopeConflicts, scopeTable } = await import("./views.js");
  const tab = scopeTable({ checked: [{ area: "personal_data", result: "clean" }, { area: "authentication", result: "finding" }] },
    { security: { scope: { checked: [{ area: "authentication", result: "clean" }, { area: "secrets", result: "clean" }] } } });
  const c = scopeConflicts(tab, [{ title: "Token fails open", security: true, effect: "Anyone can list members' names and books." }, { title: "Mailed twice", effect: "Members get two mails." }]);
  assert.deepEqual([...c.keys()], ["personal_data", "authentication"]);
  assert.equal(c.get("authentication").kind, "cross"); assert.equal(c.get("personal_data").kind, "effect");
  assert.match(c.get("personal_data").text, /Token fails open/);
  assert.equal(scopeConflicts(tab, []).size, 1, "without findings only the runs' own contradiction");
  assert.equal(scopeConflicts(null).size, 0);
}
// ---- the zone a card is really reachable from
{
  const { effectiveZones } = await import("./views.js");
  const arch = { zones: [{ id: "z1", trust: "public" }, { id: "z2", name: "Front desk", trust: "authenticated" }, { id: "z3", trust: "internal" }], nodes: [{ id: "h", zone: "z2" }, { id: "g", zone: "z3" }, { id: "p", zone: "z1" }] };
  const e = effectiveZones(arch, [{ public: true, auth: "bearer token checked in handler.py", auth_kind: "code", node: "h" }, { public: true, auth_kind: "gateway", node: "g" }, { public: true, auth: "none", node: "p" }]);
  assert.deepEqual([...e.keys()], ["h"], "a check in the card's own code; a gateway check or a public card is no deviation");
  assert.deepEqual([e.get("h").trust, e.get("h").drawn], ["public", "authenticated"]);
  assert.equal(effectiveZones(arch, [{ public: true, auth: "none", node: "g" }]).get("g").why, "nothing checks the caller before it");
  assert.equal(effectiveZones(arch, [{ public: false, auth_kind: "code", node: "h" }]).size, 0); assert.equal(effectiveZones(null, null).size, 0);
}

// ---- the Security page as a boundary map: crossings and the sentence over it (panel check, wave 5)
{
  const { crossingsOf, crossingChanged, secSentence, inProcess } = await import("./views.js");
  // PR #2 in small: a public route into the front desk, the front desk's right on the queue, the route calling the
  // consumer in-process, the consumer reading the store, a bug on that call.
  const arch = { zones: [{ id: "z1", name: "Internet / API", trust: "public" }, { id: "z2", name: "Lambdas", trust: "internal" }, { id: "z3", name: "Store", trust: "data" }],
    groups: [{ id: "g_fd", label: "Front desk Lambda" }, { id: "g_lib", label: "Shared library" }, { id: "g_c", label: "Consumer Lambda" }, { id: "g_aws", label: "AWS" }],
    nodes: [{ id: "fd", label: "handler", group: "g_fd", zone: "z1" }, { id: "c", label: "consumer", group: "g_c", zone: "z2" }, { id: "q", label: "queue", group: "g_aws", zone: "z2" },
      { id: "st", label: "store", group: "g_lib", zone: "z3" }, { id: "m", label: "mailer", group: "g_lib", zone: "z2", runs_in: "c" }],
    edges: [{ from: "fd", to: "c", label: "POST /remind calls consumer.handle in-process", crosses: true, status: "new" }, { from: "q", to: "c", label: "SQS event source" },
      { from: "c", to: "st", crosses: true, status: "new" }, { from: "c", to: "m", label: "mailer.send" }] };
  const access = [{ id: "acc1", resource: "Api", public: true, principal: "anyone on the internet", auth: "bearer token", node: "fd", change: "added" },
    { id: "acc2", resource: "Send policy", public: false, principal: "FrontDesk function", actions: ["sqs:SendMessage"], node: "q", change: "added", used: false }];
  const gates = [{ where: { access: "acc1" }, principal: "bearer token holder", check: "token", source: "code", at: "handler.py:16", holds_if: "FRONT_DESK_TOKEN is set", carries: ["body.id"] }];
  const threats = [{ id: "t1", where: { access: "acc1" }, result: "finding", findings: ["tok"], goal: "mail any member", path: ["fd", "c", "m"] },
    { id: "t3", where: { access: "acc2" }, result: "not_assessed", derived: true, threat: "No threat was named for this crossing." }];
  const findings = [{ id: "tok", ids: ["tok"], security: true, severity: "high", impact: "unauthorized_access", title: "Token never set", reachable_from: ["acc2"] },
    { id: "bug", ids: ["bug"], security: false, severity: "high", title: "Store is in memory", breaks: { edge: "e2" } }];
  const rows = crossingsOf({ arch, access, threats, gates, findings });
  assert.deepEqual(rows.map((r) => [r.kind, r.from.name, r.to.name, r.identity, r.result]), [
    ["entry", "anyone on the internet", "Internet / API", "anyone on the internet", "finding"],
    ["right", "Internet / API", "Lambdas", "FrontDesk function", "not_assessed"],
    ["bypass", "Internet / API", "Lambdas", "Front desk Lambda", "not_assessed"],
    ["call", "Lambdas", "Store", "Consumer Lambda", "not_assessed"],
    ["operator", "Operator (deploy)", "Internet / API", "whoever deploys", "not_assessed"]],
    "who arrives is the access row's principal; a bug on a call is no assessment; an in-process call bypasses the consumer's boundary; a secret in a condition is an operator's way");
  assert.deepEqual([rows[0].expects, rows[0].findings.map((f) => f.id), rows[0].path, rows[0].goal], ["bearer token holder", ["tok"], ["fd", "c", "m"], "mail any member"]);
  assert.deepEqual([rows[1].ends.from, rows[1].unmapped, rows[1].unused, rows[1].findings], ["fd", false, true, []], "the right's principal is the front desk's frame: its first card, no ghost card");
  assert.deepEqual(rows[0].conflicts.map((c) => [c.f.id, c.finding, c.threat]), [["tok", ["acc2"], ["acc1"]]], "the finding says acc2, its threat acc1: marked, the outer one counts");
  assert.deepEqual([rows[1].reason, rows[3].reason], ["No threat was named for this crossing.", "No threat names this crossing."]);
  assert.equal(crossingsOf({ arch, access: [{ ...access[1], principal: "Somebody else" }] })[0].unmapped, true);
  assert.deepEqual([inProcess({ label: "calls x in-process" }), inProcess({ label: "SQS event source" }), inProcess({ label: "imports x", in_process: false })], [true, false, false]);
  assert.ok(rows.every(crossingChanged));
  assert.equal(secSentence(rows, 1), "The way in is Api, open to anyone on the internet; its check (token, in the code) holds only if FRONT_DESK_TOKEN is set, and an unresolved high finding says it does not: Token never set. Behind it: mail any member. It also adds or changes 1 right into another zone, 1 call over a trust boundary, 1 call that bypasses a boundary and 1 operator way. 1 of 5 crossings is assessed, 4 not assessed. 1 security finding is unresolved.");
  assert.equal(secSentence([], 0), "This PR opens no way in from the public side that the data names. No security finding is unresolved.");
  assert.deepEqual(crossingsOf({}), []);
  // The run's bypasses decide which call in one process is a row; its reach_conflict is shown in its own words.
  const byRun = crossingsOf({ arch, access, threats, gates, findings, bypasses: [{ edge: "e3" }] });
  assert.deepEqual(byRun.filter((r) => r.kind === "bypass").map((r) => r.key), [], "e0 is not in the run's list, e3 is no call in one process");
  const rc = crossingsOf({ arch, access, threats: [{ where: { access: "acc1" }, result: "finding", findings: ["tok"] }], gates, findings: [{ ...findings[0], reachable_from: ["acc1"], reach_conflict: { finding: { reachable_from: ["acc2"] }, threat: { id: "t1", where: { access: "acc1" } } } }] });
  assert.deepEqual(rc[0].conflicts.map((c) => [c.finding, c.threat]), [[["acc2"], ["acc1"]]]);
  const op = crossingsOf({ arch, access: [{ id: "acc4", principal: "operator", principal_kind: "operator", derived: true, value_from: null, node: "fd", resource: "FRONT_DESK_TOKEN" }] });
  assert.ok(crossingChanged({ kind: "operator", derived: true, change: "unchanged" }), "a derived operator way shows with its gate");
  assert.deepEqual(op.filter((r) => r.kind === "operator").map((r) => [r.kind, r.valueFrom, r.derived]), [["operator", null, true]], "the run's operator way, no derived one beside it");
  // A caller from outside drawn as a card: its call to the way in is that way in's row, not a second one.
  const ext = { ...arch, nodes: [...arch.nodes, { id: "cl", type: "external", zone: "z0" }], zones: [...arch.zones, { id: "z0", name: "Clients", trust: "public" }], edges: [...arch.edges, { from: "cl", to: "fd", crosses: true }] };
  assert.equal(crossingsOf({ arch: ext, access, threats, gates, findings }).filter((r) => r.ends.from === "cl").length, 0);
}

// ---- the security run's gates and effective zones
{
  const { crossingsOf, effectiveFrom } = await import("./views.js");
  const arch = { zones: [{ id: "z1", name: "Internet", trust: "public" }, { id: "z2", name: "Front desk", trust: "authenticated" }, { id: "z3", name: "Store", trust: "data" }],
    nodes: [{ id: "fd", zone: "z2" }, { id: "st", zone: "z3" }], edges: [{ from: "fd", to: "st", crosses: true }] };
  const rows = crossingsOf({ arch, access: [{ id: "acc1", public: true, principal: "anyone", auth: "bearer token", node: "fd", change: "added" }],
    gates: [{ where: { access: "acc1" }, check: "token", source: "code", at: "library/handler.py:16", holds_if: "TOKEN is set", carries: ["body.id"] }, { where: { from: "fd", to: "st", edge: "e0" }, check: "iam", source: "config" }],
    threats: [{ where: { edge: "e0" }, result: "not_assessed", derived: true, threat: "No threat was named for this crossing." }] });
  assert.deepEqual(rows.map((r) => [r.check, r.at, r.holds_if, r.result, r.threats.length]), [["token, in the code", "library/handler.py:16", "TOKEN is set", "not_assessed", 0], ["iam, in the config", null, null, "not_assessed", 0]]);
  assert.deepEqual(rows[0].carries, ["body.id"]);
  const e = effectiveFrom([{ node: "fd", drawn: "authenticated", effective: "public", where: "library/handler.py:16" }, { node: "st", drawn: "data", effective: "data" }], arch);
  assert.deepEqual([...e.keys()], ["fd"]); assert.equal(e.get("fd").why, "its first check is at library/handler.py:16"); assert.equal(effectiveFrom(null, arch).size, 0);
}

// ---- the architecture map with the boundary as it really runs
{
  const { mapArch } = await import("./views.js");
  const arch = { groups: [{ id: "g_fd", label: "Front desk Lambda" }, { id: "g_lib", label: "Shared library code" }, { id: "g_c", label: "Consumer Lambda" }, { id: "g_aws", label: "AWS" }],
    nodes: [{ id: "fd", group: "g_fd", zone: "z1" }, { id: "m", group: "g_lib", zone: "z2" }, { id: "st", group: "g_lib", zone: "z2", runs_in: "fd" }, { id: "c", group: "g_c", zone: "z2" }, { id: "q", group: "g_aws", zone: "z2" }],
    edges: [{ from: "fd", to: "c", label: "calls consumer.handle in-process", crosses: true }, { from: "q", to: "c", label: "SQS" }, { from: "c", to: "m", label: "send" }] };
  const m = mapArch(arch, [{ public: true, principal: "anyone on the internet", node: "fd", resource: "Api", change: "added" }, { public: false, node: "q" }]);
  assert.deepEqual(m.nodes.map((n) => [n.id, n.zone ?? null]), [["\0in", null], ["fd", "z1"], ["m", null], ["st", "z1"], ["c", "z2"], ["q", "z2"]], "shared code has no zone of its own; with runs_in it takes that zone");
  assert.deepEqual(m.edges.map((e) => [e.from, e.to, Boolean(e.crosses), Boolean(e.bypass)]), [["fd", "c", false, true], ["q", "c", false, false], ["c", "m", false, false], ["\0in", "fd", true, false]]);
  assert.equal(m.nodes[0].description, "anyone on the internet"); assert.equal(m.groups[0].id, "\0outside"); assert.equal(m.edges[3].status, "new");
  assert.equal(mapArch(arch, []).nodes.length, arch.nodes.length, "no public way in: no Internet card"); assert.equal(mapArch(null), null);
  // runs_in may name a frame (a deployment); an analysis that draws its own caller from outside gets no second one.
  const own = { ...arch, nodes: [...arch.nodes.map((n) => (n.id === "m" ? { ...n, runs_in: "g_fd" } : n)), { id: "cl", type: "external", group: "g_x" }], edges: [...arch.edges, { from: "cl", to: "fd" }] };
  const m2 = mapArch(own, [{ public: true, node: "fd" }]);
  assert.deepEqual([m2.nodes.find((n) => n.id === "m").zone, m2.nodes.some((n) => n.id === "\0in")], ["z1", false]);
}

// ---- the Resilience page's helpers
{
  const { resStartOf, resOrder, resPicture, budgetBar } = await import("./views.js");
  const arch = { groups: [{ id: "g_fd", label: "Front desk Lambda" }, { id: "g_rc", label: "Reminder consumer Lambda" }, { id: "g_aws", label: "AWS" }],
    nodes: [{ id: "handler", group: "g_fd", type: "component", label: "handler" }, { id: "queue", group: "g_aws", type: "data", label: "LoanEvents (SQS)", status: "new" }, { id: "consumer", group: "g_rc", label: "consumer (consumer.py)" }] };
  const s = resStartOf(arch, [{ public: true, node: "handler" }]);
  assert.equal(s.text, "This PR adds or changes 1 queue, 2 functions and 1 public way in: the run starts there.");
  assert.deepEqual(s.nodes.sort(), ["consumer", "handler", "queue"]);
  assert.match(resStartOf({ nodes: [] }).text, /names no queue/);
  assert.deepEqual(resOrder([{ id: "a", result: "mitigated" }, { id: "b", result: "finding" }, { id: "c", result: "finding", blocker: { reason: "x" } }, { id: "d", result: "not_assessed" }]).map((p) => p.id), ["c", "b", "d", "a"]);
  assert.equal(resPicture({ kind: "retry", ladder: [{}], budget: {} }), "ladder"); assert.equal(resPicture({ kind: "timeout", budget: { value_s: 1, limit_s: 2 } }), "budget");
  assert.equal(resPicture({ kind: "state", writers: [{ kind: "W" }] }), null, "one writer: no matrix"); assert.equal(resPicture({ kind: "other", race: { steps: [[1]] } }), "race");
  assert.deepEqual(budgetBar({ value_s: 70, limit_s: 10 }, 308), { value: 280, limit: 40, over: 240, overS: 60 });
}

// ---- a path from R-D's derived shape reads like this view's own
{
  const { resPathView, resPicture } = await import("./views.js");
  const res = { races: [{ id: "r1", actors: ["A", "B"], steps: [["A", "reads"]], breaks_at: 0, findings: ["f2"] }], state: [{ id: "s1", what: "reminded_on", writers: [{ node: "rem", at: "r.py:23" }, { node: "con", at: "c.py:23", guard: "none" }], readers: [{ node: "h", at: "h.py:21" }] }] };
  const p = resPathView({ id: "p1", kind: "retry", steps: ["q", "con"], findings: ["f1"], ladder: { factors: [{ label: "batch of 10", n: 10, at: "t.yaml:37" }, { label: "until expiry", n: null, at: "t.yaml:11" }], text: "no limit until the message expires (4 days)" },
    blocker: { why: "load grows without a limit", at: "t.yaml:11" }, budget: { value_s: 70, limit_s: 10, over_s: 60, text: "up to 70 s" } }, res);
  assert.deepEqual(p.ladder.map((r) => [r.name, r.factor]), [["batch of 10", "×10"], ["until expiry", "no limit"]]);
  assert.deepEqual([p.product, p.blocker.reason, p.budget.note, p.state, p.writers.map((w) => w.kind).join("")], ["no limit until the message expires (4 days)", "load grows without a limit", "up to 70 s", "reminded_on", "WWR"]);
  assert.equal(resPathView({ id: "p5", kind: "race", findings: ["f2"], steps: [] }, res).race.id, "r1"); assert.equal(resPicture(resPathView({ id: "p9", kind: "other", steps: [], findings: [] }, res)), null);
  assert.equal(resPathView({ id: "x", ladder: [{ name: "a", factor: "3" }], blocker: { reason: "r" } }).blocker.reason, "r", "the view's own shape stays");
}

// ---- a path's places as cards, and its sentence
{
  const { resCardOf, resSentence } = await import("./views.js");
  const arch = { nodes: [{ id: "consumer", at: "library/consumer.py:11" }, { id: "mailer", at: "library/mailer.py:9" }, { id: "late", at: "library/consumer.py:40" }] };
  assert.deepEqual(["consumer", "library/consumer.py:19", "consumer.py:45", "library/mailer.py:3", "e6", "x.py:1"].map((s) => resCardOf(s, arch)), ["consumer", "consumer", "late", "mailer", null, null]);
  assert.equal(resCardOf("library/mailer.py:14", { nodes: [{ id: "m", label: "Mailer (mailer.py)" }, { id: "c", at: "library/consumer.py:1" }] }), "m", "a card without a place, by the file in its label");
  assert.equal(resSentence({ trigger: "Mailer exhausts retries", end: "The record is acked" }), "Mailer exhausts retries: the record is acked");
  assert.equal(resSentence({ trigger: "x", end: "SQS never sees it" }), "x: SQS never sees it");
  assert.equal(resSentence({ trigger: "x", end: "Lambda times out" }), "x: Lambda times out", "a name keeps its capital");
}

// ---- a path's marks on the map's cards
{
  const { resMarksOn } = await import("./views.js");
  const arch = { nodes: [{ id: "q", at: "template.yaml:11" }, { id: "c", at: "library/consumer.py:11" }], edges: [{ from: "q", to: "c" }] };
  const m = resMarksOn([{ at: "e0", mark: "no DLQ" }, { at: "e0", mark: "⏱ 10 s" }, { at: "library/consumer.py:19", mark: "✕ silent" }, { at: "x.py:1", mark: "×3" }, { node: "q", text: "batch 10" }], arch);
  assert.deepEqual([...m], [["q", "no DLQ · batch 10"], ["c", "⏱ 10 s · ✕ silent"]], "a queue's mark at the queue");
}

// ---- panel round 3: right and call folded, defects, operator, ways, zones passed on
{
  const { crossingsOf, wayOf, wayText, passZones, isDefect, secSentence } = await import("./views.js");
  const arch = { zones: [{ id: "z1", name: "Internet", trust: "public" }, { id: "z2", name: "Front desk", trust: "authenticated" }, { id: "z3", name: "Lambdas", trust: "internal" }, { id: "z4", name: "Queue", trust: "data" }],
    groups: [{ id: "g_ext", label: "Callers" }, { id: "g_fd", label: "Front desk Lambda" }, { id: "g_rc", label: "Consumer Lambda" }, { id: "g_aws", label: "AWS" }],
    nodes: [{ id: "client", type: "external", group: "g_ext", zone: "z1", label: "Front desk client" }, { id: "handler", group: "g_fd", zone: "z2", label: "handler" }, { id: "events", group: "g_fd", runs_in: "g_fd", zone: "z2", label: "events.py" },
      { id: "queue", group: "g_aws", zone: "z4", label: "LoanEvents" }, { id: "consumer", group: "g_rc", zone: "z3", label: "consumer" }, { id: "mailer", group: "g_rc", zone: "z3", label: "Mailer" }],
    edges: [{ from: "client", to: "handler", crosses: true }, { from: "handler", to: "consumer", in_process: true }, { from: "events", to: "queue", crosses: true }, { from: "queue", to: "consumer", crosses: true }, { from: "consumer", to: "mailer", in_process: true }] };
  const access = [{ id: "acc1", public: true, principal: "anyone on the internet", node: "handler", change: "added", resource: "Api" },
    { id: "acc2", principal: "FrontDesk function", principal_node: "g_fd", node: "queue", actions: ["sqs:SendMessage"], used: false, change: "added", resource: "Send policy" },
    { id: "acc3", principal: "Consumer", principal_node: "g_rc", node: "consumer", actions: ["sqs:ReceiveMessage"], change: "added", resource: "Trigger" },
    { id: "acc4", principal: "operator", principal_kind: "operator", derived: true, change: "unchanged", node: "handler", resource: "FRONT_DESK_TOKEN", actions: ["set FRONT_DESK_TOKEN"] }];
  const gates = [{ where: { access: "acc1" }, check: "token", source: "code", holds_if: "FRONT_DESK_TOKEN is set", carries: ["body.id"] }, { where: { edge: "e2" }, check: "iam", carries: ["LoanEvent"] }];
  const threats = [{ id: "t1", where: { access: "acc1" }, result: "finding", findings: ["tok"], path: ["client", "handler", "consumer", "mailer"] }, { id: "t4", where: { edge: "e2" }, result: "finding", goal: "Not an attacker goal" },
    { id: "t5", where: { access: "acc2" }, result: "not_assessed", derived: true }, { id: "t6", where: { access: "acc3" }, result: "finding", findings: [] }, { id: "t2", where: { edge: "e1" }, result: "finding", path: ["client", "handler", "consumer"] }];
  const findings = [{ id: "tok", ids: ["tok"], security: true, impact: "unauthorized_access", severity: "high", title: "Token never set", reachable_from: ["acc1"] },
    { id: "pol", ids: ["pol"], security: false, category: "security", severity: "low", title: "Policy unused", reachable_from: ["acc2"] }];
  const rows = crossingsOf({ arch, access, gates, threats, findings, bypasses: [{ edge: "e1" }] });
  assert.deepEqual(rows.map((r) => [r.kind, r.key, r.identity, r.result]), [["entry", "a:acc1", "anyone on the internet", "finding"], ["operator", "a:acc4", "operator", "finding"], ["bypass", "e:1", "Front desk Lambda", "finding"],
    ["right", "e:2", "FrontDesk function", "finding"], ["right", "e:3", "Consumer", "finding"]], "right and call on one boundary are one row; acc3 folds into the queue's call; the low security finding counts");
  assert.deepEqual([rows[1].change, rows[1].findings.map((f) => f.id)], ["added", ["tok"]], "the operator's way is new with its gate and names the finding it breaks");
  assert.deepEqual([rows[3].aliases, rows[3].carries, rows[3].threats.map((t) => t.id), rows[4].threats.map((t) => t.id)], [["a:acc2"], ["LoanEvent"], ["t4"], ["t6"]], "what crosses is this edge's own; t6 stays");
  assert.ok(isDefect(threats[1]) && !isDefect(threats[0]));
  assert.equal(crossingsOf({ arch, access: access.slice(1, 2), gates, threats: threats.slice(1, 3) })[0].result, "not_assessed", "a defect alone assesses nothing");
  assert.equal(wayText(wayOf(rows[2], rows, arch)), "anyone on the internet → ‖ token, in the code → handler → no check: one process → consumer", "way 4 passes gate 1 and starts with the principal");
  assert.equal(wayText(wayOf(rows[0], rows, arch)), "anyone on the internet → ‖ token, in the code → handler → consumer → Mailer");
  assert.match(secSentence(rows, 2), /All 5 crossings are assessed\. 2 security findings are unresolved\./);
  const eff = passZones(new Map([["handler", { trust: "public", drawn: "authenticated" }]]), arch, () => "if crossing 1 fails open");
  assert.deepEqual([...eff].map(([k, v]) => [k, v.trust, v.cond ?? null]), [["handler", "public", null], ["consumer", "public", "if crossing 1 fails open"], ["mailer", "public", "if crossing 1 fails open"]]);
}

// ---- runs_in as a list: the most exposed zone counts
{
  const { runsIn, mapArch, crossingsOf } = await import("./views.js");
  assert.deepEqual([runsIn({ runs_in: ["a", "b"] }), runsIn({ runs_in: "a" }), runsIn({})], [["a", "b"], ["a"], []]);
  const arch = { zones: [{ id: "zp", trust: "public", name: "P" }, { id: "zi", trust: "internal", name: "I" }],
    groups: [{ id: "g_fd", label: "Front desk Lambda" }, { id: "g_rc", label: "Consumer Lambda" }, { id: "g_lib", label: "Shared library code" }],
    nodes: [{ id: "h", group: "g_fd", zone: "zp" }, { id: "c", group: "g_rc", zone: "zi" }, { id: "m", group: "g_lib", zone: "zi", runs_in: ["g_rc", "g_fd"] }], edges: [] };
  assert.equal(mapArch(arch).nodes.find((n) => n.id === "m").zone, "zp", "a library in two Lambdas takes the more exposed zone");
  assert.equal(mapArch({ ...arch, nodes: arch.nodes.map((n) => (n.id === "m" ? { ...n, runs_in: "g_rc" } : n)) }).nodes.find((n) => n.id === "m").zone, "zi", "one id still reads");
  const rows = crossingsOf({ arch: { ...arch, edges: [{ from: "m", to: "c", crosses: true }] } });
  assert.deepEqual(rows.map((r) => r.from.trust), ["public"], "a call from the library starts in its most exposed zone");
}

// ---- wave R2: words for identifiers, the verdict, before merge / watch, doubled ways, readable dimming, picture by kind
{
  const { resWord, resToolText, resVerdict, resWatch, resTwice, readableFade, resPicture } = await import("./views.js");
  assert.deepEqual(["poison_message", "no_dlq", "cannot_happen", "platform_only", "brand_new"].map(resWord), ["a message that always fails", "no dead-letter queue", "cannot happen here", "the platform's own metrics only", "brand new"]);
  assert.ok(resToolText("Runtime behaviour: nothing was executed, because Bash was denied") && !resToolText("Deployed SQS defaults (visibility timeout, retention)"));
  const paths = [{ blocker: { reason: "load grows" } }, { blocker: { reason: "mails repeat" } }, { blocker: { reason: "load grows" } }, {}];
  assert.equal(resVerdict(paths), "3 of 4 paths block the merge: load grows (2 paths) and mails repeat.");
  assert.equal(resVerdict([{}]), null);
  const arch = { nodes: [{ id: "queue", label: "LoanEvents (SQS)", at: "template.yaml:11" }, { id: "consumer", at: "library/consumer.py:11" }, { id: "reminders", at: "library/reminders.py:16" }, { id: "mailer", label: "Mailer (mailer.py)" }],
    edges: [{ from: "queue", to: "consumer" }, { from: "reminders", to: "mailer" }, { from: "consumer", to: "mailer" }] };
  const res = { blind_spots: [{ failure: "Mail transport failure is not visible", at: "library/mailer.py:19", signal: "none", alarm: "none" }, { failure: "Queue age is not monitored", at: "template.yaml:11", signal: "platform_only", alarm: "none" }],
    deps: [{ edge: "e0", at: "template.yaml:32", mode: "async" }, { at: "template.yaml:40", mode: "async" }, { at: "library/handler.py:21", mode: "in_process" }] };
  const w = resWatch(res, arch);
  assert.deepEqual(w.before.map((x) => x.at), ["library/mailer.py:19"], "no signal at all: before the merge");
  assert.deepEqual(w.watch.map((x) => x.text), ["Queue age is not monitored; it shows in the platform's own metrics only, no alarm"], "the same queue once");
  assert.equal(resWatch({ deps: [{ at: "template.yaml:32", mode: "async" }] }, arch).watch[0].text, "The age of the oldest message in LoanEvents (SQS)");
  const effects = [{ kind: "mail", node: "reminders", at: "library/reminders.py:21" }, { kind: "mail", node: "consumer", at: "library/consumer.py:21" }, { kind: "publish", node: "events" }];
  assert.deepEqual([...resTwice({ failing: ["duplicate_effect"], steps: ["library/reminders.py:21", "queue"] }, { effects }, arch)].sort(), ["consumer", "mailer", "reminders"], "both senders and the mailer they share");
  assert.equal(resTwice({ failing: ["lost_effect"], steps: ["library/reminders.py:21"] }, { effects }, arch).size, 0);
  assert.equal(readableFade("#eeeeef", "#17191d"), 0.5, "dark: 2.1:1 at 25 %, 4.5:1 from 50 %");
  assert.ok(readableFade("#1f2328", "#ffffff") >= 0.6 && readableFade("#eeeeef", "#17191d", 0.55) === 0.55 && readableFade("hsl(0,0%,90%)", "#000") === 0.6);
  assert.equal(resPicture({ kind: "timeout", ladder: [{}] }), null, "a timeout without its budget shows no ladder of another path");
  assert.equal(resPicture({ kind: "silent", ladder: [{}] }), "ladder", "a kind without a picture of its own takes what there is");
}

// ---- wave R2: a queue's mark at the queue, the other marks of a call on the call
{
  const { resMarksOn, resEdgeMarks } = await import("./views.js");
  const arch = { nodes: [{ id: "q", at: "template.yaml:11" }, { id: "c", at: "library/consumer.py:11" }], edges: [{ from: "q", to: "c" }] };
  const marks = [{ at: "e0", mark: "no DLQ" }, { at: "e0", mark: "⏱ 10 s" }, { at: "library/consumer.py:19", mark: "✕ silent" }];
  assert.deepEqual([...resMarksOn(marks, arch, true)], [["q", "no DLQ"], ["c", "✕ silent"]]);
  const p = { marks, ladder: [{ name: "batch", factor: "×10", at: "template.yaml:37" }, { name: "until it expires", factor: "no limit", at: "template.yaml:32" }] };
  assert.deepEqual([...resEdgeMarks(p, [{ edge: "e0", at: "template.yaml:32" }])], [[0, "⏱ 10 s · ↻ no limit"]]);
}

// ---- wave R2: the run's own unseen and watch lists, and a probe that dates an unclear blocker
{
  const { resWatch, resByProbe, resCardOf } = await import("./views.js");
  const arch = { nodes: [{ id: "queue", label: "LoanEvents (SQS)", at: "template.yaml:11" }, { id: "consumer", at: "library/consumer.py:11" }, { id: "mailer", label: "Mailer (mailer.py)" }], edges: [{ from: "queue", to: "consumer" }] };
  const w = resWatch({ unseen: ["A mail is dropped (library/mailer.py:14): nothing shows it"], watch: ["Consumer failures (library/consumer.py:11): seen as platform_only, but nothing alarms on it", "the age of the oldest message at e0"] }, arch);
  assert.deepEqual(w.before, [{ text: "A mail is dropped: nothing shows it", at: "library/mailer.py:14" }]);
  assert.deepEqual(w.watch.map((x) => x.text), ["Consumer failures: seen as the platform's own metrics only, but nothing alarms on it", "The age of the oldest message in LoanEvents (SQS)"]);
  assert.equal(resCardOf("library/mailer.py:14-20", arch), "mailer", "a range of lines");
  const paths = [{ id: "p9", probe: "r1", pre_existing: "unknown", blocker: { why: "lost", unclear: true } }, { id: "p2", blocker: { why: "x" } }];
  const done = (verdict) => [{ id: "r1", status: "done", base: { verdict } }];
  assert.equal(resByProbe(paths, done("already_on_base"))[0].blocker, null);
  assert.deepEqual([resByProbe(paths, done("new_in_pr"))[0].blocker.unclear, resByProbe(paths, done("unknown"))[0].blocker.unclear, resByProbe(paths, [])[1]], [false, true, paths[1]]);
}

// ---- a path's mark line in a card of the Resilience map has its own room: the card grows by the line, its space
// under it and the card's gap, so the mark does not sit on a finding's chip (R2 follow-up)
{
  const { RES_MARK_ROW, resMarkRows } = await import("./views.js");
  const arch = { nodes: [{ id: "a", label: "A", description: "one line" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "x" }] };
  const h = (rows) => archLayout(arch, "diff", (n) => (n.id === "a" ? rows : 0)).nodes.find((n) => n.id === "a").h;
  const base = h(0), finding = h(1), both = h(1 + resMarkRows());
  assert.equal(both - finding, RES_MARK_ROW.h + RES_MARK_ROW.below + 3, "the mark's line, the space under it and the card's gap");
  assert.ok(finding >= base, "a finding's row keeps its 18 px");
}

// ---- wave C2: the verdict as a short sentence and a count; the map starts at the path's first card
{
  const { resVerdictParts, resStartCard } = await import("./views.js");
  assert.deepEqual(resVerdictParts([{ blocker: { why: "lost" } }, { blocker: { why: "twice" } }, { blocker: { why: "lost" } }, {}]), { head: "3 of 4 paths block the merge.", counts: ["lost: 2", "twice: 1"] });
  assert.equal(resVerdictParts([{}]), null);
  const arch = { nodes: [{ id: "r", at: "library/reminders.py:16" }, { id: "q" }, { id: "c" }], edges: [{ from: "q", to: "c" }] };
  assert.deepEqual([resStartCard({ steps: ["e0", "c"] }, arch), resStartCard({ steps: ["reminders.py:21", "e0"] }, arch), resStartCard({ steps: [], reach: ["c"] }, arch)], ["q", "r", "c"]);
}

// ---- wave C2: a finding marks only the transition it names, not every one in its lines
{
  const { transitionMarks } = await import("./views.js");
  const t = (from, to, evidence) => ({ from, to, evidence });
  const v = { transitions: [t("BORROWED", "REMINDED", "library/status.py:46"), t("BORROWED", "OVERDUE", "library/status.py:45"), t("REMINDED", "OVERDUE", "library/status.py:45"),
    t("BORROWED", "RETURNED", "library/status.py:48"), t("REMINDED", "RETURNED", "library/status.py:48"), t("OVERDUE", "OVERDUE", "library/reminders.py:33")] };
  const f = (id, file, line, end, extra = {}) => ({ id, file, line, end, severity: "high", ...extra });
  const at = (fs) => [...transitionMarks(v, fs)].map(([i, x]) => [i, x.findings.map((g) => g.id)]);
  assert.deepEqual(at([f("a", "library/status.py", 46, 50)]), [[0, ["a"]]], "the transition at its first line, not all four in its range");
  assert.deepEqual(at([f("b", "library/status.py", 45, 45)]), [[1, ["b"]], [2, ["b"]]], "two transitions on the same line both");
  assert.deepEqual(at([f("c", "library/reminders.py", 35, 35), f("d", "library/status.py", 39, 39)]), [[5, ["c"]]], "near enough, or none");
  assert.deepEqual(at([f("e", "library/status.py", 46, 50, { breaks: { from: "reminded", to: "returned" } })]), [[4, ["e"]]], "breaks names it");
}

// ---- wave C2: a reproduced probe confirms its path's findings
{
  const { withProbes, certaintyText } = await import("./views.js");
  const fs = [{ id: "a", ids: ["a", "a2"], certainty: "derived" }, { id: "b", certainty: "derived" }];
  const paths = [{ id: "p3", probe: "r1", findings: ["a2"] }, { id: "p4", findings: ["b"] }];
  const out = withProbes(fs, paths, [{ id: "r1", of: "p3", status: "done", result: "reproduced", strength: "models_env" }, { id: "r2", of: "p4", status: "done", result: "not_reproduced" }]);
  assert.deepEqual(out.map((f) => certaintyText(f)), ["confirmed, platform modeled", "derived"]);
  assert.equal(withProbes(fs, paths, []), fs, "no probe done: the same list");
}

// ---- wave C2 V1: a finding's mark in a card has two lines and the layout room for them
{
  const { markLine, clampText, ARCH, LABEL, MARK_CARD_H, MARK_CARD_ROWS } = await import("./arch.js");
  assert.ok(MARK_CARD_H + 3 <= MARK_CARD_ROWS * 18 && MARK_CARD_H >= 18 + 1 + 28, "the extra rows hold the chip, two lines and the card's gap");
  assert.ok(LABEL.MARK >= 18 + 1 + 28, "above a call: the chip, then two lines");
  const ml = markLine({ findings: [{ severity: "high", title: "Nothing ever calls send_reminders or publish_overdue: no schedule" }], n: 1 });
  const two = clampText(ml.text, Math.floor((ARCH.W - 20) / 6), 2);
  assert.equal(two.lines, 2); assert.ok(!two.cut, `the five words fit in two lines of a card: ${two.text}`);
}

// ---- wave C2 D3: a path that cannot happen today blocks once wired: after the blockers, said apart from them
{
  const { resVerdictParts, resOrder, resPathView } = await import("./views.js");
  const ps = [{ id: "a", result: "finding" }, { id: "w", result: "finding", wired: { why: "x", today: "not possible today" } }, { id: "b", result: "finding", blocker: { why: "y" } }];
  assert.deepEqual(resOrder(ps).map((p) => p.id), ["b", "w", "a"]);
  assert.equal(resVerdictParts(ps).head, "1 of 3 paths blocks the merge. 1 path blocks once it is wired.");
  assert.equal(resVerdictParts([ps[1]]).head, "1 path blocks once it is wired.");
  assert.equal(resPathView(ps[1]).wired.reason, "x");
}
