// Run: node test_threads.mjs  (threads.js: sent comments as threads, agent replies, GitHub's exact payload, the
// agent preview)
import assert from "node:assert/strict";
import * as TH from "./threads.js";
import { buildReview } from "./pr.js";

// ---- ids: the creation id stays; older comments without one get one from their content, the same every load
const old = { file: "a.py", start: 3, end: 4, old: false, text: "why?" };
assert.equal(TH.commentId(old), TH.commentId({ ...old }));
assert.notEqual(TH.commentId(old), TH.commentId({ ...old, end: 5 }));
assert.equal(TH.commentId({ ...old, id: "lx1" }), "lx1");
assert.deepEqual(TH.withIds([old, { ...old, id: "k" }]).map((c) => c.id), [TH.commentId(old), "k"], "old pending comments still load");

// ---- threads: added once per id, bounded per PR and in PRs
let doc = TH.addThreads({}, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?", hunk: "+x" }], { route: "agent", agent: "PR #7 · main conversation" }, 100);
doc = TH.addThreads(doc, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum nochmal?" }], { route: "agent" }, 200);
assert.equal(TH.threadsOf(doc, "pr1").length, 1);
assert.equal(TH.threadsOf(doc, "pr1")[0].text, "Warum nochmal?");
for (let i = 0; i < 55; i++) doc = TH.addThreads(doc, `p${i}`, [{ id: "x", file: "f", end: 1, text: "t" }], { route: "github" }, 1000 + i);
assert.equal(Object.keys(doc).length, 50);
assert.ok(!doc.pr1 && doc.p54);

// ---- replies: parsed per id in file order, merged into the thread; follow-ups between them; fixed folds
const text = ['{"id": "c1", "reply": "Weil X.", "status": "answered"}', "{half", '{"id": "c1", "reply": "Behoben.", "status": "fixed", "commit": "abc1234def"}',
  '{"id": "c2", "reply": "", "status": "fixed"}', '{"id": "c3", "reply": "ok", "status": "weird"}'].join("\n");
const rep = TH.parseReplies(text);
assert.deepEqual(Object.keys(rep), ["c1", "c3"]);
assert.equal(rep.c3[0].status, "answered");
let d = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], { route: "agent" }, 1);
d = TH.addFollowup(d, "pr", "c1", "Und Y?", 1, 2);
const th = TH.threadsOf(d, "pr")[0];
const v = TH.threadView(th, rep.c1);
assert.deepEqual(v.entries.map((e) => [e.who, e.text]), [["agent", "Weil X."], ["you", "Und Y?"], ["agent", "Behoben."]]);
assert.equal(v.status, "fixed");
assert.equal(v.fixedIn, "abc1234def");
assert.equal(v.collapsed, true, "a fixed thread folds to one line");
assert.equal(TH.threadView(th, rep.c1, [], true).collapsed, false, "and opens");
assert.equal(TH.threadView(th, []).status, "sent");
assert.equal(TH.threadView({ ...th, route: "github" }, []).status, "posted");
const gh = [{ id: 9, in_reply_to_id: 5, user: "anna", body: "Seh ich auch so", at: "2026-11-10T10:00:00Z" }, { id: 5, user: "me", body: "root" }];
assert.deepEqual(TH.threadView({ ...th, followups: [], ghId: 5 }, [], TH.ghRepliesTo(gh, 5)).entries.map((e) => e.who), ["anna"], "GitHub replies in the thread");
assert.deepEqual(TH.threadCounts([th, { id: "zz" }], rep, gh), { threads: 2, replies: 2, fixed: 1 });

// ---- the agent: ids and the replies contract in the prompt; the preview sends exactly what it shows
const prompt = buildReview({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], lang: "German", replies: "/x/replies/p.jsonl", contract: TH.repliesContract });
assert.ok(prompt.includes("[c1] `a.py` lines 3–4"));
assert.ok(prompt.includes(`echo '{"id": "c1", "reply": "briefly, what you did or your answer", "status": "fixed", "commit": "<sha>"}' >> /x/replies/p.jsonl`));
assert.ok(!buildReview({ pr: null, base: "main", comments: [{ file: "a", text: "t" }] }).includes(">>"), "the panel's prompt stays without a contract");
const up = TH.followupPrompt({ pr: { number: 7, title: "T" }, thread: th, replies: rep.c1, text: "Und Z?", file: "/x/r.jsonl", lang: "English" });
assert.ok(up.includes("[c1]") && up.includes("You: Weil X.") && up.includes("Reviewer: Und Z?") && up.includes(">> /x/r.jsonl"));
const pv = TH.preview({ what: "Comment", agent: "PR #7 · main conversation", own: "Warum?", prompt });
assert.equal(TH.confirm(pv).text, prompt, "unedited: exactly the preview's text");
assert.equal(TH.confirm(pv, "edited").text, "edited", "edited: exactly the edit");
assert.equal(TH.agentLabel({ tab_name: "PR #7" }, "x"), "PR #7 · main conversation");
assert.ok(TH.agentLabel({ tab_name: "Sub", parent: "t1" }, "x").includes("sub-agent"));
assert.equal(TH.agentLabel(null, "a new Claude tab"), "a new Claude tab");

// ---- GitHub: exactly the ticked items with their edited text; nothing else
const lines = new Map([["a.py", new Set(["R3", "R4", "R10"])]]);
const comments = [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum? (edited)" }, { id: "c2", file: "a.py", start: 10, end: 10, text: "Typo" },
  { id: "c3", file: "b.py", start: 1, end: 1, text: "outside" }];
let plan = TH.ghPlan({ comments, off: new Set(["c2"]), summary: "Overall", summaryOn: true, event: "comment", commit: "h", lines, repo: "acme/x#7" });
assert.deepEqual(plan.payload.comments.map((c) => c.body), ["Warum? (edited)"]);
assert.ok(plan.payload.body.includes("Overall") && plan.payload.body.includes("outside"), "out-of-diff notes go into the body when ticked");
assert.equal(plan.label, "Post 1 comment and a review body");
assert.equal(TH.ghPlan({ comments, summary: "", event: "approve", commit: "h", lines, repo: "acme/x#7", login: "saefty" }).target, "as saefty · acme/x#7 · Approve");
assert.equal(TH.ghPlan({ comments: [], summary: "  ", summaryOn: true, event: "comment", commit: "h", lines }).ready, false, "an empty body is not posted");
plan = TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summary: "Overall", summaryOn: false, event: "comment", commit: "h", lines });
assert.equal(plan.ready, false, "nothing ticked and no body: Submit is off");
assert.equal(TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summaryOn: false, event: "approve", commit: "h", lines }).ready, true, "a verdict alone posts");
const finding = { id: "f1", file: "a.py", line: 3, title: "SQL injection", detail: "…" }, suggestion = { key: "s1", path: "a.py", line: 4, reason: "AI says" };
plan = TH.ghPlan({ comments, summary: "", event: "comment", commit: "h", lines });
assert.ok(!JSON.stringify(plan.payload).includes(finding.title) && !JSON.stringify(plan.payload).includes(suggestion.reason), "findings and AI suggestions never ride along");
plan = TH.ghPlan({ comments: [...comments, { id: "f1c", file: "a.py", start: 3, end: 3, text: `${finding.title}: ${finding.detail}`, from: "security" }], summary: "", event: "comment", commit: "h", lines });
assert.ok(plan.payload.comments.some((c) => c.body.startsWith("SQL injection")), "unless added as a comment");
assert.deepEqual(TH.singlePayload(comments[0], "h", true), { commit_id: "h", path: "a.py", line: 4, side: "RIGHT", start_line: 3, start_side: "RIGHT", body: "Warum? (edited)" });
assert.equal(TH.singlePayload(comments[2], "h", false), null);
assert.equal(TH.postedItems(plan.payload)[1], "a.py:3–4: Warum? (edited)");

// ---- Fix: selection, jobs, the sub-agent's launch, Apply only on a clean checkout
let fx = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", end: 3, text: "t" }], { route: "agent" }, 1);
fx = TH.toggleSelected(fx, "pr", "c1", 2);
fx = TH.toggleSelected(fx, "pr", "p9", 3);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"]);
assert.equal(TH.threadsOf(fx, "pr").length, 1, "the selection keeps the threads");
assert.deepEqual(TH.selectedOf(TH.toggleSelected(fx, "pr", "c1", 4), "pr"), ["p9"]);
assert.deepEqual(TH.selectedOf(JSON.parse(JSON.stringify(fx)), "pr"), ["c1", "p9"], "it persists with the threads");
fx = TH.addThreads(fx, "pr", [{ id: "c2", file: "b.py", end: 1, text: "u" }], { route: "agent" }, 5);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"], "adding threads keeps the selection");
assert.equal(TH.fixBranch(7, ["mwb8736v"]), "fix/7-mwb8736v");
assert.equal(TH.fixBranch(7, ["a", "b", "c"]), "fix/7-a-and-2");
// Worktrees go to Herdr's folder for them: settings.json's worktrees.directory (absolute, ~ or ~/…), else ~/.herdr/worktrees.
assert.equal(TH.fixPath(TH.worktreesDir(null, "/h"), "acme/bookshelf", "fix/7-a"), "/h/.herdr/worktrees/bookshelf/fix-7-a");
assert.equal(TH.fixPath(TH.worktreesDir('{"worktrees":{"directory":"~/Developer/worktrees/"}}', "/h"), "acme/bookshelf", "fix/7-a"), "/h/Developer/worktrees/bookshelf/fix-7-a");
assert.deepEqual(['{"worktrees":{"directory":"/srv/wt"}}', '{"worktrees":{"directory":"~"}}', '{"worktrees":{"directory":"relative/wt"}}', '{"worktrees":{"directory":7}}', '{"zoom":1}', "{ broken"].map((x) => TH.worktreesDir(x, "/h")),
  ["/srv/wt", "/h", "/h/.herdr/worktrees", "/h/.herdr/worktrees", "/h/.herdr/worktrees", "/h/.herdr/worktrees"]);
const job = { id: "j1", branch: "fix/7-c1", path: "/w", base: "/repo", head: "abc", items: [{ kind: "comment", id: "c1" }, { kind: "finding", id: "f1" }], target: "sub", state: "running" };
fx = TH.addFix(fx, "pr", job, 6);
assert.equal(TH.fixFor(fx, "pr", "f1").id, "j1");
assert.equal(TH.fixFor(TH.setFix(fx, "pr", "j1", { state: "applied" }, 7), "pr", "f1"), null, "an applied job is no longer live");
assert.equal(TH.fixCommit(job, {}, {}), null);
assert.equal(TH.fixCommit(job, { c1: [{ status: "answered" }, { status: "fixed", commit: "beef" }] }, {}), "beef", "a comment reply with the commit");
assert.equal(TH.fixCommit(job, {}, { f1: { status: "fixed", commit: "cafe" } }), "cafe", "a finding report with the commit");
const args = TH.subAgentArgs({ parent: "t3", cwd: "/w", name: "fix-j1", env: ["env", "CLAUDE_CONFIG_DIR=/c"], task: "Fix it", job: "j1", auto: true, model: "opus" });
assert.equal(args[args.indexOf("--model") + 1], "opus", "the review's model, said outright");
assert.equal((a => a[a.indexOf("--model") + 1])(TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" })), "sonnet", "never the account's default");
assert.deepEqual(args.slice(0, 2), ["run", "--bg"]);
assert.ok(args.includes("--no-notify"), "nothing typed into the parent");
assert.equal(args[args.indexOf("--parent") + 1], "t3", "a sub-agent of the PR's agent");
assert.equal(args[args.indexOf("--cwd") + 1], "/w", "in its own worktree");
assert.deepEqual(args.slice(args.indexOf("--") + 1, args.indexOf("claude") + 1), [...TH.NO_PUSH_ENV, "env", "CLAUDE_CONFIG_DIR=/c", "claude"], "its git cannot push, on the PR's context");
assert.deepEqual(args.slice(args.indexOf("--permission-mode")), ["--permission-mode", "auto", "Fix it"], "in auto mode");
assert.ok(TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" }).includes("--no-parent"));
assert.deepEqual(args.slice(args.indexOf("--strict-mcp-config"), args.indexOf("--strict-mcp-config") + 3), ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], "no MCP server of the context");
assert.ok(args.indexOf("--strict-mcp-config") < args.indexOf("--disallowedTools"), "before the deny list, which takes any number of values");
const untrusted = TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" });
assert.deepEqual(untrusted.slice(untrusted.indexOf("--permission-mode")), ["--permission-mode", "manual", "--setting-sources", "user", "x"], "an untrusted PR: manual, said outright, without the checkout's settings");
assert.equal(TH.applyPlan({ status: " M src/a.ts\n?? x", head: "abc", branch: "fix/7-c1" }).ok, false, "a dirty checkout: refused");
assert.match(TH.applyPlan({ status: " M a\n", head: "abc", branch: "b" }).reason, /1 uncommitted change/);
assert.deepEqual(TH.applyPlan({ status: "", head: "abc", branch: "fix/7-c1" }), { ok: true, args: ["cherry-pick", "abc..fix/7-c1"] });
assert.ok(TH.applyPrompt(job).includes("git cherry-pick abc..fix/7-c1"));
// The fix branch starts at the PR head, also when the local clone has another branch checked out; a space's own branch
// diff starts at its checkout. Apply refuses a checkout that does not contain that start.
assert.equal(TH.fixStart({ prHead: "pr1", checkoutHead: "other" }), "pr1", "the PR head, not the clone's HEAD");
assert.equal(TH.fixStart({ local: true, prHead: "pushed", checkoutHead: "here" }), "here", "a branch diff: its checkout");
assert.equal(TH.fixStart({ prHead: null, checkoutHead: "here" }), "here", "no PR head known: the checkout");
const off = TH.applyPlan({ status: "", head: "abcdef0123", branch: "fix/7-c1", onHead: false, where: "feat/other" });
assert.equal(off.ok, false); assert.equal(off.off, true);
assert.match(off.reason, /on feat\/other.*abcdef0.*git cherry-pick abcdef0\.\.fix\/7-c1/);
// A fix is checked on its own branch once the agent reports a commit; the verdict stays next to the finding and never
// makes it "fixed", which needs the fix in the PR head.
{
  const fjob = { id: "j9", branch: "fix/7-f1", path: "/w", head: "abc", items: [{ kind: "finding", id: "f1" }], target: "sub", state: "running" };
  const fs = [{ id: "f1", ids: ["f1", "s1"] }, { id: "f2", ids: ["f2"] }], st = { f1: { s: "progress", fixHead: "abc" } }, open = () => "progress";
  assert.deepEqual(TH.branchChecks(fs, [fjob], st, {}, open), [], "no report yet");
  assert.deepEqual(TH.branchChecks(fs, [fjob], st, { f1: { status: "wontfix", note: "no" } }, open), [], "declined");
  const checks = TH.branchChecks(fs, [fjob], st, { f1: { status: "fixed", commit: "cafe1234" } }, open);
  assert.deepEqual(checks.map((c) => [c.f.id, c.job.id, c.commit]), [["f1", "j9", "cafe1234"]]);
  assert.deepEqual(TH.branchChecks(fs, [{ ...fjob, state: "applied" }], st, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "applied: the PR head is checked instead");
  assert.deepEqual(TH.branchChecks(fs, [{ ...fjob, target: "main", path: undefined }], st, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "the main agent has no fix branch");
  const after = TH.applyBranchChecks(st, [{ id: "f1", verdict: "fixed", reason: "the guard is there" }, { id: "zz", verdict: "fixed" }], checks, 0);
  assert.equal(after.f1.s, "progress", "still Fix sent");
  assert.deepEqual(after.f1.verify, { result: "fixed", reason: "the guard is there", head: "cafe1234", branch: "fix/7-f1", at: "1970-01-01T00:00:00.000Z" });
  assert.equal(after.zz, undefined);
  assert.deepEqual(TH.branchChecks(fs, [fjob], after, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "checked at this commit already");
  assert.equal(TH.branchChecks(fs, [fjob], after, { f1: { status: "fixed", commit: "beef5678" } }, open).length, 1, "a newer commit is checked again");
  assert.equal(TH.checkText(after.f1.verify), "Verified on the fix branch, not in the PR yet (fix/7-f1 at cafe123): the guard is there");
  assert.equal(TH.checkText(after.f1.verify, true), "verified on the fix branch, not in the PR yet");
  assert.equal(TH.checkText({ result: "not_fixed", reason: "", head: "cafe1234", branch: "fix/7-f1" }), "Not fixed on the fix branch (fix/7-f1 at cafe123).");
  assert.equal(TH.checkText({ result: "fixed", reason: "ok", head: "0123456789" }), "Verified at 0123456: fixed, ok", "on the PR head, as before");
  assert.equal(TH.checkText(null, true), "not verified");
}
// A fix agent cannot push: deny rules before the permission mode, the task last.
assert.deepEqual(args.slice(args.indexOf("claude") + 1, args.indexOf("--permission-mode")), ["--model", "opus", ...TH.NO_MCP, "--disallowedTools", ...TH.NO_PUSH]);
assert.ok(TH.NO_PUSH.includes("Bash(hc send *)"), "no hand-over to another session by itself");
assert.ok(TH.NO_PUSH.includes("Bash(git push *)") && untrusted.includes("Bash(git push *)") && untrusted.at(-1) === "x");
// The target choice: the sub-agent's text names its worktree, the main agent's doesn't; the preview sends that text.
const sub = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl", branch: "fix/7-c1", path: "/w" });
const main = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl" });
assert.ok(sub.includes("own git worktree /w on branch fix/7-c1") && sub.includes("[c1]") && sub.includes(">> /r.jsonl"));
assert.ok(!main.includes("worktree") && main.includes("[c1]"));
assert.equal(TH.confirm(TH.preview({ what: "Fix", agent: "x", prompt: sub })).text, sub);
assert.ok(!sub.includes("hc send") && sub.includes("until the reviewer applies it") && sub.includes("never push") && sub.includes("do not hand the fix to another agent"), "it stops after the commit: no push, no hand-over");
assert.ok(!main.includes("hc send"), "the main agent itself: nothing to hand on");
// A live PR agent changes nothing about that: no hand-over step, whoever runs.
assert.equal(TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl", branch: "fix/7-c1", path: "/w", head: "abc", main: "t3" }), sub);
assert.equal(TH.handoffNote, undefined); assert.equal(TH.startNotice, undefined);
assert.ok(TH.applyPrompt(job).includes("push to the PR branch") && TH.applyPrompt(job).includes("git worktree remove"), "Hand over…: the same take-over");
console.log("threads ok");
// ---- the Comments tab: rows, summary, filters
{
  const rows = TH.commentRows({ pending: [{ id: "p1", file: "b.py", end: 4, text: "p" }, { id: "p2", file: "a.py", end: 9, text: "ai", from: "ki" }],
    threads: [{ id: "t1", file: "a.py", end: 2, text: "w" }, { id: "t2", file: "a.py", end: 5, text: "f" }, { id: "t3", file: "c.py", end: 1, text: "r", ghId: 7, route: "github" }],
    replies: { t2: [{ status: "fixed", commit: "c" }] }, gh: [{ id: 8, in_reply_to_id: 7, body: "ok" }, { id: 9, path: "a.py", line: 1, body: "theirs", user: "anna" }],
    ghOwn: (g) => g.id === 7 || g.in_reply_to_id === 7, notes: [{ id: "n1", anchor: { file: "a.py", end: 3 }, summary: "note" }, { id: "n2", anchor: { node: "x" }, summary: "card" }] });
  assert.deepEqual(rows.map((r) => `${r.file}:${r.line}:${r.state}`), ["a.py:1:github", "a.py:2:waiting", "a.py:3:note", "a.py:5:fixed", "a.py:9:pending", "b.py:4:pending", "c.py:1:replied"], "by file and line");
  assert.equal(rows.find((r) => r.id === "t3").replies, 1, "a GitHub reply counts");
  assert.equal(TH.commentSummary(rows), "5 comments · 2 pending · 1 sent to an agent · 1 replied · 1 reported fixed");
  const show = TH.showOf({ github: false });
  assert.deepEqual(show, { mine: true, ai: true, agents: true, github: false, notes: true });
  assert.deepEqual(TH.filterRows(rows, "all", show).map((r) => r.id), ["t1", "n1", "t2", "p2", "p1", "t3"], "GitHub hidden");
  assert.deepEqual(TH.filterRows(rows, "pending", TH.showOf({ ai: false })).map((r) => r.id), ["p2", "p1"], "a comment taken from an AI note is yours: the Findings switch leaves it");
  assert.deepEqual(TH.showCounts({ rows, findings: 3, agents: 2 }), { mine: 5, ai: 3, agents: 2, github: 1, notes: 1 }, "Findings shows the findings' own count");
  assert.equal(TH.SHOW_KINDS.find(([k]) => k === "ai")[1], "Findings");
  console.log("comments tab ok");
}
// ---- GitHub: resolved threads, bots by their latest reviewed commit, outdated comments; STALE on own rows
{
  const g = (id, user, at, commit, extra = {}) => ({ id, path: "a.py", line: id, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at, commit_id: commit, body: `b${id}`, ...extra });
  const gh = [g(1, "anna", "2024-01-01", "c1"), g(2, "anna", "2024-01-01", "c1", { in_reply_to_id: 1 }),
    g(3, "lint[bot]", "2024-01-02", "c1"), g(4, "lint[bot]", "2024-01-02", "c1"), g(5, "anna", "2024-01-03", "c1", { in_reply_to_id: 3 }),
    g(6, "lint[bot]", "2024-01-05", "c2"), g(7, "ci", "2024-01-01", "c0", { user_type: "Bot" }), g(8, "anna", "2024-01-09", "c0")];
  const st = TH.withThreadState(gh, [{ id: 1, resolved: true, outdated: false }, { id: 6, resolved: false, outdated: true }, { id: null, resolved: true }]);
  assert.deepEqual(st.filter((x) => x.resolved).map((x) => x.id), [1, 2], "a resolved thread: its first comment and its replies");
  assert.equal(st.find((x) => x.id === 6).outdated, true);
  assert.ok(TH.isBot(gh[2]) && TH.isBot(gh[6]) && !TH.isBot(gh[0]));
  const { kept, hidden } = TH.latestBotComments(st);
  assert.deepEqual(kept.map((x) => x.id), [1, 2, 6, 7, 8], "lint[bot]'s comments on c1 go with the reply to them; ci keeps its only commit; people stay");
  assert.equal(hidden, 3);
  assert.deepEqual(TH.ghShown(st), { list: kept.filter((x) => !x.resolved), resolved: 1, botsHidden: 3 }, "by default: no resolved threads, no older bot comments");
  assert.deepEqual(TH.ghShown(st, { resolved: true, allBots: true }).list.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Outdated (line null) and STALE rows.
  const rows = TH.commentRows({ pending: [{ id: "p1", file: "a.py", end: 2, text: "p" }], gh: [{ id: 9, path: "a.py", line: null, original_line: 4, outdated: true, resolved: true, body: "old" }],
    notes: [{ id: "n1", anchor: { file: "a.py", end: 3 }, summary: "n" }], stale: (id) => id === "p1" || id === "n1" });
  assert.deepEqual(rows.map((r) => [r.id, r.line, Boolean(r.stale), Boolean(r.outdated), Boolean(r.resolved)]), [["p1", 2, true, false, false], ["n1", 3, true, false, false], ["gh9", 4, false, true, true]]);
  // Threads keep what the lines read when written.
  const d2 = TH.addThreads({}, "k", [{ id: "c9", file: "a.py", start: 1, end: 1, text: "x", code: "line", head: "h1" }], { route: "agent" }, 1);
  assert.deepEqual([TH.threadsOf(d2, "k")[0].code, TH.threadsOf(d2, "k")[0].head], ["line", "h1"]);
  console.log("github comments ok");
}

// The send preview's facts: a sub-agent's account, rights and the push ban; a live session is not ours to limit.
{
  const sub = Object.fromEntries(TH.sendFacts({ kind: "sub", account: "Claude Code (Anthropic) · account in ~/.claude", trusted: true, branch: "fix/7-f1" }));
  assert.equal(sub["Runs as"], "Claude Code (Anthropic) · account in ~/.claude");
  assert.equal(Object.fromEntries(TH.sendFacts({ kind: "new", account: "acct", model: "Sonnet" }))["Runs as"], "acct · Sonnet", "the model a new agent runs on");
  assert.match(sub.May, /auto mode/); assert.match(sub.Push, /^Not through git push: every remote of the checkout, also one with a push URL of its own.*checked before the agent starts.*Not covered: what the agent sets against it on purpose \(a push URL of its own.*a cleared environment\), git send-pack inside a script, or a push through the GitHub API.*auto mode may run/);
  assert.doesNotMatch(sub.Push, /anywhere/, "it names what it covers and what not"); assert.match(sub.Result, /fix\/7-f1.*Nothing reaches the PR until you apply it/);
  assert.equal(sub.Starts, undefined, "the choice above says where it starts");
  assert.match(Object.fromEntries(TH.sendFacts({ kind: "sub", account: "a", trusted: false })).May, /someone else's PR.*asks before every edit/);
  const main = Object.fromEntries(TH.sendFacts({ kind: "main", account: "a", name: "PR #7" }));
  assert.match(main["Runs as"], /^PR #7, on its own account/); assert.match(main.Push, /^Possible/);
  const live = Object.fromEntries(TH.sendFacts({ kind: "live", account: "a", name: "PR #7", chat: true }));
  assert.match(live.Starts, /^Nothing new.*chat box of PR #7 as a draft/);
  assert.match(Object.fromEntries(TH.sendFacts({ kind: "new", account: "a", where: "/w" })).Starts, /new agent in a new tab.*\(\/w\)/);
  // Finish your review: a suggestion from the findings, and the blockers as a body (security: the title only).
  assert.deepEqual(TH.suggestVerdict({ unresolved: 3, high: 1 }), { event: "request_changes", why: "1 unresolved finding is of high severity" });
  assert.equal(TH.suggestVerdict({ unresolved: 2, high: 0 }).event, "comment");
  assert.equal(TH.suggestVerdict({ unresolved: 0, high: 0 }), null, "nothing unresolved: no suggestion, an approval is the reviewer's call");
  assert.equal(TH.verdictOf(null, { unresolved: 3, high: 1 }), null, "an unresolved high finding: nothing chosen, Submit waits");
  assert.equal(TH.verdictOf("approve", { unresolved: 3, high: 1 }), "approve", "the reviewer's pick goes first");
  assert.equal(TH.verdictOf(null, { unresolved: 2, high: 0 }), "comment", "no high finding: Comment as before");
  assert.equal(TH.verdictOf(null, null), "comment");
  assert.match(TH.ghPlan({ comments: [], event: null, commit: "c", lines: new Map() }).target, /no verdict chosen yet$/);
  assert.equal(TH.blockersDraft([{ severity: "high", title: "Mails twice", file: "a.py", line: 3 }, { severity: "high", security: true, title: "Empty token passes", file: "h.py", line: 8 }, { severity: "medium", title: "m", file: "b", line: 1 }]),
    "2 findings need a change before this can merge.\n\n- `a.py:3`: Mails twice\n- Security: Empty token passes");
  assert.match(TH.blockersDraft([{ severity: "high", title: "T", file: "a.py", line: 3 }]), /^1 finding needs a change before this can merge\./);
  assert.match(TH.blockersDraft([{ severity: "high", security: true, threats: ["t2"], impact: "degraded_operation", title: "One limit", file: "t.tf", line: 4 }]), /- `t\.tf:4`: One limit$/, "⛨ only through a threat: named with its place like any finding");
  assert.equal(TH.blockersDraft([{ severity: "low", title: "x" }]), "");
  // The reviewers popup: a zero is put in relation, one finding is singular, a failure and "not run" are their own words.
  assert.equal(TH.runLine({ state: "done", count: 0, cost: 0.0886 }, 16, { took: "0:40", ago: "34 min ago" }), "No findings. It reviews on its own; the other sources have 16 · $0.089 · 0:40 · 34 min ago");
  assert.equal(TH.runLine({ state: "done", count: 1 }), "1 finding");
  assert.equal(TH.runLine({ state: "done", count: 2, cost: 0.12 }), "2 findings · $0.120");
  assert.equal(TH.runLine({ state: "failed", error: "no JSON" }), "Failed: no JSON");
  assert.equal(TH.runLine(undefined), "Not run on this PR yet");
  assert.equal(TH.runLine({ state: "running", auto: "template.yaml changes IAM policies or permissions" }, 0, { running: "0:12" }), "Running · 0:12 · Started by itself: template.yaml changes IAM policies or permissions");
  assert.equal(TH.runLine({ state: "done", count: 2, auto: "a.py touches auth or token code" }), "2 findings · Started by itself: a.py touches auth or token code");
  assert.equal(TH.runLine({ state: "running" }, 0, { running: "0:12" }), "Running · 0:12");
  console.log("preview, verdict and runs ok");
}

// A finding as a review comment: the title bold, the detail and the suggestion as their own paragraphs, Markdown kept,
// a suggested code block folded, no labels of a bot.
{
  const f = { severity: "high", category: "bug", reviewer: "claude", file: "a.py", line: 3, title: "publish_overdue raises for every overdue loan",
    detail: "`status_of` already returns OVERDUE.\n\nSo two things happen:\n\n- the move raises\n- the loan is never marked",
    suggestion: "Guard the move:\n\n```py\nif status_of(loan, day) is not Status.OVERDUE:\n    move(loan)\n```" };
  const text = TH.findingCommentText(f);
  assert.equal(text, "**publish_overdue raises for every overdue loan**\n\n`status_of` already returns OVERDUE.\n\nSo two things happen:\n\n- the move raises\n- the loan is never marked\n\n"
    + "<details><summary>Suggested fix</summary>\n\nGuard the move:\n\n```py\nif status_of(loan, day) is not Status.OVERDUE:\n    move(loan)\n```\n\n</details>");
  assert.ok(!/high|bug|claude|a\.py/.test(text), "no severity, category, source or place in the text");
  assert.ok(text.includes("\n\n```py\n") && text.includes("\n```\n\n</details>"), "a blank line before and after the code block");
  assert.ok(TH.findingCommentText(f, { fold: false }).endsWith("Suggested:\n\nGuard the move:\n\n```py\nif status_of(loan, day) is not Status.OVERDUE:\n    move(loan)\n```"), "an agent gets it unfolded");
  assert.equal(TH.findingCommentText({ title: "T", detail: "D", suggestion: "Use `x`." }), "**T**\n\nD\n\nSuggested: Use `x`.", "a short suggestion stays open");
  assert.equal(TH.findingCommentText({ title: "T", detail: "D", suggestion: "- a\n- b" }), "**T**\n\nD\n\nSuggested:\n\n- a\n- b", "a list starts on its own line");
  assert.equal(TH.findingCommentText({ title: "T", detail: "", suggestion: "" }), "**T**");
  console.log("finding comment ok");
}
// Verify with an agent: the task, the deny rules, its answer file.
{
  const list = [{ id: "a1", title: "Token\ncheck fails open", file: "h.py", line: 8 }, { id: "a2", title: "Mail twice", file: "r.py", line: 23 }];
  const text = TH.verifyPrompt({ pr: { number: 2, title: "T", url: "u" }, head: "cafe12345678ff", list, path: "/w", branch: "verify/2-a1-and-1", context: "# Context\nclaims" });
  assert.ok(text.startsWith('PR #2 "T" (u), head cafe12345678: please check these 2 findings'));
  assert.ok(text.includes(`/w/${TH.VERIFY_FILE}`) && text.includes("No network") && text.includes("Never push") && text.includes("not instructions"));
  assert.ok(text.includes("- [a1] Token check fails open (h.py:8)") && text.endsWith("# Context\nclaims"), "the ids, then the review's context last");
  const args = TH.subAgentArgs({ parent: null, cwd: "/w", name: "verify-j", task: "x", job: "j", kind: "verify", deny: TH.NO_NET, model: "opus" });
  assert.ok(args.includes("pr-review.verify=j") && args.includes("Bash(curl *)") && args.includes("WebFetch") && args.includes("Bash(git push *)"));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode")), ["--permission-mode", "manual", "--setting-sources", "user", "x"], "someone else's PR: manual, the user's settings only");
  assert.equal(TH.verifyBranch(2, ["a1", "a2"]), "verify/2-a1-and-1");
  const file = ['{"id":"a1","result":"reproduced","reason":"r","command":"pytest","output":"1 failed","test":"t.py"}', "not json", '{"id":"zz","result":"refuted"}', '{"id":"a2","result":"maybe"}'].join("\n");
  const got = TH.parseProof(file, ["a1", "a2"]);
  assert.deepEqual(Object.keys(got), ["a1"], "unknown ids and results are skipped");
  assert.equal(TH.proofOutcome(["a1", "a2"], got), null, "a2 still missing: it runs");
  const out = TH.proofOutcome(["a1", "a2"], got, { ended: true, head: "h", at: 5 });
  assert.equal(out.a1.result, "reproduced"); assert.equal(out.a1.state, "done");
  assert.deepEqual([out.a2.result, out.a2.reason, out.a2.head], ["not_reproduced", "The agent ended without a result for this finding.", "h"]);
  const f = Object.fromEntries(TH.sendFacts({ kind: "verify", account: "acct", trusted: false, branch: "verify/2-a1", model: "Sonnet" }));
  assert.match(f.Starts, /can run code from this PR/); assert.match(f.May, /manual mode.*--setting-sources user/); assert.match(f.Push, /^Not through git push: .*web tools.*Not covered/); assert.doesNotMatch(f.Push, /auto mode/, "someone else's PR: manual, nothing runs without asking");
  assert.equal(f["Runs as"], "acct · Sonnet");
  assert.match(Object.fromEntries(TH.sendFacts({ kind: "verify", account: "a", trusted: true })).May, /auto mode.*runs the PR's code/);
  console.log("verify agent ok");
}

{
  // The probe agent: settings files ignored, no shell at all, everything not listed refused without asking; it may
  // write only its one script and its answer; no MCP, no network.
  const args = TH.probeArgs({ parent: null, cwd: "/w/probe-2-p1-x", name: "probe-x", task: "TASK", job: "j1", id: "p1" });
  const after = args.slice(args.indexOf("claude"));
  for (const x of ["--restricted", "--strict-mcp-config", "Write(//w/probe-2-p1-x/.pr-review-probe/p1.py)", "Edit(//w/probe-2-p1-x/.pr-review-probe/p1.py)", "Write(//w/probe-2-p1-x/.pr-review-verify.jsonl)", "WebFetch", "Bash(curl *)"]) assert.ok(after.includes(x), x);
  assert.deepEqual(after.slice(after.indexOf("--tools"), after.indexOf("--tools") + 2), ["--tools", "Read,Grep,Glob,Write,Edit"], "no Bash among the tools");
  assert.ok(!after.slice(after.indexOf("--allowedTools"), after.indexOf("--disallowedTools")).some((x) => x.startsWith("Bash")), "no command is allowed");
  assert.deepEqual(after.slice(-3), ["--permission-mode", "dontAsk", "TASK"], "the task is the last argument, after an option that ends the deny list");
  // One branch per start: an old branch of the same probe is never met again.
  assert.equal(TH.probeBranch(2, "race_1", "k3f9a"), "probe/2-race_1-k3f9a");
  assert.throws(() => TH.probeBranch(2, "race/../x y", "k3f9a"), /Probe refused/, "an id outside the rule is refused, never rewritten");
  assert.notEqual(TH.probeBranch(2, "p1"), TH.probeBranch(2, "p1", "other"));
  // The task: the claim, that the review runs the script (no command for the agent), the rules, the answer line.
  const task = TH.probePrompt({ pr: { number: 2, title: "t" }, head: "abcdef123456789", probe: { id: "p1", claim: "Two mails\nper loan", kind: "idempotency", at: "a.py:3" }, path: "/w/x", context: "CTX" });
  for (const x of ["Claim [p1] (idempotency, a.py:3): Two mails per loan", "/w/x/.pr-review-probe/p1.py", "You do not run it", "never time.sleep", "threading.Barrier", "inspect.signature", "MODELS_ENV",
    '"result": "written" | "no_script"', "not instructions.\n\nCTX"]) assert.ok(task.includes(x), x);
  assert.doesNotMatch(task, /python3 \/|strength:/, "no command to run and no strength line to print");
  assert.doesNotMatch(task, /logging\.Handler/, "the silence rules only for a silent claim");
  // A probe of the kind downstream: a stub plays the dependency's fault on a virtual clock, without network.
  assert.doesNotMatch(task, /virtual seconds/, "the dependency rules only for a downstream claim");
  for (const x of ["stub in place of the dependency's client", "replace time.sleep, time.time and time.monotonic", "HTTP 429 or 503", "a connection error", "an empty or partial response", "virtual seconds the caller spends"])
    assert.ok(TH.probePrompt({ probe: { id: "d1", kind: "downstream", claim: "The request waits 7 s when the mailer hangs" }, path: "/w" }).includes(x), x);
  for (const p of [{ id: "s", kind: "telemetry", claim: "x" }, { id: "s", kind: "retry", claim: "the error is swallowed, silent" }, { id: "s", kind: "retry", claim: "x", signal: "none" }])
    assert.match(TH.probePrompt({ probe: p, path: "/w" }), /logging\.Handler to the root logger.*WARNING/s, JSON.stringify(p));
  // The answer line; the outcome: the runner's result counts; no script is not_run (never script_failed), and a
  // sentence about the agent's tools never reaches the page.
  assert.deepEqual(TH.parseProbeAnswer('x\n{"id":"p1","result":"written","reason":"counts mails"}\n{"id":"p2","result":"written"}', "p1"), { result: "written", reason: "counts mails" });
  assert.equal(TH.parseProbeAnswer('{"id":"p1","result":"reproduced"}', "p1"), null);
  const result = JSON.stringify({ id: "p1", status: "reproduced", strength: "forced_schedule", line: "2 mails", base: { rev: "b", status: "script_failed", line: "ImportError", verdict: "new_in_pr" }, pre_existing: false, network_barrier: true, head: "h", ms: 1200, output: "x" });
  const done = TH.probeOutcome("p1", { result, answer: { result: "written", reason: "counts mails" }, script: "print(1)", at: 5 });
  assert.deepEqual([done.state, done.status, done.strength, done.line, done.base.verdict, done.reason, done.script, done.network_barrier], ["done", "reproduced", "forced_schedule", "2 mails", "new_in_pr", "counts mails", "print(1)", true]);
  assert.equal(TH.BASE_WORDS[done.base.verdict], "new in this PR");
  const none = TH.probeOutcome("p1", { answer: { result: "no_script", reason: "Bash was denied, so I could not run it" } });
  assert.deepEqual([none.status, none.line, none.reason], ["not_run", "The agent wrote no script for this claim.", ""], "no script: not run, and no word about tools");
  assert.deepEqual([TH.probeOutcome("p1", { answer: { result: "no_script", reason: "the claim needs a real SQS queue" } }).line], ["No script: the claim needs a real SQS queue"]);
  assert.equal(TH.probeOutcome("p1", { script: "  " }).status, "not_run");
  // A PR that checks in the agent's write targets as links out of the checkout, or a script of its own: gone before the
  // agent starts, and what the links pointed to is untouched.
  { const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readdirSync, readFileSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { execFileSync } = await import("node:child_process");
    const d = mkdtempSync(`${tmpdir()}/probe-fresh-`);
    try {
      for (const planted of ["folder link", "file links", "own script", "nothing"]) {
        const w = `${d}/${planted.replace(" ", "-")}`; mkdirSync(`${w}/out`, { recursive: true }); writeFileSync(`${w}/out/victim.py`, "mine\n"); writeFileSync(`${w}/out/answers`, "mine\n");
        if (planted === "folder link") symlinkSync(`${w}/out`, `${w}/${TH.PROBE_DIR}`);
        if (planted !== "folder link" && planted !== "nothing") mkdirSync(`${w}/${TH.PROBE_DIR}`);
        if (planted === "file links") { symlinkSync(`${w}/out/victim.py`, `${w}/${TH.PROBE_DIR}/p1.py`); symlinkSync(`${w}/out/answers`, `${w}/${TH.VERIFY_FILE}`); }
        if (planted === "own script") writeFileSync(`${w}/${TH.PROBE_DIR}/p1.py`, "print('reproduced by the PR')\n");
        execFileSync("sh", TH.probeFresh(w));
        assert.ok(lstatSync(`${w}/${TH.PROBE_DIR}`).isDirectory() && !lstatSync(`${w}/${TH.PROBE_DIR}`).isSymbolicLink(), planted);
        assert.deepEqual([readdirSync(`${w}/${TH.PROBE_DIR}`), readdirSync(w).includes(TH.VERIFY_FILE)], [[], false], planted);
        assert.deepEqual([readFileSync(`${w}/out/victim.py`, "utf8"), readFileSync(`${w}/out/answers`, "utf8")], ["mine\n", "mine\n"], planted);
      }
    } finally { rmSync(d, { recursive: true, force: true }); } }
  // Script and result come from the runner's own output only: a refused script (a link) shows nothing of any file.
  const printed = JSON.stringify({ id: "p1", status: "reproduced", line: "2 mails", script: "print('reproduced 2 mails')\n" });
  assert.deepEqual(TH.probeRan({ code: 0, stdout: printed, stderr: "" }), { result: JSON.parse(printed), script: "print('reproduced 2 mails')\n", refused: "" });
  assert.equal(TH.probeOutcome("p1", { ...TH.probeRan({ code: 0, stdout: printed, stderr: "" }) }).script, "print('reproduced 2 mails')");
  const link = TH.probeOutcome("p1", { ...TH.probeRan({ code: 2, stdout: "", stderr: "probe: refused: .pr-review-probe/p1.py must be a plain file\n" }), answer: { result: "written", reason: "counts mails" } });
  assert.deepEqual([link.status, link.line, link.script, link.output], ["not_run", "Not run: .pr-review-probe/p1.py must be a plain file.", "", ""]);
  assert.deepEqual(TH.probeRan({ code: 3, stdout: "", stderr: "probe: refused: x is not there" }), { result: null, script: "", refused: "" }, "no script is no refusal");
  assert.equal(TH.probeOutcome("p1", { ...TH.probeRan({ code: 3, stdout: "", stderr: "" }), answer: { result: "no_script", reason: "needs a real queue" } }).line, "No script: needs a real queue");
  assert.deepEqual([TH.probeRan(null).refused, TH.probeRan({ code: 0, stdout: "{not json" }).refused, TH.probeRan({ code: 1, stdout: "", stderr: "Traceback" }).refused], Array(3).fill("the runner gave no result"));
  assert.equal(TH.probeOutcome("p1", { result: "{not json", script: "print(1)" }).status, "script_failed", "a script that ran without a readable result failed");
  assert.equal(TH.probeOutcome("p1", { result: JSON.stringify({ id: "other", status: "reproduced" }), script: "x" }).status, "script_failed", "another probe's file does not count");
  assert.equal(TH.probeOutcome("p1", { result: JSON.stringify({ id: "p1", status: "reproduced", base: { status: "x", verdict: "made_up" } }), script: "x" }).base.verdict, "unknown");
  console.log("probe agent ok");
}

{
  // The question before a probe says what the code can do: without a sandbox, read and change the user's files and
  // reach the network; in a sandbox, what it keeps away. A trusted PR in a sandbox starts without a question.
  const bare = TH.probeNeedsText({ barrier: "none", trusted: true });
  assert.match(bare, /no sandbox/); assert.match(bare, /read and change your files/); assert.match(bare, /reach the network/); assert.doesNotMatch(bare, /without network/);
  assert.equal(TH.probeNeedsText({ barrier: undefined, trusted: false }), bare, "an unknown fence counts as none");
  for (const b of ["sandbox-exec", "bwrap"]) {
    const fenced = TH.probeNeedsText({ barrier: b, trusted: false });
    assert.match(fenced, /in a sandbox: no network, nothing from your home/); assert.doesNotMatch(fenced, /change your files/);
    assert.equal(TH.probeNeedsText({ barrier: b, trusted: true }), null);
  }
  console.log("probe question ok");
}

// ---- wave R2: the evidence names the fence the script ran in (probe.py sandbox), so the outcome keeps it
{
  const r = JSON.stringify({ id: "p1", status: "reproduced", line: "x", network_barrier: true, sandbox: "sandbox-exec", head: "h", ms: 1 });
  assert.deepEqual([TH.probeOutcome("p1", { result: r, script: "print(1)" }).sandbox, TH.probeOutcome("p1", { script: "" }).sandbox], ["sandbox-exec", undefined]);
}

{
  // A probe id from a model's answer never leaves .pr-review-probe/: anything but 1 to 40 letters, digits, - and _ is
  // refused before the write rules, the task and the branch name, not rewritten.
  const bad = ["../x", "a/b", "*", "a b", "", "x".repeat(41), null, 7];
  for (const id of bad) {
    assert.throws(() => TH.probeId(id), /Probe refused/, String(id));
    assert.throws(() => TH.probeArgs({ cwd: "/w/x", name: "n", task: "T", job: "j", id }), /Probe refused/, String(id));
    assert.throws(() => TH.probePrompt({ probe: { id, claim: "c" }, path: "/w/x" }), /Probe refused/, String(id));
    assert.throws(() => TH.probeBranch(2, id, "k"), /Probe refused/, String(id));
  }
  const ok = "ok_1-" + "y".repeat(35);
  assert.equal(TH.probeId(ok), ok);
  assert.equal(TH.probeBranch(2, ok, "k"), `probe/2-${ok}-k`);
  assert.ok(TH.probeArgs({ cwd: "/w/x", name: "n", task: "T", job: "j", id: ok }).includes(`Write(//w/x/.pr-review-probe/${ok}.py)`));
  console.log("probe id ok");
}
// Agents that get PR text: no MCP servers in the Ask and Send review tabs either; the push lock in its wrappers and
// in git itself; what trusting a PR turns on.
{
  const ask = TH.tabArgs({ env: ["env", "A=1"], model: "sonnet", ask: true, trusted: false }), send = TH.tabArgs({ model: "opus" });
  assert.deepEqual(ask, ["env", "A=1", "claude", "--model", "sonnet", ...TH.NO_MCP, "--permission-mode", "manual", "--setting-sources", "user"], "Ask on someone else's PR: no MCP, manual, the user's settings only");
  assert.deepEqual(TH.tabArgs({ model: "sonnet", ask: true, trusted: true }).slice(-2), ["--permission-mode", "manual"]);
  assert.deepEqual(send, ["claude", "--model", "opus", ...TH.NO_MCP], "Send review: no MCP");
  for (const r of ["Bash(git -C * push*)", "Bash(git -c * push*)", "Bash(env * git push*)", "Bash(sh -c *git push*)"]) assert.ok(TH.NO_PUSH.includes(r), r);
  for (const r of ["Bash(git send-pack *)", "Bash(git http-push *)"]) assert.ok(TH.NO_PUSH.includes(r), r);
  // The real thing, each way to push on its own, against bare repositories in a temporary folder: with the lock for
  // the clone's remotes nothing arrives anywhere; fetch still works; git itself confirms the lock (pushLockOpen).
  const { execFileSync } = await import("node:child_process"), { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os");
  const d = mkdtempSync(`${tmpdir()}/nopush-`), clean = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const envOf = (lock) => Object.fromEntries(lock.slice(1).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
  const git = (args, env = {}) => execFileSync("git", args, { cwd: `${d}/w`, env: { ...clean, ...env }, stdio: "pipe" }).toString();
  try {
    for (const r of ["r", "r2", "alt"]) execFileSync("git", ["init", "-q", "--bare", `${d}/${r}.git`], { env: clean });
    execFileSync("git", ["init", "-q", `${d}/w`], { env: clean });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]); git(["remote", "add", "origin", `${d}/r.git`]); git(["remote", "add", "second", `${d}/r2.git`]);
    const U = `file://${d}/r.git`, ALT = `file://${d}/alt.git`, names = git(["remote"]).split("\n").filter(Boolean), lock = envOf(TH.noPushEnv(names));
    const arrived = () => ["r", "r2", "alt"].filter((r) => execFileSync("git", ["-C", `${d}/${r}.git`, "for-each-ref"], { env: clean }).toString() !== "");
    const asked = (env) => { try { return execFileSync(TH.pushLockProbe(names)[0], TH.pushLockProbe(names).slice(1), { cwd: `${d}/w`, env: { ...clean, ...env }, stdio: "pipe" }).toString(); } catch { return ""; } };
    assert.deepEqual(names, ["origin", "second"]);
    // [what the checkout's config has, the push]: every one of them is refused under the lock.
    const ways = [
      [[], ["push", "origin", "HEAD:main"], "a remote"],
      [[], ["-C", ".", "-c", "a.b=c", "push", "origin", "HEAD:main"], "git -C and -c"],
      [[], ["push", "https://github.com/o/r.git", "HEAD:main"], "a URL"],
      [[], ["push", `${d}/r2.git`, "HEAD:main"], "a path"],
      [[], ["push", "--no-verify", "second", "HEAD:main"], "a second remote"],
      [[["remote.origin.pushurl", ALT]], ["push", "origin", "HEAD:main"], "a remote with a push URL of its own"],
      [[["remote.second.pushurl", ALT], ["remote.pushDefault", "second"], ["push.default", "current"]], ["push"], "remote.pushDefault and push.default"],
      [[["remote.second.pushurl", ALT], ["branch.main.pushRemote", "second"], ["push.default", "current"]], ["push"], "a branch's pushRemote"],
      [[[`url.${ALT}.pushInsteadOf`, U]], ["push", "origin", "HEAD:main"], "a longer pushInsteadOf in the config"],
      [[], ["-c", `remote.origin.pushurl=${ALT}`, "push", "origin", "HEAD:main"], "a push URL through git -c"],
      [[], ["-c", `url.${ALT}.pushInsteadOf=${U}`, "push", "origin", "HEAD:main"], "pushInsteadOf through git -c"],
    ];
    git(["branch", "-M", "main"]);
    // The config of a way is written into .git/config as text (one process less per key: git parses "a.b.c = v" lines
    // under no section only as [a "b"] c, so the sections are spelled out).
    const plain = readFileSync(`${d}/w/.git/config`, "utf8"), section = (k, v) => { const [s, ...rest] = k.split("."), name = rest.pop(); return `[${s}${rest.length ? ` "${rest.join(".")}"` : ""}]\n\t${name} = ${v}\n`; };
    for (const [config, how, name] of ways) {
      writeFileSync(`${d}/w/.git/config`, plain + config.map(([k, v]) => section(k, v)).join(""));
      assert.throws(() => git(how, lock), /pushing-is-off-in-this-review/, name);
      if (name === "remote.pushDefault and push.default") assert.deepEqual(TH.pushLockOpen(asked(lock), names), [], "git confirms the lock");
    }
    writeFileSync(`${d}/w/.git/config`, plain);
    for (const [key, v] of [["GIT_DIR", `${d}/w/.git`], ["GIT_SSH_COMMAND", "false"], ["GIT_CONFIG_GLOBAL", `${d}/w/.git/config`]])
      assert.throws(() => git(["push", "origin", "HEAD:main"], { ...lock, [key]: v }), /pushing-is-off-in-this-review/, `with ${key} set`);
    assert.throws(() => execFileSync("sh", ["-c", "git push -q origin HEAD:main"], { cwd: `${d}/w`, env: { ...clean, ...lock }, stdio: "pipe" }), /pushing-is-off/, "sh -c");
    git(["fetch", "-q", "origin"], lock);
    assert.deepEqual(arrived(), [], "nothing arrived anywhere");
    // Why the lock names the remotes: the first part alone (no remote known) lets a remote's own push URL through,
    // and git says so when asked, which stops the start.
    git(["config", "remote.origin.pushurl", ALT]);
    assert.deepEqual(TH.pushLockOpen(asked(envOf(TH.NO_PUSH_ENV)), names), [ALT], "without its remotes the lock is open, and the check sees it");
    git(["push", "-q", "origin", "HEAD:main"], envOf(TH.NO_PUSH_ENV)); assert.deepEqual(arrived(), ["alt"], "that push went through");
    assert.deepEqual([TH.pushLockOpen("", names), TH.pushLockOpen(`${TH.PUSH_OFF}origin\n`, names), TH.pushLockOpen(`${TH.PUSH_OFF}origin\n?\n`, names)], [["?"], ["?"], ["?"]], "no answer for a remote is not a lock");
    // Not covered, as the preview says: git's plumbing reaches a repository without the push URLs.
    git(["send-pack", `${d}/r2.git`, "HEAD:refs/heads/main"], lock); assert.deepEqual(arrived(), ["r2", "alt"], "send-pack is denied by rule only");
    assert.deepEqual(TH.subAgentArgs({ cwd: "/w", name: "n", task: "x", job: "j", lock: TH.noPushEnv(names) }).filter((x) => x.startsWith("GIT_CONFIG_COUNT")), ["GIT_CONFIG_COUNT=5"], "the agent starts under the lock for its remotes");
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.deepEqual(["auto mode", "own agent session", "Probes start without asking", "security review starts by itself", "Language servers", "Codex review starts on your click"].filter((w) => !TH.TRUST_TURNS_ON.some((x) => x.includes(w))), [], "the trust prompt names all of it");
  console.log("agents with PR text ok");
}


// Fix worktrees left on disk: only Herdr's folder for this repo and fix/ or verify/ branches; what removing would lose.
{
  const { leftWorktrees, worktreeRisky, worktreeLine } = await import("./threads.js");
  const out = ["worktree /code/demo\nHEAD 111\nbranch refs/heads/main", "worktree /h/.herdr/worktrees/demo/fix-2-a1\nHEAD 222\nbranch refs/heads/fix/2-a1",
    "worktree /h/.herdr/worktrees/demo/verify-2-a1\nHEAD 333\nbranch refs/heads/verify/2-a1", "worktree /h/.herdr/worktrees/demo/mine\nHEAD 444\nbranch refs/heads/feature",
    "worktree /h/.herdr/worktrees/other/fix-9-x\nHEAD 555\nbranch refs/heads/fix/9-x", "worktree /h/.herdr/worktrees/demo/loose\nHEAD 666\ndetached"].join("\n\n") + "\n";
  assert.deepEqual(leftWorktrees(out, ["/h/.herdr/worktrees"], "o/demo"), [{ path: "/h/.herdr/worktrees/demo/fix-2-a1", branch: "fix/2-a1" }, { path: "/h/.herdr/worktrees/demo/verify-2-a1", branch: "verify/2-a1" }]);
  assert.deepEqual(leftWorktrees("", ["/h/.herdr/worktrees"], "o/demo"), []);
  // Another folder set in Herdr's settings: fixes made there and the ones left in the default folder are both listed.
  assert.deepEqual(leftWorktrees(`${out}\n\nworktree /wt/demo/fix-2-b2\nHEAD 3\nbranch refs/heads/fix/2-b2`, ["/wt", "/h/.herdr/worktrees"], "o/demo").map((w) => w.branch), ["fix/2-a1", "verify/2-a1", "fix/2-b2"]);
  const w = { branch: "fix/2-a1", only: 0, dirty: false, unknown: false };
  assert.deepEqual([w, { ...w, only: 2 }, { ...w, dirty: true }, { ...w, unknown: true }].map(worktreeRisky), [false, true, true, true]);
  assert.equal(worktreeLine(w), "Remove fix/2-a1 · nothing only there");
  assert.equal(worktreeLine({ ...w, only: 1, dirty: true }), "Remove fix/2-a1 · 1 commit only there · uncommitted changes");
  assert.equal(worktreeLine({ ...w, only: 2 }, true), "Remove anyway fix/2-a1 · 2 commits only there");
  console.log("ok fix worktrees");
}
