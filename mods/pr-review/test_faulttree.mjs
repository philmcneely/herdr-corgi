// Run: node test_faulttree.mjs  (the Resilience page's fault tree for a case of "When a dependency fails": the case,
// what the code does, its path's repeats, end and verdict, and what is seen outside; nothing the run does not name)
import assert from "node:assert/strict";
import { faultTree, faultTrees, faultFlow } from "./faulttree.js";
import { archLayout } from "./arch.js";
import { flowArch } from "./views.js";

const dep = { dep: "Mailer", kind: "external", at: "lib/consumer.py:21", entry: "the queue consumer", cases: [] };
const slow = { when: "slow", at: "lib/mailer.py:14", handled: "no", how: "no timeout; waits until the 10 s timeout", effect: "The batch times out and is delivered again.", path: "p2" };
const path = { id: "p2", end: "The whole batch is redelivered.", result: "finding", signal: "platform_only", seen_as: "Lambda Errors on the consumer", possible_today: false, note: "",
  wired: { reason: "load grows without a limit", today: "not possible today: nothing publishes to the queue" },
  ladder: [{ name: "the whole batch of 10 again", factor: "×10", at: "template.yaml:34" }, { name: "redelivered until the message expires", factor: "no limit", at: "template.yaml:34" }], product: "10 × without limit" };
const shape = (t) => [t.nodes.map((n) => [n.id, n.label, n.description, n.at ?? null]), t.edges.map((e) => `${e.from} -${e.label}-> ${e.to}`)];

// With its path: the chain down to the path, then the leaves: the caller, on-call, today.
{
  const t = faultTree(dep, slow, path, 4);
  assert.deepEqual(shape(t), [[
    ["case", "Mailer is slow", "✗ not handled: no timeout; waits until the 10 s timeout", "lib/mailer.py:14"],
    ["again", "10 × without limit", "the whole batch of 10 again ×10; redelivered until the message expires no limit", "template.yaml:34"],
    ["end", "Path 4: blocks once wired", "The whole batch is redelivered.", "path:p2"],
    ["caller", "The caller gets", "The batch times out and is delivered again.", null],
    ["oncall", "On-call sees", "Lambda Errors on the consumer", null],
    ["today", "Not possible today", "nothing publishes to the queue", null]],
  ["case -repeats-> again", "again -ends in-> end", "end --> caller", "end --> oncall", "end --> today"]]);
  assert.equal(t.title, "Mailer is slow, from the queue consumer"); assert.equal(t.kind, "tree");
  // the flow engine draws it left to right: the root first, the leaves last, every card placed
  const L = archLayout(flowArch(t), "diff", () => 0, true, { labels: true }), x = (id) => L.nodes.find((n) => n.id === id).x;
  assert.ok(L.nodes.length === 6 && x("case") < x("again") && x("again") < x("end") && x("end") < x("caller") && x("caller") === x("oncall") && x("oncall") === x("today"));
}
// A path's words: a blocker, silent (nothing shows it), possible today; a path without a ladder has no card for repeats.
{
  const t = faultTree(dep, slow, { id: "p1", end: "The mail is lost.", result: "finding", blocker: { reason: "a visible effect is lost" }, signal: "none", seen_as: "", possible_today: true, ladder: [] }, 1);
  assert.deepEqual(t.nodes.map((n) => [n.id, n.label, n.description]).slice(1), [["end", "Path 1: blocker", "The mail is lost."], ["caller", "The caller gets", "The batch times out and is delivered again."],
    ["oncall", "✕ silent", "No alarm, no log line and no metric names it."], ["today", "Possible today", "It can happen as the code stands."]]);
  const old = faultTree(dep, slow, { id: "p3", end: "x", result: "mitigated", visible: false }, null); // an older run: visible instead of signal, no word on today
  assert.deepEqual(old.nodes.map((n) => n.label), ["Mailer is slow", "Path p3: limited", "The caller gets", "✕ silent"]);
}
// Without a path there is no tree: the case's row says all the run knows, and no step is guessed. A path that says
// nothing about on-call or today still gives the short tree: the case, the path, what the caller gets.
{
  assert.equal(faultTree(dep, { when: "down", at: "lib/mailer.py:19", handled: "yes", how: "fails fast", effect: "The caller gets a 503 at once." }), null);
  assert.deepEqual(shape(faultTree(dep, slow, { id: "p9", end: "x", result: "finding", signal: "log" }, 2))[1], ["case -ends in-> end", "end --> caller"]);
  assert.equal(faultTree(null, slow), null);
}
// Every decided case of the run, by dependency and case; a path that is not the run's, and a case the code cannot decide, add nothing.
{
  const res = { downstream: [{ ...dep, cases: [slow, { when: "down", handled: "partly", how: "retries", effect: "Late mails.", path: "nope" }, { when: "recovers", handled: "not_checkable", how: "nothing is queued", effect: "By hand." }] }] };
  const all = faultTrees(res, [path], () => 4);
  assert.deepEqual(all.map((x) => [x.k, x.when, x.tree.nodes.length]), [[0, "slow", 6]]);
  assert.deepEqual(faultTrees(null), []);
  assert.deepEqual(faultFlow(all[0].tree).nodes.map((n) => n.label).slice(0, 2), ["Mailer is slow: ✗ not handled: no timeout; waits until the 10 s timeout", "10 × without limit: the whole batch of 10 again ×10; redelivered until the message expires no limit"]);
}
console.log("test_faulttree: ok");
