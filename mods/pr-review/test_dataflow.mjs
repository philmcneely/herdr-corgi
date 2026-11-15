// Run: node test_dataflow.mjs  (the Security page's section "Where sensitive data goes": the security run's data with
// their ways over the crossings of the boundary map, the steps as sentences, what is marked, what an older run still
// shows, and the Markdown; a protection the run does not state is "not stated", never a guess)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dataflowOf, dataflowMd, dataflowPic, wayLine, kindByName, NOTE, NOTE_OLD, RERUN } from "./dataflow.js";
import { crossingsOf } from "./views.js";
import { withSecurity } from "./pr.js";

const arch = { nodes: [{ id: "client", label: "Client", type: "external" }, { id: "api", label: "API handler" }, { id: "q", label: "Orders queue" }, { id: "w", label: "Worker" }, { id: "db", label: "Orders table" }],
  edges: [{ from: "client", to: "api" }, { from: "api", to: "q" }, { from: "q", to: "w" }, { from: "w", to: "db" }] };
const zone = (name, trust) => ({ name, trust });
// The page's crossings in their order (their number): a way in, a right merged with its call, a call.
const rows = [
  { key: "a:acc1", kind: "entry", from: zone("anyone on the internet", "public"), to: zone("API", "authenticated"), ends: { from: null, to: "api" }, identity: "anyone on the internet", at: "api.py:9", carries: ["Authorization header", "body.id"] },
  { key: "e:1", aliases: ["a:acc2"], kind: "right", from: zone("API", "authenticated"), to: zone("Queue", "data"), ends: { from: "api", to: "q" }, edge: 1, at: "t.yaml:20", carries: null },
  { key: "e:2", kind: "call", from: zone("Queue", "data"), to: zone("Worker", "internal"), ends: { from: "q", to: "w" }, edge: 2, at: "t.yaml:30", carries: "record body: order" }];
const step = (node, more = {}) => ({ node, at: "", protected: "", retention: "", ...more });
const flagsOf = (x) => x.flags.map((f) => `${f.key}@${f.step}`);

// A way over the map: each step names the crossing it takes by its number, a sink says where the data ends, and what
// the run leaves empty is "not stated". Marked: a log, an error message, a public crossing without a protection, a
// place that keeps it without a retention rule. A stated protection or rule takes the mark away.
{
  const m = dataflowOf({ arch, crossings: rows, data: [
    { id: "d1", name: "session token", kind: "credential", steps: [step("client"), step("api", { at: "api.py:9" }), step("api", { at: "api.py:14", sink: "error" })] },
    { id: "d2", name: "customer mail address", kind: "personal", steps: [step("client"), step("api", { at: "api.py:9", protected: "TLS" }), step("q", { at: "api.py:30", sink: "queue", protected: "encrypted at rest (t.yaml:12)", retention: "4 days (t.yaml:13)" }),
      step("w", { at: "worker.py:5" }), step("w", { at: "worker.py:8", sink: "log", protected: "masked" }), step("db", { at: "worker.py:12", sink: "store" })] },
    { id: "d3", name: "signing key", kind: "secret", steps: [step("api", { at: "api.py:3", protected: "read from the secret store" })] },
    { name: "comment text", kind: "essay", steps: [step("moon")] }, { name: "", kind: "other", steps: [step("api")] }, null] });
  assert.deepEqual(m.items.map((x) => [x.id, x.kind, x.byName]), [["d1", "credential", false], ["d2", "personal", false], ["d3", "secret", false], ["d4", "other", false]]);
  const [tok, mail, key, other] = m.items;
  assert.deepEqual(tok.steps.map((s) => s.text), ["Starts at Client.", "Passes API handler, over crossing 1 (anyone on the internet → API) (api.py:9). Protected by: not stated.", "Put into an error message at API handler (api.py:14). Protected by: not stated."]);
  assert.deepEqual([tok.path, tok.crossed, tok.way, flagsOf(tok)], [["client", "api"], ["a:acc1"], "Client → ‖1 API handler", ["public@2", "error@3"]]);
  assert.deepEqual(mail.steps.map((s) => [s.cross, s.sink, s.flags]), [[null, null, []], [1, null, []], [2, "queue", []], [3, null, []], [null, "log", ["retention"]], [null, "store", ["retention"]]]);
  assert.equal(mail.steps[2].text, "Kept on a queue at Orders queue, over crossing 2 (API → Queue) (api.py:30). Protected by: encrypted at rest (t.yaml:12). Kept until: 4 days (t.yaml:13).");
  assert.equal(mail.steps[4].text, "Written to a log at Worker (worker.py:8). Protected by: masked. Kept until: not stated.", "masked: in a log, and not marked as one");
  assert.deepEqual([mail.path, mail.crossed, mail.way], [["client", "api", "q", "w", "db"], ["a:acc1", "e:1", "e:2"], "Client → ‖1 API handler → ‖2 Orders queue → ‖3 Worker → Orders table"]);
  assert.deepEqual([key.steps[0].text, key.flags, key.crossed], ["Starts at API handler (api.py:3). Protected by: read from the secret store.", [], []]);
  assert.deepEqual([wayLine(key), wayLine(tok)], ["Way: API handler. It takes no crossing of the map.", "Way: Client → ‖1 API handler."]);
  assert.deepEqual([other.steps[0].text, other.path], ["Starts at moon.", ["moon"]], "a card the picture does not have keeps its id (the run's own view drops such steps)");
  assert.equal(m.line, "1 credential reaches an error message, 1 more to check", "the worst mark first, in the words of its kind");
  assert.deepEqual([m.total, m.note, m.old, m.rerun, m.unclassified], [4, NOTE, false, null, 0]);
  // Markdown: a numbered list per kind of data, what is to check, and a flowchart of its way.
  const md = dataflowMd(m, (p) => ["```mermaid", `flowchart LR ${p.nodes.length}/${p.edges.length}`, "```"], (id) => arch.nodes.find((n) => n.id === id)?.label ?? id).join("\n");
  assert.match(md, /^## Where sensitive data goes \(4\)\n\n1 credential reaches an error message, 1 more to check\.\n/);
  assert.ok(md.includes("### session token (credential)\n\nWay: Client → ‖1 API handler.\n\n1. Starts at Client.\n2. Passes API handler, over crossing 1"), md);
  assert.ok(md.includes("To check: over a public boundary, no protection stated (step 2); in an error message (step 3)."));
  assert.ok(md.includes("flowchart LR 3/2") && md.includes("flowchart LR 6/5") && (md.match(/```mermaid/g) ?? []).length === 2, "a way of one card has no picture");
  const pic = dataflowPic(mail, (id) => id);
  assert.deepEqual(pic.edges.map((e) => [e.from, e.to.replace("\0", "~"), e.label, Boolean(e.crosses)]), [["client", "api", "crossing 1", true], ["api", "q", "crossing 2", true], ["q", "w", "crossing 3", true], ["w", "~log:w", "to check", false], ["w", "db", "", false]]);
}

// The line of a folded section: counted in the kind's own words; several kinds are "sensitive fields"; nothing marked
// says so.
{
  const one = (kind, steps) => ({ name: kind, kind, steps });
  const line = (data) => dataflowOf({ arch, crossings: rows, data })?.line;
  assert.equal(line([one("secret", [step("w", { sink: "log" })])]), "1 secret reaches a log");
  assert.equal(line([one("secret", [step("w", { sink: "log" })]), one("personal", [step("w", { sink: "log" })])]), "2 sensitive fields reach a log");
  assert.equal(line([one("personal", [step("w", { sink: "log" })]), one("personal", [step("api", { sink: "log" })])]), "2 personal fields reach a log");
  assert.equal(line([one("content", [step("db", { sink: "store", protected: "encrypted" })])]), "1 content field is kept with no retention rule stated");
  assert.equal(line([one("credential", [step("client"), step("api")])]), "1 credential crosses a public boundary with no protection stated");
  assert.equal(line([one("credential", [step("client"), step("api", { protected: "TLS" })])]), "1 kind of sensitive data, none marked: every log, sink and public crossing on its way states its protection");
  assert.equal(line([]), undefined, "a run that names no data: no section");
}

// A run from before the field: only what its checks say goes over a crossing. A word that names its kind is shown as
// sorted by its name, without marks; the rest is counted, never sorted by a guess; the section offers a new run.
{
  assert.deepEqual(["Authorization header", "session cookie", "api_key", "client secret", "reply-to e-mail", "body.id", "token", "record body: type, loan_id", "X-Request-Id"].map(kindByName), ["credential", "credential", "credential", "secret", "personal", null, null, null, null]);
  const m = dataflowOf({ arch, crossings: rows, data: null });
  assert.deepEqual(m.items.map((x) => [x.name, x.kind, x.byName, x.crossed, x.flags, x.way]), [["Authorization header", "credential", true, ["a:acc1"], [], "‖1 anyone on the internet → API"]]);
  assert.equal(m.items[0].steps[0].text, "Goes over crossing 1 (anyone on the internet → API) (api.py:9). Its kind is read from its name; this run does not say how it is protected.");
  assert.deepEqual([m.old, m.unclassified, m.unclassifiedLine, m.note, m.rerun], [true, 2, "2 crossings carry data this run did not classify.", NOTE_OLD, RERUN]);
  assert.equal(m.line, "1 field sorted by name, 2 crossings carry data this run did not classify");
  const none = dataflowOf({ arch, crossings: [rows[2]], data: undefined });
  assert.deepEqual([none.items, none.line], [[], "1 crossing carries data this run did not classify"], "nothing sorted: only the count");
  assert.ok(dataflowMd(none, () => []).join("\n").includes(RERUN));
  assert.equal(dataflowOf({ arch, crossings: [rows[1]], data: null }), null, "an older run whose crossings name nothing: no section");
}
assert.equal(dataflowOf(), null);
assert.deepEqual(dataflowMd(null, () => []), []);

// PR #2 of the demo: the bearer token takes the way in (crossing 1) with its protection stated; the member's mail
// address ends at a third party and in a log (marked); the same file without `data` is the older run.
const fx = new URL("../../demo/fixtures/review/", import.meta.url);
if (existsSync(new URL("findings-s.json", fx))) {
  const an = JSON.parse(readFileSync(new URL("analysis-s.json", fx), "utf8")), fd = JSON.parse(readFileSync(new URL("findings-s.json", fx), "utf8"));
  const view = (security) => { const ai = withSecurity({ arch: (an.answer ?? an).architecture, access: [] }, security);
    const cr = crossingsOf({ arch: ai.arch, access: ai.access, threats: ai.threats, gates: ai.gates, bypasses: ai.bypasses, findings: [] }); return [dataflowOf({ data: ai.secData, arch: ai.arch, crossings: cr }), cr]; };
  const [m, cr] = view(fd.security);
  assert.deepEqual(m.items.map((x) => [x.kind, x.crossed, flagsOf(x)]), [["credential", ["a:acc1"], []], ["personal", [], ["log@4", "retention@4"]], ["secret", [], []]]);
  assert.equal(cr.findIndex((r) => r.key === "a:acc1") + 1, m.items[0].steps[1].cross, "the number is the crossing's on the map");
  assert.equal(m.line, "1 personal field reaches a log");
  const [old] = view({ ...fd.security, data: undefined });
  assert.deepEqual([old.items.map((x) => x.name), old.unclassified, old.old], [["Authorization header"], 2, true]);
}
console.log("dataflow ok");
