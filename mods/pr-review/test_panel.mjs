// Run: node test_panel.mjs  (the PR panel at rest: Herdr draws every mod again whenever its live data changes (an
// agent's status, focus, shared state), so a render of the panel must cost nothing but the drawing. Counted here: shared
// writes, timers, tasks and redraws asked for, over renders with nothing new; then what one real change costs.)
import assert from "node:assert/strict";
import { S, cx as base } from "./render_stub.mjs";

const { default: PrReview } = await import("./main.js");
const { openSig } = await import("./views.js");

const n = { writes: [], notify: 0, spawn: 0 }, timers = [];
const cx = { ...base, notify() { n.notify++; }, spawn(fn) { n.spawn++; void Promise.resolve().then(() => fn(cx)).catch(() => null); },
  timer: { after(_ms, fn) { timers.push(fn); }, every() {} } };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// Timers until none is left (a timer may start a task that sets another).
const flush = async () => { for (let k = 0; k < 20 && timers.length; k++) { for (const fn of timers.splice(0)) fn(cx); await settle(); } await settle(); };
const reset = () => { n.writes.length = 0; n.notify = 0; n.spawn = 0; };
// As Herdr: shared() gives a new object per call, setShared is counted.
S.store.get = (k) => structuredClone(Map.prototype.get.call(S.store, k));
S.store.set = (k, v) => { n.writes.push(k); return Map.prototype.set.call(S.store, k, v); };
const idle = async (v, what, renders = 20) => {
  reset();
  for (let i = 0; i < renders; i++) { v.render(cx); await flush(); }
  assert.deepEqual({ writes: n.writes, timers: timers.length, notify: n.notify, spawn: n.spawn }, { writes: [], timers: 0, notify: 0, spawn: 0 }, what);
};

const review = (k, touched) => ({ status: "in-progress", url: `https://github.com/o/r/pull/${k}`, number: k, repo: "o/r", title: `PR ${k}`, lastTouched: touched, progress: { files: 3, filesViewed: 1 } });
assert.equal(openSig([review(1, 5)]), openSig(structuredClone([review(1, 5)])), "equal lists have one signature");
assert.notEqual(openSig([review(1, 5)]), openSig([review(1, 6)]), "a touched review changes it");
assert.notEqual(openSig([review(1, 5), review(2, 5)]), openSig([review(1, 5)]), "a removed review changes it");
assert.equal(openSig(null), "", "no list is the empty one");

// ---- the list, with reviews in progress
S.props = {}; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
Map.prototype.set.call(S.store, "review.open", [review(1, 5), review(2, 4)]);
S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [] }));
{
  const v = new PrReview(); v.init({}, cx); await flush(); v.render(cx); await flush();
  await idle(v, "the list at rest: 20 renders ask for nothing");
  Map.prototype.set.call(S.store, "review.open", [review(1, 9), review(2, 4)]); // the review layout touched one
  reset(); v.render(cx); await flush();
  assert.deepEqual(n.writes, [], "a review only touched makes the same items: nothing is written");
  Map.prototype.set.call(S.store, "review.open", [{ ...review(1, 12), progress: { files: 3, filesViewed: 2 } }, review(2, 4)]); // a file viewed
  reset(); v.render(cx); await flush();
  assert.deepEqual(n.writes, ["goto.items.review"], "a review whose progress changed writes Go to's items once");
  await idle(v, "and then nothing again");
  // prs.json read again with the same PRs (a scan that found nothing new): no redraw.
  reset(); await v.loadPrs(cx); assert.equal(n.notify, 0, "the same prs.json draws nothing");
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: "x", prs: [{ url: "https://github.com/o/r/pull/7", number: 7, repo: "o/r", state: "open", session: "abcdefgh", at: "2026-01-01" }] }));
  await v.loadPrs(cx); assert.equal(n.notify, 1, "a new PR in prs.json draws once");
}

// ---- the current branch, while files of the repo are written (an agent at work)
{
  let diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 2\n", diffs = 0;
  S.exec = async (cmd, args) => {
    if (cmd === "git" && args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n/repo/.git\norigin/main\n", stderr: "" };
    if (cmd === "git" && args.includes("diff")) { diffs++; return { code: 0, stdout: diff, stderr: "" }; }
    return { code: 1, stdout: "", stderr: "stub" };
  };
  Map.prototype.set.call(S.store, "pr.selected", { all: "branch" });
  const v = new PrReview(); v.init({}, cx); await flush(); v.render(cx); await flush();
  assert.equal(v.rows.length > 0 && v.files.length, 1, "the branch's diff is shown");
  await idle(v, "the branch at rest: 20 renders ask for nothing");
  // A file was written, the diff is the same (an ignored or untracked file, or a save without a change).
  const rows = v.rows, files = v.files, before = diffs;
  v.dirty.add("/repo"); reset(); v.render(cx); await flush();
  assert.equal(diffs, before + 1, "the change is looked at");
  assert.deepEqual({ notify: n.notify, writes: n.writes, same: v.rows === rows && v.files === files, loading: v.loading }, { notify: 0, writes: [], same: true, loading: false }, "the same diff again: nothing is replaced, nothing is drawn");
  // Another file changed: the list of files is new, the open file's rows (and their colours) stay.
  diff += "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n";
  v.dirty.add("/repo"); reset(); v.render(cx); await flush();
  assert.equal(v.files.length, 2, "the new file is listed");
  assert.equal(v.rows, rows, "the open file did not change: its rows stay");
  assert.deepEqual(n.writes, [], "a reload writes no shared state");
  await idle(v, "and at rest again");
  // Behind the list nothing is diffed.
  v.picking = true; v.dirty.add("/repo"); const then = diffs; reset(); v.render(cx); await flush();
  assert.equal(diffs, then, "no diff while the list is shown");
  S.exec = null;
}

// ---- a remount with a PR picked before: the list is not drawn (nor fetched) while the pick comes back
{
  Map.prototype.set.call(S.store, "pr.selected", { all: "https://github.com/o/r/pull/7" });
  const v = new PrReview(); v.init({}, cx);
  v.render(cx); // before prs.json is read
  assert.ok(!v.srcAsked, "the list was not asked for");
  await flush();
  assert.equal(v.prSel?.number, 7, "the pick is back"); assert.ok(!v.restoring);
  // A pick that is gone falls back to the list.
  Map.prototype.set.call(S.store, "pr.selected", { all: "https://github.com/o/r/pull/99" });
  const w = new PrReview(); w.init({}, cx); await flush(); w.render(cx);
  assert.ok(!w.restoring && !w.prSel && w.srcAsked, "a pick that is gone: the list");
}

// ---- a PR's head is asked once for all copies (the panel, then the review of the same PR)
{
  let asks = 0;
  S.exec = async (cmd, args) => { if (cmd === "gh" && args.includes("headRefOid")) { asks++; return { code: 0, stdout: JSON.stringify({ headRefOid: "abc" }), stderr: "" }; } return { code: 1, stdout: "", stderr: "stub" }; };
  Map.prototype.set.call(S.store, "pr.selected", {});
  const pr = { url: "https://github.com/o/r/pull/8", number: 8, repo: "o/r", headSha: "abc" };
  const a = new PrReview(); a.init({}, cx); const b = new PrReview(); b.init({}, cx); await flush();
  a.checkHead(pr, cx); await flush(); b.checkHead(pr, cx); await flush();
  assert.equal(asks, 1, "the second copy takes the head the first one asked for");
  S.exec = null;
}

// ---- a scan for session PRs that cannot reach GitHub waits longer each time (prs.py exit 3)
{
  let code = 3, runs = 0;
  S.exec = async (cmd, args) => { if (cmd === "python3" && String(args[0]).endsWith("prs.py")) { runs++; return { code, stdout: "", stderr: "" }; } return { code: 1, stdout: "", stderr: "stub" }; };
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: "2020-01-01T00:00:00Z", prs: [] }));
  const v = new PrReview(); v.init({}, cx); await flush();
  assert.deepEqual([runs, v.scanPoll.fails], [1, 1], "the scan at mount failed");
  v.scanPoll.at = Date.now() - 6 * 60000; assert.ok(!v.scanDue(), "six minutes after a failed scan: not yet");
  v.scanPoll.at = Date.now() - 11 * 60000; assert.ok(v.scanDue(), "eleven minutes after: due");
  code = 2; v.scanIfDue(cx); await flush();
  assert.deepEqual([runs, v.scanPoll.fails], [2, 0], "one PR that cannot be read is not an outage");
  S.exec = null;
}

// ---- the review's "Fix worktrees…": a worktree with work only there is removed on the second click, never the first
{
  const calls = [];
  S.exec = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  S.props = { part: "review" };
  const v = new PrReview(); v.init({}, cx); await flush();
  v.prSel = { url: "https://github.com/o/demo/pull/2", repo: "o/demo", number: 2, cwd: "/code/demo" };
  v.wts = [{ path: "/h/.herdr/worktrees/demo/fix-2-a1", branch: "fix/2-a1", only: 2, dirty: false, unknown: false }, { path: "/h/.herdr/worktrees/demo/fix-2-b2", branch: "fix/2-b2", only: 0, dirty: false, unknown: false }];
  calls.length = 0; v.removeWorktree(0, cx); await flush();
  assert.deepEqual([calls.filter((c) => c.includes("worktree remove")), /Nothing was removed/.test(v.note)], [[], true], "the first click on one with commits only there removes nothing");
  v.removeWorktree(0, cx); await flush();
  assert.deepEqual(calls.filter((c) => /worktree remove|branch -D/.test(c)), ["git -C /code/demo worktree remove --force /h/.herdr/worktrees/demo/fix-2-a1", "git -C /code/demo branch -D fix/2-a1"], "the second click removes it and its branch");
  calls.length = 0; v.removeWorktree(1, cx); await flush();
  assert.equal(calls.filter((c) => c.includes("worktree remove")).length, 1, "one with nothing only there goes at once");
  S.exec = null; S.props = {};
}

// ---- back from a review the panel shows that review's PR, not the one picked before (shared "pr.fromReview")
{
  const { byRef } = await import("./views.js");
  const pr = (repo, n) => ({ url: `https://github.com/${repo}/pull/${n}`, repo, number: n, title: `PR ${n}`, headSha: "abc", base: "main" });
  const a = pr("o/r", 7), x = pr("o/other", 7), y = pr("o/r", 9);
  assert.deepEqual([byRef([a, x, y], "7"), byRef([a, x, y], "o/other#7"), byRef([a, x, y], x.url), byRef([a, x, y], "9"), byRef([a], "8")], [a, x, x, y, null], "two PRs numbered 7: the bare number is the first, the repo or the URL names the other");
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [a] }));
  Map.prototype.set.call(S.store, "pr.selected", { "all@s1": a.url }); Map.prototype.set.call(S.store, "pr.picked", {});
  // The review of X was opened by a Resume in a list (no pick), then minimized: the review copy hands X over.
  Map.prototype.set.call(S.store, "review.target", x); Map.prototype.set.call(S.store, "review.back", "corgi");
  S.props = { part: "review" }; const rv = new PrReview(); rv.init({}, cx); await flush(); rv.command("minimize", cx);
  assert.equal(S.store.get("pr.fromReview")?.url, x.url, "leaving the review hands its PR over");
  S.props = {}; const v = new PrReview(); v.init({}, cx); v.render(cx);
  assert.ok(v.restoring && !v.srcAsked, "no list while it comes back");
  await flush();
  assert.deepEqual([v.prSel?.url, S.store.get("pr.fromReview"), S.store.get("pr.selected")["all@s1"]], [x.url, null, x.url], "the panel shows the review's PR and remembers it for this space");
  const w = new PrReview(); w.init({}, cx); await flush();
  assert.equal(w.prSel?.url, x.url, "and again after the next remount");
  // The review was opened from the list (a row's Resume): back from it the list is shown again, at once, with the
  // review's PR as the pick behind "Back to #n →". Opened with a PR chosen (the header's button): that PR's diff.
  S.files.set("/h/mods/pr-review/review-layout.json", "{}");
  w.picking = true; await w.toReview(y); assert.equal(S.store.get("pr.listed"), true, "opened from the list");
  Map.prototype.set.call(S.store, "pr.fromReview", y);
  const l = new PrReview(); l.init({}, cx); l.render(cx);
  assert.deepEqual([l.picking, Boolean(l.restoring)], [true, false], "the list in the first frame, nothing held back");
  await flush();
  assert.deepEqual([l.picking, l.prSel?.url, S.store.get("pr.listed"), S.store.get("pr.fromReview")], [true, y.url, null, null], "the list stays; the review's PR is the pick");
  l.picking = false; await l.toReview(y); assert.equal(S.store.get("pr.listed"), false, "opened with the PR chosen");
  Map.prototype.set.call(S.store, "pr.fromReview", y);
  const c = new PrReview(); c.init({}, cx); await flush();
  assert.deepEqual([c.picking, c.prSel?.url], [false, y.url], "back from it: the PR, not the list");
  // The registry entry's risk mark for the minimized chip: the review's own counts.
  const { riskOfCounts, rowMarks } = await import("./views.js");
  assert.deepEqual(rowMarks(riskOfCounts({ unresolved: 5, high: 2, medium: 3, low: 0, security: 1 }), null).map(({ text, security, kind }) => ({ text, security, kind })), [{ text: "⛨ high", security: true, kind: "risk" }]);
  assert.deepEqual([rowMarks(riskOfCounts({ unresolved: 1, high: 0, medium: 1, security: 0 }), null)[0].text, rowMarks(riskOfCounts({}), null)], ["medium", []]);
}

// ---- resuming a review: the first frame drawn stands on the tab and page you left, the list scrolls there when it comes
{
  const { splitPatch } = await import("./pr.js");
  const target = { url: "https://github.com/o/r/pull/3", repo: "o/r", number: 3, title: "t", headSha: "abc", base: "main" };
  const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 2\ndiff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n";
  S.files.set("/h/pr-data/review-progress.json", JSON.stringify({ [target.url]: { seen: ["a.py"], ui: { tab: "steps", page: null, fileFocus: "b.py", cur: 1, order: "reading" } } }));
  Map.prototype.set.call(S.store, "review.target", target); S.props = { part: "review" };
  S.exec = async (cmd, args) => (cmd === "gh" && args[1] === "diff" ? { code: 0, stdout: diff, stderr: "" } : { code: 1, stdout: "", stderr: "stub" });
  const seen = []; // what each frame would show: held frames draw nothing of the review
  const v = new PrReview(); v.init({}, cx);
  for (let k = 0; k < 40 && !(v.hunks && v.resumed); k++) { v.render(cx); seen.push(v.resumed === target.url ? [v.tab, v.order, Boolean(v.hunks)] : "held"); for (const fn of timers.splice(0)) fn(cx); await new Promise((r) => setImmediate(r)); }
  assert.ok(seen.includes("held") || seen.length, "frames are held until the place is read");
  assert.deepEqual(seen.filter((x) => x !== "held").map((x) => `${x[0]}/${x[1]}`).filter((x) => x !== "steps/reading"), [], "no frame on another tab or order than the one you left");
  await flush(); v.patch ??= splitPatch(diff);
  assert.deepEqual([v.tab, v.order, v.resumed, [...v.collapsed].includes("a.py")], ["steps", "reading", target.url, true], "the tab, the order and the folded viewed file are back");
  // What you did since stays when the diff loads again (a new head).
  v.tab = "files"; await v.onSource(cx);
  assert.equal(v.tab, "files", "a later load does not put the old place back");
  S.exec = null; S.props = {};
}

// ---- Setup's first line says what the list comes to
{
  const { setupSummary } = await import("./setup-view.js");
  const now = 1e12, row = (id, status) => ({ id, status });
  assert.equal(setupSummary([row("git", "ok"), row("gh", "ok")], now - 120000, now), "All 2 programs were found. Checked 2 min ago.");
  assert.equal(setupSummary([row("git", "ok"), row("codex", "optional-missing")], now, now), "Everything required was found; 1 optional program is not installed. Checked just now.");
  assert.match(setupSummary([row("git", "missing"), row("gh", "logged-out"), row("x", "ok")], now + 5000, now), /^2 of 3 programs are missing or not signed in: git, gh\. .* Checked just now\.$/);
}
// ---- "Discard" asks once
{
  S.props = {}; const v = new PrReview(); v.init({}, cx); await flush();
  v.reviewKey = "k"; v.comments = [{ id: "1", file: "a.py", text: "x" }, { id: "2", file: "a.py", text: "y" }];
  v.discardAll(cx); assert.deepEqual([v.discardAsk, v.comments.length], [true, 2], "the first click asks");
  v.discardAll(cx); assert.deepEqual([v.discardAsk, v.comments.length], [false, 0], "the second deletes them");
}

// ---- switching while something loads: the last pick wins, another space's list never lands here
{
  const { startReview } = await import("./review.js");
  const pr = (repo, n) => ({ url: `https://github.com/${repo}/pull/${n}`, repo, number: n, title: `PR ${n}`, headSha: `h${n}`, base: "main", state: "open" });
  const patch = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x = 1\n+x = 2\n`;
  const later = () => { let done; const p = new Promise((r) => { done = r; }); return { p, done }; };
  const A = pr("o/a", 1), B = pr("o/b", 2), ok = (stdout) => ({ code: 0, stdout, stderr: "" }), no = { code: 1, stdout: "", stderr: "stub" };
  S.props = {}; S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [] }));
  for (const k of ["pr.selected", "pr.picked", "pr.fromReview", "review.minimized", "review.target"]) Map.prototype.set.call(S.store, k, null);

  // A PR picked while another one's diff still loads: its own load starts at once, the older answer is dropped.
  const slow = later();
  S.exec = async (cmd, args) => (cmd === "gh" && args[1] === "diff" ? (args[2] === A.url ? slow.p : ok(patch("b.py"))) : no);
  const v = new PrReview(); v.init({}, cx); await flush();
  v.choose(A, cx); await settle(); v.choose(B, cx); await flush();
  assert.deepEqual([v.prSel.url, v.files.map((f) => f.path), v.loading], [B.url, ["b.py"], false], "the second pick shows without waiting for the first");
  slow.done(ok(patch("a.py"))); await flush();
  assert.deepEqual([v.files.map((f) => f.path), v.loading, v.pr?.number], [["b.py"], false, 2], "the first one's late answer changes nothing");

  // A PR whose head is still asked for (a search result), then another pick: the late one does not take over.
  const head = later();
  S.exec = async (cmd, args) => (cmd === "gh" && args[1] === "view" && args[2] === A.url ? head.p : cmd === "gh" && args[1] === "diff" ? ok(patch("b.py")) : no);
  v.pickTarget({ ...A, headSha: undefined }, cx); await settle(); v.choose(B, cx); await flush();
  head.done(ok(JSON.stringify({ number: 1, title: "PR 1", headRefOid: "h1", headRefName: "x", baseRefName: "main", url: A.url, state: "OPEN" }))); await flush();
  assert.equal(v.prSel.url, B.url, "the later pick stays");

  // "This repo" asked in one space, answered after the person went to another: the list shown is the new space's.
  const listA = later();
  S.spaces = [{ id: "sa", active: true, folder: "/a", tabs: [] }];
  S.exec = async (cmd, args, opt) => {
    if (cmd === "git" && args.includes("--show-toplevel")) return ok(`${opt.cwd}\n${opt.cwd}/.git\norigin/main\n`);
    if (cmd === "git" && args[0] === "remote") return ok(`https://github.com/o${opt.cwd}.git\n`);
    if (cmd === "gh" && args[1] === "list") return args[3] === "o/a" ? listA.p : ok(JSON.stringify([{ number: 5, title: "five", url: "https://github.com/o/b/pull/5", headRefOid: "h5" }]));
    return no;
  };
  Map.prototype.set.call(S.store, "pr.source", "repo");
  const w = new PrReview(); w.init({}, cx); await flush(); w.loadSource(cx); await settle();
  S.spaces = [{ id: "sb", active: true, folder: "/b", tabs: [] }]; w.onSpace(cx); await flush();
  assert.deepEqual([w.srcLists.repo?.key, w.srcLists.repo?.prs.map((x) => x.number)], ["repo:o/b", [5]], "the new space's list");
  listA.done(ok(JSON.stringify([{ number: 1, title: "one", url: A.url, headRefOid: "h1" }]))); await flush();
  assert.deepEqual([w.srcLists.repo.key, w.spaceSlug?.slug, w.srcLists.repo.prs.map((x) => x.number)], ["repo:o/b", "o/b", [5]], "the first space's late answer is not shown here");

  // "review" with the list shown and nothing chosen: the PR of the current branch, asked for then (no diff is made).
  S.files.set("/h/mods/pr-review/review-layout.json", "{}"); // what startReview copies into layouts/ the first time
  const calls = [];
  S.exec = async (cmd, args, opt) => { calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args.includes("--show-toplevel")) return ok(`${opt.cwd}\n${opt.cwd}/.git\norigin/main\n`);
    if (cmd === "gh" && args[1] === "view") return ok(JSON.stringify({ number: 8, title: "branch PR", url: "https://github.com/o/b/pull/8", baseRefName: "main", headRefOid: "h8" }));
    return no; };
  Map.prototype.set.call(S.store, "pr.selected", {});
  const x = new PrReview(); x.init({}, cx); await flush(); calls.length = 0;
  x.panelCommand("review", cx); await flush();
  assert.deepEqual([S.store.get("review.target")?.url, S.store.get("review.target")?.cwd, calls.some((c) => c.includes(" diff "))], ["https://github.com/o/b/pull/8", "/b", false], "the branch's PR opens in the review");

  // A second review while the first is minimized: its chip stays until the second is minimized, then it is the second's;
  // both stay in the registry, and the panel gets the PR of the review that was left last.
  Map.prototype.set.call(S.store, "review.target", A); S.props = { part: "review" };
  const r1 = new PrReview(); r1.init({}, cx); await flush(); r1.command("minimize", cx);
  assert.equal(S.store.get("review.minimized")?.target.url, A.url);
  await startReview(B);
  assert.deepEqual([S.store.get("review.minimized")?.target.url, S.store.get("review.target").url], [A.url, B.url], "the first one's chip is still there");
  const r2 = new PrReview(); r2.init({}, cx); await flush(); r2.command("back", cx);
  assert.deepEqual([S.store.get("review.minimized")?.target.url, S.store.get("pr.fromReview")?.url], [A.url, B.url], "Back from the second: the chip is the first's, the panel gets the second");
  r2.command("minimize", cx);
  assert.equal(S.store.get("review.minimized")?.target.url, B.url, "minimizing the second replaces the chip");
  await startReview(B);
  assert.equal(S.store.get("review.minimized"), null, "resuming it takes its chip away");
  S.exec = null; S.props = {}; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
}

// ---- "This space": the PRs of the branches checked out in the space's panes and its agents' worktrees
{
  const { spaceOrder, focusedPr } = await import("./views.js");
  const ok = (stdout) => ({ code: 0, stdout, stderr: "" }), calls = [];
  const node = (number, branch, state = "OPEN", extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/o/a/pull/${number}`, state, isDraft: false, headRefName: branch, headRefOid: `h${number}`, baseRefName: "main",
    updatedAt: new Date().toISOString(), mergedAt: null, isCrossRepository: false, author: { login: "me" }, reviewDecision: null, additions: 1, deletions: 0, ...extra });
  S.props = {}; S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [] }));
  for (const k of ["pr.selected", "pr.sourceBy", "pr.fromReview"]) Map.prototype.set.call(S.store, k, null);
  Map.prototype.set.call(S.store, "pr.source", "repo"); // the last pick anywhere
  S.spaces = [{ id: "sp", active: true, folder: "/a", tabs: [{ id: "t1", active: true }] }];
  S.panes = [{ pane: "p1", tab: "t1", cwd: "/a" }, { pane: "p2", tab: "t1", cwd: "/wt/fix" }];
  S.terminals = [{ address: "t9", labels: { "herdr.space": "sp" }, cwd: "/a", state: "live" }, { address: "t10", parent: "t9", cwd: "/wt/sub", state: "live" }];
  S.focused = { space: "sp", tab: "t1", pane: "p2", cwd: "/wt/fix" };
  for (const [dir, ref] of [["/a", "main"], ["/wt/fix", "fix/1"], ["/wt/sub", "feat/x"]]) S.files.set(`${dir}/.git/HEAD`, `ref: refs/heads/${ref}\n`);
  S.exec = async (cmd, args, opt) => { calls.push(`${cmd} ${args.slice(0, 3).join(" ")}`);
    if (cmd === "git" && args.includes("--show-toplevel")) return ok(`${opt.cwd}\n${opt.cwd}/.git\norigin/main\n`);
    if (cmd === "git" && args[0] === "remote") return ok("git@github.com:o/a.git\n");
    if (cmd === "gh" && args[1] === "graphql") { const q = args[3]; assert.ok(q.includes('"feat/x"') && q.includes('"fix/1"') && !q.includes('"main"'), "both branches in one query, not the default branch");
      return ok(JSON.stringify({ data: { repository: { b0: { nodes: [node(11, "feat/x")] }, b1: { nodes: [node(10, "fix/1", "MERGED", { mergedAt: new Date().toISOString() }), node(12, "fix/1")] } } } })); }
    return { code: 1, stdout: "", stderr: "stub" }; };
  const v = new PrReview(); v.init({}, cx); await flush(); v.loadSource(cx); await flush();
  assert.equal(calls.filter((c) => c.startsWith("gh api graphql")).length, 1, "one gh call for the repo, however many branches");
  assert.deepEqual([v.sourceNow(), v.srcLists.space.prs.map((p) => [p.number, p.state, p.cwd])], ["space", [[11, "open", "/wt/sub"], [12, "open", "/wt/fix"], [10, "merged", "/wt/fix"]]],
    "no source picked in this space and a branch here has a PR: This space is shown; each PR knows its checkout");
  const focus = v.spaceHeads.get("/wt/fix"), order = spaceOrder(v.listNow(), focus);
  assert.deepEqual([order.map((p) => p.number), focusedPr(order[0], focus)], [[12, 11, 10], true], "the focused pane's PR first, the merged one last");
  v.picking = true; v.render(cx); // the list draws
  // A pick is kept per space; another space falls back to the last pick anywhere.
  v.pickSource("review"); assert.deepEqual([v.sourceNow(), S.store.get("pr.sourceBy").sp, S.store.get("pr.source")], ["review", "review", "review"]);
  S.spaces = [{ id: "other", active: true, folder: "/a", tabs: [] }]; S.focused = null; v.spaceAuto = false;
  assert.equal(v.sourceNow(), "review", "no pick in that space: the last one");
  // Only default branches: nothing is asked of GitHub, the list says why, and the source stays what it was.
  Map.prototype.set.call(S.store, "pr.sourceBy", null); Map.prototype.set.call(S.store, "pr.source", "repo");
  S.spaces = [{ id: "sp", active: true, folder: "/a", tabs: [{ id: "t1", active: true }] }]; S.panes = [{ pane: "p1", tab: "t1", cwd: "/a" }]; S.terminals = [];
  const w = new PrReview(); w.init({}, cx); await flush(); calls.length = 0; await w.loadList("space", cx, { space: "sp", stale: () => false, force: true });
  assert.deepEqual([calls.filter((c) => c.startsWith("gh")).length, w.srcLists.space.why], [0, "Every checkout in this space is on its default branch, so there is no branch to look up a PR for."]);
  w.loadSource(cx); await flush(); assert.equal(w.sourceNow(), "repo", "no PR on a branch here: the source it was");
  S.exec = null; S.panes = null; S.terminals = null; S.focused = null; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
}
// ---- the diff's colors: a file whose slice never came back is given up and stays plain, and so is one whose scanner throws
{
  const v = new PrReview(); v.init({}, cx); await flush();
  const rows = Object.assign([{ kind: "+", number: 1, n: 1, text: "import os" }], { sig: "a" });
  v.rows = rows; v.open = "a.py"; v.render(cx);
  assert.ok(v.hl.rows === rows && v.hl.spans === null, "queued, not colored inside the render");
  await flush(); assert.ok(v.hl.spans[0].some((x) => x.kind === "keyword"), "colored by its slice");
  // Herdr stopped the slice: nothing was thrown, the job is where it was, and the slice was asked for long ago.
  const stuck = (at) => ({ rows, file: "a.py", job: { rows, lang: "python", i: 0, olds: null, news: null, out: [] }, spans: null, kept: null, at });
  v.hl = stuck(Date.now() - 500); v.render(cx); assert.equal(v.hl.spans, null, "a slice that may still run is left alone");
  v.hl = stuck(Date.now() - 5000); v.render(cx); assert.deepEqual(v.hl.spans, [[]], "given up: the file stays plain");
  v.hl = { ...stuck(0), job: null }; v.highlightMore(cx, v.hl); await flush(); assert.deepEqual(v.hl.spans, [[]], "a scanner that throws leaves the file plain");
}
// ---- the diff as a virtual list: a frame builds the lines on screen, however long the file is
{
  const v = new PrReview(); v.init({}, cx); await flush();
  v.branchPicked = true; v.picking = false; // the branch's diff is chosen: the diff is shown, the list of PRs is not
  v.render(cx); await flush(); // the new context is taken in (and finds no git here)
  const file = (n) => Object.assign(Array.from({ length: n }, (_x, i) => (i % 50 === 0 ? { kind: "@", text: `@@ -${i},50 +${i},50 @@` } : { kind: i % 3 ? "+" : " ", number: i, n: i, text: `import os${i}  # line ${i}` })), { sig: `f${n}` });
  // One frame: the render, then the list asked for the 40 lines the panel shows (as Herdr asks it while laying out).
  const frame = (range = { start: 100, end: 140 }) => {
    v.error = null; v.files = [{ path: "a.py", add: 1, del: 0 }]; // git is a stand-in here: the diff's rows are given
    S.lists.length = 0; const el0 = S.n.el; v.render(cx);
    const list = S.lists.find((l) => String(l.id).startsWith("pr-diff-"));
    assert.ok(list, "the diff is a virtual list");
    S.texts = new Set(); list.render(range, cx); const texts = S.texts; S.texts = null;
    return { made: S.n.el - el0, n: list.n, texts };
  };
  const made = {};
  for (const n of [200, 1500, 5000]) { v.rows = file(n); v.open = "a.py"; v.sel = null; frame(); await flush(); made[n] = frame(); assert.equal(made[n].n, n + 1, `${n} lines and the line to comment on the file`); }
  assert.equal(made[200].made, made[1500].made, `a frame builds as much for 1500 lines as for 200: ${JSON.stringify([made[200].made, made[1500].made])}`);
  assert.equal(made[1500].made, made[5000].made, `and as much for 5000: ${made[5000].made}`);
  console.log(`panel diff: elements per frame for 200 / 1500 / 5000 lines: ${made[200].made} / ${made[1500].made} / ${made[5000].made}`);
  // The lines on screen have their colors once the file is colored: the keyword is a run of its own.
  v.rows = file(300); v.hl = null; const plain = frame({ start: 1, end: 41 }); assert.ok(plain.texts.has("import os1  # line 1") && !plain.texts.has("import"), "plain until the file is colored");
  await flush(); const colored = frame({ start: 1, end: 41 }); assert.ok(colored.texts.has("import") && colored.texts.has("# line 1"), "then the shown lines are drawn in their colors");
  // The items: the line for the whole file, each visual line, a comment under its line (head and text), the composer under the selection.
  const at = new Map([[2, [{ id: "c1", file: "a.py", text: "Why?", start: 2, end: 2 }]]]), kinds = (x) => x.items.slice(0, 9).map((it) => it.k);
  v.comments = at.get(2); v.rows = file(60);
  assert.deepEqual(kinds(v.diffItems({ composeAt: null, at, loose: [], lo: -1 })), ["ask", "r0", "r1", "r2", "bhc1", "bbc1", "r3", "r4", "r5"]);
  assert.deepEqual(kinds(v.diffItems({ composeAt: 1, at, loose: [], lo: 1 })), ["ask", "r0", "r1", "ch", "ci", "ca", "r2", "bhc1", "bbc1"]);
  assert.deepEqual(kinds(v.diffItems({ composeAt: "top", at: new Map(), loose: at.get(2), lo: -1 })), ["ch", "ci", "ca", "bhc1", "bbc1", "r0", "r1", "r2", "r3"]);
  assert.deepEqual(v.diffItems({ composeAt: 1, at, loose: [], lo: 1 }).rowAt.slice(0, 4), [1, 2, 6, 9], "where each row starts, for a jump to it");
  assert.ok(v.diffItems({ composeAt: null, at, loose: [], lo: -1 }).items.every((it) => Number.isFinite(it.h) && it.h > 0 && typeof it.k === "string"));
  // Wrap: a long line is one item per visual line; the number stands at the first.
  Map.prototype.set.call(S.store, "review.wrap", true); v.panelW = 380;
  v.rows = Object.assign([{ kind: "+", number: 1, n: 1, text: "x = " + "abcdefgh ".repeat(30) }, { kind: "+", number: 2, n: 2, text: "y = 1" }], { sig: "w" });
  const wrapped = v.diffItems({ composeAt: null, at: new Map(), loose: [], lo: -1 });
  assert.ok(wrapped.items.length > 4 && wrapped.items[1].k === "r0" && wrapped.items[2].k === "r0.1" && wrapped.items.at(-1).k === "r1", `one item per visual line: ${wrapped.items.map((it) => it.k)}`);
  Map.prototype.set.call(S.store, "review.wrap", false);
  assert.deepEqual(v.diffItems({ composeAt: null, at: new Map(), loose: [], lo: -1 }).items.map((it) => it.k), ["ask", "r0", "r1"]);
  // More lines than the list holds: the rest is said in one line.
  v.rows = file(12000); const cut = v.diffItems({ composeAt: null, at: new Map(), loose: [], lo: -1 }).items;
  assert.deepEqual([cut.length, cut.at(-1).t, cut.at(-1).n], [9990, "more", 12001 - 9989]);
  // Presses: a line is selected (again: no longer), shift makes a range, "ask" opens the composer for the file; the
  // cards' buttons are found by where the press went down, from the right edge.
  v.rows = file(60); v.sel = null; v.selEnd = null; v.focusInput = () => {};
  v.press = { x: 100, w: 380, shift: false }; v.onDiffItem("r5", cx); assert.deepEqual([v.sel, v.selEnd], [5, null]);
  v.press = { x: 100, w: 380, shift: true }; v.onDiffItem("r8", cx); assert.deepEqual([v.sel, v.selEnd], [5, 8]);
  v.press = { x: 100, w: 380, shift: false }; v.onDiffItem("r8", cx); assert.deepEqual([v.sel, v.selEnd], [8, null]); v.onDiffItem("r8", cx); assert.equal(v.sel, null);
  v.onDiffItem("r0", cx); assert.equal(v.sel, null, "a hunk's head is no line to select");
  v.onDiffItem("ask", cx); assert.equal(v.askTop, true);
  const did = []; for (const m of ["closeAsk", "addComment", "ask", "editComment", "dropComment"]) v[m] = (...a) => did.push([m, a[0]?.id ?? (typeof a[1] === "string" ? "preset" : null)]);
  const right = 380 - 21, press = (key, x) => { v.press = { x, w: 380, shift: false }; v.onDiffItem(key, cx); };
  press("ca", right - 10); press("ca", right - 46 - 6 - 10); press("ca", right - 46 - 6 - 78 - 6 - 10); press("ca", 40); // Ask, Comment, Cancel, the card's empty part
  press("bhc1", right - 10); press("bhc1", right - 46 - 8 - 10); press("bhc1", 40); // Delete, Edit, the label
  press("ch", right - 10); // the last preset
  assert.deepEqual(did, [["ask", null], ["addComment", null], ["closeAsk", null], ["dropComment", "c1"], ["editComment", "c1"], ["ask", "preset"]]);
  // What is drawn follows the same description as what is hit: every button of a card's row is there, by its id.
  {
    const { panelButtons } = await import("./views.js");
    const ID = { cancel: `pr-cancel-${v.uid}`, comment: `pr-comment-${v.uid}`, ask: `pr-ask-${v.uid}`, "preset:0": `preset-0-${v.uid}`, "preset:1": `preset-1-${v.uid}`, edit: "ce-c1", delete: "cd-c1" };
    const drawnIds = (it) => { S.ids = new Set(); v.diffItem(it, S.theme, "a.py line 3"); const got = S.ids; S.ids = null; return got; };
    for (const editing of [null, { id: "c1" }]) {
      v.editing = editing;
      for (const [it, kind] of [[{ t: "ca", h: 42 }, "ca"], [{ t: "ch", h: 34 }, "ch"], [{ t: "bh", c: at.get(2)[0], h: 24 }, "bh"]]) {
        const want = panelButtons(kind, v.buttonOpts()).list.map((b) => ID[b.key]), got = drawnIds(it);
        assert.deepEqual(want.filter((id) => !got.has(id)), [], `${kind}${editing ? ", editing" : ""}: every button of the description is drawn`);
        assert.deepEqual(Object.values(ID).filter((id) => got.has(id) && !want.includes(id)), [], `${kind}${editing ? ", editing" : ""}: and no button that it does not name`);
      }
    }
    v.editing = null;
  }
  // With Wrap on a press on a wrapped line's second visual line selects that line.
  Map.prototype.set.call(S.store, "review.wrap", true);
  v.rows = Object.assign([{ kind: "+", number: 1, n: 1, text: "x = " + "abcdefgh ".repeat(30) }, { kind: "+", number: 2, n: 2, text: "y = 1" }], { sig: "w2" }); v.sel = null;
  press("r0.2", 200); assert.equal(v.sel, 0); press("r1", 200); assert.equal(v.sel, 1); v.sel = null;
  Map.prototype.set.call(S.store, "review.wrap", false); v.rows = file(60);
  // With a diff shown the list of PRs is not built, and the other way round.
  const ids = (go) => { go(); v.error = null; S.ids = new Set(); S.lists.length = 0; v.render(cx); const got = [...S.ids]; S.ids = null; return got; };
  const diffShown = ids(() => { v.picking = false; }), listShown = ids(() => { v.picking = true; });
  assert.ok(diffShown.some((id) => id.startsWith("pr-files-")) && !diffShown.some((id) => id.startsWith("pr-pick-")), "a diff: its files, no list of PRs");
  assert.ok(listShown.some((id) => id.startsWith("pr-pick-")) && !listShown.some((id) => id.startsWith("pr-files-")), "the list of PRs: no files, no diff");
  v.picking = false;
  // More than 200 files: the first 200 and one line for the rest; the open file is always listed.
  const many = Array.from({ length: 450 }, (_x, k) => ({ path: `src/f${k}.py`, add: 1, del: 0 })), rowsOf = () => { S.ids = new Set(); v.error = null; v.render(cx); const got = [...S.ids]; S.ids = null; return got; };
  const fileIds = (got) => got.filter((id) => /^f-src\//.test(id)).length;
  v.open = "src/f3.py"; v.files = many; let got = rowsOf(); assert.deepEqual([fileIds(got), got.includes(`pr-files-more-${v.uid}`)], [200, true]);
  S.clicks.get(`pr-files-more-${v.uid}`)(null, cx); v.files = many; got = rowsOf(); assert.deepEqual([fileIds(got), got.includes(`pr-files-more-${v.uid}`)], [450, false], "Show 250 more files lists them all");
  v.moreFiles = null; v.open = "src/f300.py"; v.files = many; assert.equal(fileIds(rowsOf()), 450, "the open file is past the 200th: all are listed");
  v.files = [{ path: "a.py", add: 1, del: 0 }]; v.open = "a.py";
  // A file row drags as the file's path in the branch's repo; a deleted file and a row without a checkout do not.
  { const drags = (root) => { v.root = root; v.files = [{ path: "a.py", add: 1, del: 0 }, { path: "gone.py", add: 0, del: 3, status: "deleted" }]; S.drags = []; v.error = null; v.render(cx); const d = S.drags; S.drags = null; return d; };
    const was = v.root; assert.deepEqual([drags("/co/r"), drags(null)], [["/co/r/a.py"], []]); v.root = was; v.files = [{ path: "a.py", add: 1, del: 0 }]; }
  // A line to bring into view: j goes to the next change and asks the list for it; a new file starts at the top.
  const asked = []; v.diffList = { scroll_to_item: (i, how) => asked.push([i, how]) };
  v.comments = []; v.error = null; v.scrollRow = 30; v.sel = null; v.askTop = false; v.render(cx); v.scrollRow = "top"; v.render(cx);
  assert.deepEqual([asked, v.scrollRow], [[[31, "center"], [0, "top"]], null]);
}

// ---- the Worktrees mod's PR marks (shared "worktrees.prs.review"): only with that mod there, written only on a change
{
  const { worktreePrs } = await import("./views.js");
  const now = Date.parse("2026-11-15T12:00:00Z"), pr = (n, state, extra = {}) => ({ url: `https://github.com/o/r/pull/${n}`, repo: "o/r", number: n, state, head: `feat/${n}`, base: "main", headSha: `h${n}`, updatedAt: "2026-11-14T00:00:00Z", ...extra });
  assert.deepEqual(worktreePrs([[pr(2, "open"), pr(1, "merged"), pr(3, "merged", { updatedAt: "2026-09-01T00:00:00Z" }), pr(4, "open", { head: null })], [pr(2, "draft")]], now).map((x) => [x.number, x.state, x.branch]),
    [[1, "merged", "feat/1"], [2, "open", "feat/2"]], "one per URL, sorted; not merged long ago, not without a head branch");
  S.props = {}; S.exec = null; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
  for (const k of ["pr.selected", "pr.sourceBy", "review.open", "worktrees.api", "worktrees.providers", "worktrees.prs.review"]) Map.prototype.set.call(S.store, k, null);
  const file = (prs) => S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: "x", prs }));
  const mine = (n, state = "open") => ({ ...pr(n, state), session: "abcdefgh", at: "2026-11-14" });
  file([mine(7)]);
  const v = new PrReview(); v.init({}, cx); await flush(); v.render(cx); await flush();
  assert.equal(S.store.get("worktrees.prs.review"), null, "without the Worktrees mod nothing is written");
  Map.prototype.set.call(S.store, "worktrees.api", { version: 1 }); reset(); v.render(cx); await flush();
  assert.deepEqual([n.writes, S.store.get("worktrees.providers"), S.store.get("worktrees.prs.review").prs.map((x) => `${x.repo}#${x.number} ${x.branch} ${x.state}`), S.store.get("worktrees.prs.review").run],
    [["worktrees.providers", "worktrees.prs.review"], ["review"], ["o/r#7 feat/7 open"], [["pr-review.want:{repo}#{number}", {}]]], "the mod appears: the provider and its list, once");
  assert.deepEqual([S.store.get("worktrees.prs.review").view, typeof S.store.get("worktrees.prs.review").at], ["all", "number"], "with the view it was made for and when");
  await idle(v, "the same list: renders write nothing");
  reset(); await v.loadPrs(cx); v.publishWorktrees(); assert.deepEqual(n.writes, [], "prs.json read again with the same PRs: nothing written");
  file([mine(7, "merged"), mine(8)]); reset(); await v.loadPrs(cx);
  assert.deepEqual([n.writes, S.store.get("worktrees.prs.review").prs.map((x) => `${x.number} ${x.state}`)], [["worktrees.prs.review"], ["7 merged", "8 open"]], "a changed list is written once");
  // A click on a mark there: pick:<owner/repo#n> picks the PR here, also when the shown source does not list it, and leaves the source alone.
  Map.prototype.set.call(S.store, "pr.source", "review"); v.srcLists.review = { key: "review", prs: [] };
  v.panelCommand("pick:o/r#8", cx); await flush();
  assert.deepEqual([v.prSel?.number, v.sourceNow()], [8, "review"], "the PR is picked, the source stays");
  // The same for a review in progress whose PR no list shows: pick:<number> is the click on its row in "In progress".
  Map.prototype.set.call(S.store, "review.open", [{ ...pr(31, "open"), url: "https://github.com/o/r/pull/31", lastTouched: Date.now(), progress: { comments: 1 }, target: { ...pr(31, "open") } }]);
  v.panelCommand("pick:31", cx); await flush();
  assert.equal(v.prSel?.number, 31, "a review in progress is picked by its number");
  // The click itself is a wish ("want:<ref>", shared "pr.pick"): kept by whichever copy gets it, also the chip's while
  // no panel is there, and taken once by the panel: at once when it is there, else when it appears within a minute.
  v.choose(null, cx); await flush(); reset(); v.panelCommand("want:o/r#7", cx); v.render(cx); await flush();
  assert.deepEqual([v.prSel?.number, S.store.get("pr.pick"), n.writes.filter((k) => k === "pr.pick").length], [7, null, 2], "with the panel there: picked at once, the wish cleared (one write, one clear)");
  S.props = { part: "mini" }; const chip = new PrReview(); chip.init({}, cx); reset();
  chip.wantPick("o/r#8"); chip.wantPick("o/r#8");
  assert.deepEqual([S.store.get("pr.pick")?.ref, n.writes], ["o/r#8", ["pr.pick"]], "no panel: the chip's copy keeps the wish; the same wish twice is one write");
  // (late starts with the Worktrees mod there: init announces before its lists exist, which once threw.)
  S.props = {}; const late = new PrReview(); late.init({}, cx); await flush(); late.render(cx); await flush();
  assert.deepEqual([late.prSel?.number, S.store.get("pr.pick")], [8, null], "the panel appears: it picks that PR and clears the wish");
  Map.prototype.set.call(S.store, "pr.pick", { ref: "o/r#7", at: Date.now() - 120000 }); late.render(cx); await flush();
  assert.deepEqual([late.prSel?.number, S.store.get("pr.pick")], [8, null], "a wish older than a minute is dropped, not carried out");
  // The view shows other contexts and no panel is there: the chip's copy empties the list (as of now), once.
  Map.prototype.set.call(S.store, "worktrees.prs.review", { at: 1, view: "work", run: [], prs: [{ repo: "o/r", branch: "x", number: 1, state: "open" }] });
  S.props = { part: "mini" }; reset(); chip.render(cx); await flush(); chip.render(cx); await flush();
  const wl = S.store.get("worktrees.prs.review");
  assert.deepEqual([n.writes, wl.prs, wl.view, wl.at > 1], [["worktrees.prs.review"], [], "all", true], "a list of another view is emptied with a new time, once");
  S.props = {};
}
// ---- the minimized Explore chip learns that its run has ended (its status file), and reads nothing without a run
{
  S.props = { part: "mini" }; const v = new PrReview(); v.init({}, cx);
  const busy = { id: "x9", topic: "How are reminders sent?", status: "/h/pr-data/explore/x9.json.status", started: Date.now() };
  Map.prototype.set.call(S.store, "review.minimized", { explore: { start: true, root: "/h/repo", busy }, at: 1 });
  S.files.set(busy.status, JSON.stringify({ busy: true })); v.miniPoll(cx); await flush(); assert.equal(v.miniRun ?? null, null, "still going");
  S.files.set(busy.status, JSON.stringify({ error: "Explore: walkthrough: The run was stopped before it answered. Try again." })); v.miniPoll(cx); await flush();
  assert.deepEqual(v.miniRun, { id: "x9", state: "failed" });
  S.files.set(busy.status, JSON.stringify({ done: true })); v.miniRun = null; v.miniPoll(cx); await flush(); assert.deepEqual(v.miniRun, { id: "x9", state: "done" });
  v.render(cx);
  Map.prototype.set.call(S.store, "review.minimized", { explore: { id: "x1", topic: "Loans", root: "/h/repo" }, at: 2 }); v.miniRun = null; v.miniPoll(cx); await flush(); assert.equal(v.miniRun, null, "no run: nothing to read");
  Map.prototype.set.call(S.store, "review.minimized", null); S.props = {};
}

// ---- "Open in <Editor>": which file with which line, the editor by the file's ending and by the kind of project, a PR
// that is not trusted, no link without a checkout or an editor, one process per click and none to find the editors
// (their files are read; a stub stands for `open`), the state "Opening …" and the lock per target.
{
  const EV = await import("./editor-view.js");
  EV.forgetEditors(); S.toasts = [];
  const runs = [], opens = () => runs.filter((r) => r[0] === "open");
  // safegit.py regular-file (a PR that is not trusted): a.py is a regular file of the checkout, link.py is not.
  S.exec = async (cmd, args = []) => { runs.push([cmd, ...args]); if (args[2] === "regular-file") return ["a.py", "s.main.kts"].includes(args[3]) ? { code: 0, stdout: `${args[1]}/${args[3]}`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    return { code: cmd === "open" ? 0 : 1, stdout: "", stderr: "" }; };
  const VS = "/Applications/Visual Studio Code.app", IJ = "/h/Applications/IntelliJ IDEA Ultimate.app";
  for (const app of [VS, IJ]) S.files.set(`${app}/Contents/Info.plist`, "<plist/>");
  const mine = { url: "https://github.com/o/r/pull/3", repo: "o/r", number: 3, title: "t", headSha: "abc", base: "main" }, other = { ...mine, url: "https://github.com/x/y/pull/9", repo: "x/y", number: 9, source: "repo", author: "someone" };
  for (const k of ["pr.selected", "pr.sourceBy", "pr.fromReview", "pr.pick", "editor.choice", "worktrees.api", "review.minimized"]) Map.prototype.set.call(S.store, k, null);
  Map.prototype.set.call(S.store, "review.worktree", { url: mine.url, head: "abc", path: "/co/r" });
  S.files.set("/co/r/pom.xml", "<project/>"); S.files.set("/co/r/.git", "gitdir: /clones/r/.git/worktrees/review\n"); S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [] }));
  S.props = {}; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
  const v = new PrReview(); v.init({}, cx); await flush(); v.prSel = mine; v.context = v.key(); v.open = "src/A.java"; v.rows = [{ kind: "+", number: 12, text: "x" }]; v.sel = 0;
  assert.deepEqual([v.checkoutRoot(), v.editorForeign()], ["/co/r", false], "the checkout the review made for this PR");
  assert.equal(EV.editorLink(v, S.theme, "k", { root: "/co/r" }, cx).length, 0, "before the editors are known: no link");
  await flush(); await flush();
  assert.deepEqual([runs.length, EV.editorFor({ root: "/co/r", file: "src/A.java" }, cx)?.id, EV.editorFor({ root: "/co/r", file: "docs/a.md" }, cx)?.id], [0, "idea", "vscode"], "found by reading files, no process; a file goes by its ending");
  assert.deepEqual([EV.editorFor({ root: "/co/r" }, cx)?.id, EV.editorFor({ root: "/co/plain" }, cx)?.id], ["vscode", "vscode"], "the review's checkout is a linked worktree: its folder opens in VS Code");
  S.files.set("/main/pom.xml", "<project/>"); EV.editorFor({ root: "/main" }, cx); await flush();
  assert.equal(EV.editorFor({ root: "/main" }, cx).id, "idea", "a main checkout with pom.xml: IntelliJ");
  assert.deepEqual([EV.editorLink(v, S.theme, "k", { root: "/co/r" }, cx).length, EV.editorMark({ root: "/co/r", file: "src/A.java", line: 12, where: "in the checkout of this PR" }, cx)],
    [1, { id: "idea", busy: false, text: "IntelliJ ↗", tip: "Open src/A.java at line 12 in IntelliJ IDEA, in the checkout of this PR." }], "the link names the editor, the tooltip the rest");
  assert.equal(EV.editorMark({ root: "/co/r", file: "src/A.java" }, cx, true).text, "IJ ↗", "a row's short form");
  for (let k = 0; k < 10; k++) { v.render(cx); await flush(); }
  assert.equal(opens().length, 0, "frames start no process");
  // The command is the click: one process, the file at that line. The link says "Opening …" and takes no second click.
  v.panelCommand("editor:src/A.java:12", cx); await settle();
  assert.deepEqual(opens(), [["open", `idea://open?file=${encodeURIComponent("/co/r/src/A.java")}&line=12`]], "one process: the file at its line");
  assert.deepEqual([EV.isOpening({ root: "/co/r", file: "src/A.java", line: 12 }), EV.editorMark({ root: "/co/r", file: "src/A.java", line: 12 }, cx).text, EV.isOpening({ root: "/co/r", file: "docs/a.md" })], [true, "Opening IntelliJ …", false], "the lock is this target's");
  v.panelCommand("editor:src/A.java:12", cx); await settle();
  assert.equal(opens().length, 1, "a second click while it opens starts nothing");
  timers.length = 0; runs.length = 0; v.panelCommand("editor:", cx); await settle();
  assert.deepEqual(opens(), [["open", "-a", VS, "/co/r"]], "without a path: the checkout");
  // The ▾ menu's pick: that editor, kept for this project's worktrees in the shared choice, written once.
  runs.length = 0; reset(); v.editorTarget = { root: "/co/r", file: "src/B.java", line: 2, token: "t1" }; v.panelCommand("editor-use:t1:vscode", cx); await settle();
  assert.deepEqual([opens(), S.store.get("editor.choice"), n.writes.filter((k) => k === "editor.choice").length],
    [[["open", "vscode://file/co/r/src/B.java:2"]], { default: null, repos: { "/clones/r/.git": { worktree: "vscode" } } }, 1], "kept under the shared git folder, for its worktrees");
  reset(); v.editorTarget = { root: "/co/r", file: "src/C.java", token: "t2" }; v.panelCommand("editor-use:t2:vscode", cx); await settle();
  assert.equal(n.writes.filter((k) => k === "editor.choice").length, 0, "the same pick again writes nothing");
  assert.equal(EV.editorFor({ root: "/co/r", file: "src/A.java" }, cx).id, "vscode", "and beats the file's ending from now on");
  let copied = null; v.editorTarget = { root: "/co/r", file: "src/A.java", line: 7, token: "t3" }; EV.editorCommand(v, "editor-copy:t3", cx, (x) => { copied = x; });
  assert.equal(copied, "src/A.java:7", "Copy path");
  // A PR from a source that is not trusted: a file alone; not its folder, not a build file, nothing outside the checkout.
  Map.prototype.set.call(S.store, "review.worktree", { url: other.url, head: "h", path: "/co/y" }); v.prSel = other;
  assert.equal(v.editorForeign(), true);
  assert.deepEqual([EV.editorMark({ root: "/co/y", foreign: true }, cx), EV.editorMark({ root: "/co/y", file: "pom.xml", foreign: true }, cx), EV.editorMark({ root: "/co/y", file: "../../etc/passwd" }, cx)], [null, null, null], "no link for its folder, a build file, or a path that leaves the checkout");
  assert.match(EV.editorMark({ root: "/co/y", file: "a.py", line: 5, foreign: true }, cx).tip, /Only the file is opened, not its folder/);
  timers.length = 0; runs.length = 0; S.toasts.length = 0; v.panelCommand("editor:a.py:5", cx); await settle();
  assert.deepEqual(opens(), [["open", "vscode://file/co/y/a.py:5"]], "only the file");
  runs.length = 0; v.panelCommand("editor:", cx); await settle(); v.panelCommand("editor:pom.xml", cx); await settle(); v.panelCommand("editor:../x", cx); await settle();
  assert.deepEqual([opens(), S.toasts.map((t) => t.level)], [[], ["error", "error", "error"]], "none of these starts a process; each says why, as a toast");
  // What the checkout holds at the path decides, not the path's text: a symlink the PR added is not opened.
  runs.length = 0; S.toasts.length = 0; v.panelCommand("editor:link.py", cx); await settle();
  assert.deepEqual([opens(), runs.map((r) => r[3]), S.toasts.map((t) => /not a regular file of its checkout/.test(t.body))], [[], ["regular-file"], [true]]);
  // Its build scripts never go to IntelliJ, also not by a pick in the menu.
  runs.length = 0; S.toasts.length = 0; v.editorTarget = { root: "/co/y", file: "a.py", foreign: true, token: "t5" }; v.panelCommand("editor-use:t5:idea", cx); await settle();
  assert.equal(opens().length, 1, "a source file may go to IntelliJ");
  runs.length = 0;
  assert.match(await EV.openIn({ root: "/co/y", file: "s.main.kts", foreign: true }, "idea"), /IntelliJ IDEA evaluates a build script/);
  assert.deepEqual([await EV.openIn({ root: "/co/y", file: "s.main.kts", foreign: true }), opens()], [null, [["open", "vscode://file/co/y/s.main.kts:1"]]], "by itself it goes to VS Code");
  S.toasts.length = 0;
  // No checkout: nothing to open, and no process.
  Map.prototype.set.call(S.store, "review.worktree", null); runs.length = 0; S.toasts.length = 0; v.panelCommand("editor:a.py:5", cx); await settle();
  assert.deepEqual([v.checkoutRoot(), opens(), S.toasts.length], [null, [], 1]);
  // An editor that could not be started: said once, and the remembered answer is dropped.
  Map.prototype.set.call(S.store, "review.worktree", { url: mine.url, head: "abc", path: "/co/r" }); v.prSel = mine;
  S.exec = async (cmd, args = []) => { runs.push([cmd, ...args]); return { code: 1, stdout: "", stderr: "no such app" }; };
  timers.length = 0; S.toasts.length = 0; v.panelCommand("editor:docs/b.md:1", cx); await settle();
  assert.match(S.toasts[0]?.body ?? "", /VS Code could not be started/);
  // Herdr's cx is valid only inside the call that got it: what is read in the background never uses the render's or a
  // timer's cx afterwards (it asks for the redraw from a task of its own).
  {
    EV.forgetEditors(); S.files.set("/fresh/pom.xml", "<project/>");
    const stale = [], mk = (kind) => { const c = { ...cx, live: true, notify() { if (!c.live) stale.push(kind); }, timer: { after(_ms, fn) { timers.push(() => { const t = mk("timer"); fn(t); t.live = false; }); }, every() {} },
      spawn(fn) { const t = mk("task"); void Promise.resolve().then(() => fn(t)).catch(() => null); } }; return c; };
    const rc = mk("render"); EV.editorFor({ root: "/fresh" }, rc); EV.editorLink(v, S.theme, "k", { root: "/fresh" }, rc); rc.live = false;
    await flush(); await flush();
    assert.deepEqual([stale, EV.editorFor({ root: "/fresh" }, null)?.id], [[], "idea"], "no cx is used after its call; the redraw came from a task");
  }
  // A click on a folder no link has shown yet waits for its files: a Gradle project opens in IntelliJ, not in the
  // editor of a folder of no special kind.
  {
    EV.forgetEditors(); S.files.set("/gradle/build.gradle", "plugins {}"); S.exec = async (cmd, args = []) => { runs.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
    Map.prototype.set.call(S.store, "review.worktree", { url: mine.url, head: "abc", path: "/gradle" }); Map.prototype.set.call(S.store, "editor.choice", null);
    timers.length = 0; runs.length = 0; v.panelCommand("editor:", cx); await settle(); await settle();
    assert.deepEqual(opens(), [["open", "-a", IJ, "/gradle"]], "the kind of project is read before the editor is chosen");
    v.editorTarget = { root: "/wt2", token: "t4" }; S.files.set("/wt2/.git", "gitdir: /clones/z/.git/worktrees/w\n"); v.panelCommand("editor-use:t4:idea", cx); await settle(); await settle();
    assert.deepEqual(S.store.get("editor.choice")?.repos, { "/clones/z/.git": { worktree: "idea" } }, "and a pick for a folder not shown yet lands under its project, as a worktree's");
  }
  // "dryRun": true in the mod's settings (every test home has it): a click starts nothing and keeps what it would
  // have run, also when it comes before the mod read its settings.
  {
    EV.forgetEditors(); S.files.set("/h/pr-review.config.json", JSON.stringify({ dryRun: true })); S.toasts.length = 0;
    timers.length = 0; runs.length = 0; v.panelCommand("editor:build.gradle:4", cx); await settle(); await settle();
    assert.deepEqual([opens(), EV.dryOpened().map((d) => d.argv), S.toasts.map((t) => t.level)], [[], [["open", `idea://open?file=${encodeURIComponent("/gradle/build.gradle")}&line=4`]], ["info"]], "no process; the arguments are kept and said");
    S.files.delete("/h/pr-review.config.json");
    // The same with a file `editor.dry-run` in the Herdr home, which guards every mod of the set at once.
    EV.forgetEditors(); S.files.set("/h/editor.dry-run", ""); timers.length = 0; runs.length = 0; v.panelCommand("editor:", cx); await settle(); await settle();
    assert.deepEqual([opens(), EV.dryOpened().map((d) => d.argv)], [[], [["open", "-a", IJ, "/gradle"]]], "the file alone is enough");
    S.files.delete("/h/editor.dry-run");
  }
  // "None found" is not kept for a day: it may have been a bad moment. Ten minutes later the files are read again;
  // a lookup that failed does not block the next one.
  {
    EV.forgetEditors(); for (const app of [VS, IJ]) S.files.delete(`${app}/Contents/Info.plist`);
    assert.deepEqual(await EV.lookForEditors(), {}); S.files.set(`${VS}/Contents/Info.plist`, "<plist/>");
    assert.deepEqual(await EV.lookForEditors(), {}, "within ten minutes: the answer from before");
    const real = Date.now; Date.now = () => real() + 11 * 60000;
    try { assert.deepEqual(Object.keys(await EV.lookForEditors()), ["vscode"], "after ten minutes: looked again, and found"); } finally { Date.now = real; }
    for (const app of [VS, IJ]) S.files.set(`${app}/Contents/Info.plist`, "<plist/>");
  }
  // No editor installed: no link anywhere.
  EV.forgetEditors(); for (const app of [VS, IJ]) S.files.delete(`${app}/Contents/Info.plist`);
  EV.editorFor({ root: "/co/r" }, cx); await flush(); await flush();
  assert.deepEqual([EV.editorFor({ root: "/co/r" }, cx), EV.editorLink(v, S.theme, "k", { root: "/co/r" }, cx).length], [null, 0]);
  // An editor installed after that: a link's own ask looks again once "none found" is ten minutes old, not only a
  // click in a menu that is not there without a link. And the system need not be known: Linux's launcher script
  // is read like the macOS apps (the setup check that says which system this is may not have run yet).
  { S.files.set("/usr/bin/code", "#!/bin/sh\n");
    EV.editorFor({ root: "/co/r" }, cx); await flush(); await flush();
    assert.equal(EV.editorFor({ root: "/co/r" }, cx), null, "within ten minutes: not asked again");
    const real = Date.now; Date.now = () => real() + 11 * 60000;
    try { EV.editorFor({ root: "/co/r" }, cx); await flush(); await flush(); assert.equal(EV.editorFor({ root: "/co/r" }, cx)?.id, "vscode", "after ten minutes: found, by its command line tool"); }
    finally { Date.now = real; S.files.delete("/usr/bin/code"); } }
  EV.forgetEditors(); S.exec = null; timers.length = 0;
}
// Watched repos: the oldest of more than three is cancelled at once, the others when the copy closes; a cancelled
// watch ends its loop (no new watch for a repo that was let go).
{ S.props = {}; S.cancelled = []; const v = new PrReview(); v.init({}, cx); await settle();
  for (const r of ["/r1", "/r2", "/r3", "/r4"]) { v.watch(r, cx); await settle(); }
  assert.deepEqual(S.cancelled, ["/r1"], "the fourth repo lets the first go");
  assert.deepEqual([...v.watching.keys()], ["/r2", "/r3", "/r4"]);
  await v.close(); await settle();
  assert.deepEqual(S.cancelled.sort(), ["/r1", "/r2", "/r3", "/r4"], "closing lets every watched repo go");
  assert.equal(v.watching.size, 0, "and no loop watches again");
  S.cancelled = null; timers.length = 0;
}
// `herdr-app check` runs init for real: there it starts no task and no timer (so no helper process, no file written),
// and its one frame still draws; a live window does start them.
{ const made = { spawn: 0, timer: 0, exec: 0 }, quiet = { ...base, spawn() { made.spawn++; }, timer: { after() { made.timer++; }, every() { made.timer++; } } };
  S.props = {}; S.exec = async () => { made.exec++; throw new Error("stub"); }; // the stand-in's null is the review; a check has no part
  try {
    S.checking = true; const v = new PrReview(); v.init({}, quiet); await settle();
    assert.deepEqual(made, { spawn: 0, timer: 0, exec: 0 }, "a check: init starts nothing");
    S.errs.length = 0; v.render(base); assert.deepEqual(S.errs, [], "a check: the frame draws");
    S.checking = false; new PrReview().init({}, quiet);
    assert.ok(made.spawn > 0 && made.timer > 0, "a live window: init starts its tasks and its timer");
  } finally { S.checking = false; S.exec = null; }
}
console.log("panel ok");
