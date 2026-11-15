// Run: node test_timeline.mjs  (the Resilience page's picture "Timing": the run's calls as rows in seconds, their
// verdicts, the px layout and the Markdown; nothing guessed where the run states no seconds)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { timelineOf, timelineLayout, timelineMd, fmtS, TL } from "./timeline.js";
import { withResilience } from "./pr.js";

const arch = { nodes: [{ id: "h", label: "handler" }, { id: "c", label: "consumer" }, { id: "q", label: "queue" }, { id: "m", label: "mailer" }],
  edges: [{ from: "h", to: "m" }, { from: "q", to: "c" }, { from: "c", to: "m" }] };
const mail = (edge, extra = {}) => ({ edge, node: "h", at: "lib/handler.py:21", mode: "sync", timeout: { s: 10, source: "Globals.Timeout (template.yaml:8); none of its own" }, request_path: true, entry: "POST /remind",
  retry: { layer: "mailer", attempts: 3, backoff: "2**attempt", at: "lib/mailer.py:14-20", ...extra } });
const queue = { edge: "e1", node: "c", at: "template.yaml:34", mode: "async", timeout: { s: 10 }, retry: { layer: "SQS redelivery", attempts: 0, at: "template.yaml:11" },
  trigger: { batch: 10, fn_timeout_s: 10, visibility_s: 30, retention_s: 345600, worst_record_s: 7 } };
const paths = [{ id: "p1", kind: "request", steps: ["e0"] }, { id: "p2", kind: "retry", steps: ["e1"], budget: { over_s: 60, at: "template.yaml:34" } }];
const rowsOf = (m) => m.groups.map((g) => [g.title, g.verdict?.kind, g.path, g.rows.map((r) => [r.label, r.min, r.verdict?.text ?? null])]);

// The pauses in seconds, the attempts' own timeout not stated: the sum is "at least", what is left is said, nothing is over.
{
  const m = timelineOf({ deps: [mail("e0", { backoff_s: [1, 2, 4] }), queue], paths }, arch);
  assert.deepEqual(rowsOf(m), [
    ["queue → consumer", "over", "p2", [["function timeout", 10, null], ["message visibility", 30, "! under 6 × the function timeout (60 s)"], ["worst batch", 70, "✗ 60 s over the function timeout"]]],
    ["handler → mailer", "open", "p1", [["timeout", 10, null], ["mailer retry", 7, "? 3 s left for 3 attempts of unstated length"]]]], "the call over its limit first; a pause after the last attempt when the run states one");
  const r = m.groups[1].rows[1];
  assert.deepEqual([r.cells, r.at, m.groups[1].rows[0].at], [{ attempts: "3 attempts", backoff: "pauses of 1 s, 2 s and 4 s", sum: "at least 7 s" }, "lib/mailer.py:14", "template.yaml:8"], "the cells, and the places taken from the run's words");
  assert.deepEqual(r.segs.map((s) => [s.kind, s.from, s.to, s.open]), [["attempt", 0, 0, true], ["pause", 0, 1, false], ["attempt", 1, 1, true], ["pause", 1, 3, false], ["attempt", 3, 3, true], ["pause", 3, 7, false]]);
  assert.equal(m.line, "2 calls: 1 over and 1 not stated"); assert.equal(m.rerun, null);
}
// Everything stated: a sum, over or within; one attempt longer than the limit is over by itself.
{
  const v = (retry, s = 10) => timelineOf({ deps: [{ ...mail("e0", retry), timeout: { s } }] }, arch).groups[0].rows[1];
  assert.deepEqual([v({ attempt_s: 2, backoff_s: [1, 2] }).cells.sum, v({ attempt_s: 2, backoff_s: [1, 2] }).verdict.text], ["9 s", "✓ fits the timeout"], "3 × 2 s and two pauses: no pause after the last attempt unless stated");
  assert.equal(v({ attempt_s: 3, backoff_s: [1, 2, 4] }).verdict.text, "✗ 6 s over the timeout");
  assert.equal(v({ attempt_s: 30, attempts: 1 }).verdict.text, "✗ 20 s over the timeout", "one attempt with a timeout of its own is a row");
  assert.equal(v({ backoff_s: [5, 6] }).verdict.text, "✗ at least 1 s over the timeout", "over for sure, though the attempts are open");
  assert.equal(v({ backoff_s: [3, 7] }).verdict.text, "? no time left for 3 attempts of unstated length");
  assert.equal(v({ backoff_s: [1] }).unknown, "3 attempts and 1 pause", "a pause the list leaves out is not stated, never 0");
  assert.equal(v({ backoff_s: [0, 0], attempt_s: 1 }).cells.sum, "3 s", "a pause of 0 s is stated");
  assert.equal(timelineOf({ deps: [{ ...mail("e0", { backoff_s: [1, 2] }), timeout: { s: 0 } }] }, arch).groups[0].rows[1].verdict.text, "? no timeout stated");
}
// A run from before the fields: the attempts and the limit as the run has them, no sum, the retry open, and the sentence that offers a new run.
{
  const m = timelineOf({ deps: [mail("e0"), queue, { edge: "e2", at: "lib/c.py:7", mode: "in_process", timeout: { s: 0 } }] }, arch), r = m.groups.at(-1).rows[1];
  assert.deepEqual([r.cells.sum, r.cells.backoff, r.verdict.text, r.min], ["not stated", "pauses in the run's words: 2**attempt", "? not stated in seconds", 0]);
  assert.match(m.rerun, /^1 retry of this run names its pauses only in words/);
  assert.equal(m.groups.length, 2, "a call without any number is no group");
  assert.equal(timelineLayout(m).groups.at(-1).rows[1].bars.length, 1, "one open bar for a row without a second");
  assert.equal(timelineOf({ deps: [{ at: "x.py:1", mode: "sync", timeout: { s: 5 } }] }, arch), null, "a lone timeout is no picture");
  assert.equal(timelineOf({ deps: [] }), null); assert.equal(timelineOf(null), null); assert.deepEqual(timelineMd(null), []);
}
// A queue's visibility against its function's timeout.
{
  const vis = (visibility_s) => timelineOf({ deps: [{ ...queue, trigger: { fn_timeout_s: 10, visibility_s } }] }, arch).groups[0].rows[1].verdict.text;
  assert.deepEqual([vis(5), vis(30), vis(60)], ["✗ 5 s shorter than the function timeout", "! under 6 × the function timeout (60 s)", "✓ at least 6 × the function timeout"]);
}
// The layout: every bar inside the track, the limit's line where the limit ends, the part over it from there on; groups
// far apart in length get their own scale, a bar far over its limit is cut; at most 12 rows, the rest counted.
{
  const L = timelineLayout(timelineOf({ deps: [mail("e0", { backoff_s: [1, 2, 4] }), queue], paths }, arch));
  assert.ok(L.own, "70 s and 10 s: each group its own scale");
  for (const g of L.groups) for (const r of g.rows) for (const b of r.bars) assert.ok(b.x >= 0 && b.w > 0 && b.x + b.w <= TL.W + TL.OPEN, `${g.title} ${r.label}: a bar outside the track`);
  const [q, h] = L.groups, batch = q.rows[2];
  assert.ok(batch.over.x === q.limitX && batch.over.x + batch.over.w === batch.bars[0].x + batch.bars[0].w, "the part over the limit runs from the limit to the bar's end");
  assert.deepEqual(h.rows[1].bars.filter((b) => !b.open).map((b) => b.kind), ["pause", "pause", "pause"]);
  assert.ok(h.rows[1].bars.filter((b) => b.open).every((b) => b.w === TL.OPEN), "an unstated attempt is a stub, not a length");
  assert.deepEqual(h.ticks.map((t) => t.label), ["0", "2 s", "4 s", "6 s", "8 s", "10 s"]);
  const same = timelineLayout(timelineOf({ deps: [mail("e0", { backoff_s: [1, 2, 4] }), { ...mail("e2", { backoff_s: [5, 5, 5] }), timeout: { s: 20 } }] }, arch));
  assert.ok(!same.own && same.groups[0].max_s === same.groups[1].max_s, "10 s and 20 s share one axis");
  const far = timelineLayout(timelineOf({ deps: [{ ...queue, trigger: { ...queue.trigger, worst_record_s: 90 } }] }, arch)).groups[0];
  assert.ok(far.rows[2].cut && far.max_s < 900, "900 s against 10 s: the scale stays near the limit and the bar is cut");
  const many = timelineOf({ deps: Array.from({ length: 9 }, (_x, k) => ({ ...mail(`x${k}`, { backoff_s: [1, 2, 4] }), at: `a.py:${k}` })) }, arch);
  assert.deepEqual([many.groups.length, many.more, many.total, many.moreLine], [6, 3, 9, "3 more calls with a timeout or a retry are not shown."]);
}
// Markdown: its own section, a table row per run and per judged limit, a gantt of the stated whole seconds.
{
  const md = timelineMd(timelineOf({ deps: [mail("e0", { backoff_s: [1, 2, 4] }), queue], paths }, arch), (id) => Number(id.slice(1)));
  assert.equal(md[0], "## Timing (2)");
  assert.ok(md.includes("| handler → mailer, from POST /remind: mailer retry | 10 s (timeout) | 3 attempts | pauses of 1 s, 2 s and 4 s | at least 7 s | ? 3 s left for 3 attempts of unstated length, path 1 |"));
  assert.ok(md.includes("| queue → consumer: worst batch | 10 s (function timeout) |  |  | 10 records × 7 s = 70 s | ✗ 60 s over the function timeout, path 2 |"));
  const g = md.slice(md.indexOf("```mermaid") + 1, md.indexOf("```"));
  assert.deepEqual(g.slice(0, 4), ["gantt", "  title Timing in seconds", "  dateFormat X", "  axisFormat %s"]);
  assert.ok(g.includes("  worst batch (70 s) :crit, 0, 70") && g.includes("  mailer retry pause 3 (4 s) :3, 7") && g.includes("  timeout 10 s :done, 0, 10"));
  assert.ok(!timelineMd(timelineOf({ deps: [mail("e0", { backoff_s: [0.2, 0.4] })] }, arch)).includes("gantt"), "fractions of a second: the table alone");
}
assert.deepEqual([0.25, 7, 70, 900, 7200, 345600].map(fmtS), ["0.25 s", "7 s", "70 s", "15 min", "2 h", "4 days"]);
// The demo's PR #2 (the fixture of the smoke test; not there in a copy of the mod folder alone): the batch over its
// function's timeout, the mailer's 7 s of pauses in 10 s.
if (existsSync(new URL("../../demo/fixtures/review/", import.meta.url))) {
  const fx = (n) => JSON.parse(readFileSync(new URL(`../../demo/fixtures/review/${n}`, import.meta.url), "utf8"));
  const a = fx("analysis-s.json").answer.architecture, doc = fx("findings-s.json"), res = withResilience({ arch: a }, doc.resilience, null, doc.findings).resilience;
  const m = timelineOf(res, a), over = res.paths.find((p) => p.budget?.over_s > 0);
  assert.deepEqual(m.groups.map((g) => [g.verdict.kind, g.path === over.id]), [["over", true], ["open", false], ["open", true]]);
  assert.equal(m.groups[1].rows[1].cells.sum, "at least 7 s"); assert.equal(m.groups[1].limit.s, 10);
}
console.log("test_timeline: ok");
