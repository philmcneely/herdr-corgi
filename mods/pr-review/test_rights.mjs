// Run: node test_rights.mjs  (the Security page's table "Who may do what": the security run's access rows as
// principals × resources, the marks for what the PR does to a right, guards in the cell they protect, wildcards, what
// is folded when the table is large, and the Markdown; nothing but what the run says)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { rightsOf, rightsShown, rightsMd, cellOf, actionOf, entryText, MAX, NOTE } from "./rights.js";
import { crossingsOf } from "./views.js";
import { withSecurity } from "./pr.js";

const arch = { nodes: [{ id: "h", label: "handler" }, { id: "q", label: "Orders queue" }, { id: "b", label: "Archive bucket" }], edges: [] };
const acc = (id, principal, node, actions, more = {}) => ({ id, resource: `${id} policy`, kind: "queue", principal, principal_kind: "role", change: "added", actions, public: false, auth: "IAM role", auth_kind: "iam", at: `t.yaml:${id.length}`, node, ...more });
const cell = (m, r, c) => cellOf(m, m.rows.find((x) => x.name === r), m.cols.find((x) => x.name === c));
const marks = (m, r, c) => cell(m, r, c).map((e) => `${e.guard ? "guard " : ""}${e.mark[1]}: ${e.actions.map((a) => a.text).join(", ")}`);

// A principal's rows share a table row, a card's rights a column; a right on something the picture does not show is a
// column of its resource's name; the rows this PR changes come first, the more exposed principal before the role.
{
  const m = rightsOf({ arch, access: [
    acc("a1", "Worker role", "b", ["s3:GetObject"], { change: "unchanged" }),
    acc("a2", "Orders function", "q", ["sqs:SendMessage"], { used: false }),
    acc("a3", "Orders function", "b", ["s3:PutObject"], { change: "widened" }),
    acc("a4", "Orders function", null, ["logs:PutLogEvents"], { resource: "Orders logs", kind: "log group", change: "narrowed" }),
    acc("a5", "anyone on the internet", "h", ["call POST /orders"], { principal_kind: "internet", public: true, kind: "route" }),
    acc("a6", "Old role", "q", ["sqs:ReceiveMessage"], { change: "removed" }),
    acc("a7", "Deploy pipeline", "h", ["lambda:UpdateFunctionCode"], { principal_kind: "ci", change: undefined })] });
  assert.deepEqual(m.rows.map((r) => [r.name, r.kind, r.changed]), [["anyone on the internet", "internet", true], ["Deploy pipeline", "ci", true], ["Orders function", "role", true], ["Old role", "role", true], ["Worker role", "role", false]]);
  assert.deepEqual(m.cols.map((c) => [c.name, c.node, c.changed]), [["Archive bucket", "b", true], ["Orders queue", "q", true], ["Orders logs", null, true], ["handler", "h", true]]);
  assert.deepEqual(marks(m, "Orders function", "Orders queue"), ["added: sqs:SendMessage"]);
  assert.deepEqual(marks(m, "Orders function", "Archive bucket"), ["widened: s3:PutObject"]);
  assert.deepEqual(marks(m, "Orders function", "Orders logs"), ["narrowed: logs:PutLogEvents"]);
  assert.deepEqual(marks(m, "Old role", "Orders queue"), ["removed: sqs:ReceiveMessage"]);
  assert.deepEqual(marks(m, "Worker role", "Archive bucket"), ["unchanged: s3:GetObject"]);
  assert.deepEqual(marks(m, "Deploy pipeline", "handler"), ["not said: lambda:UpdateFunctionCode"], "a change the run does not say is not said, and shown with the changed ones");
  assert.deepEqual(cell(m, "Worker role", "Orders queue"), [], "an empty cell");
  assert.equal(cell(m, "Orders function", "Orders queue")[0].unused, true, "granted and not used stays at its cell");
  assert.equal(m.total, 7);
  assert.equal(m.line, "2 rights added, 1 widened, 1 narrowed, 1 removed, 1 with its change not said");
  assert.equal(m.note, NOTE);
  // every mark is a shape and a word
  for (const e of [...m.cells.values()].flat()) assert.ok(e.mark.length === 2 && e.mark[0] && e.mark[1], "a shape and a word");
}

// A rule that takes a right away is no right: it stands as a guard in the cell it protects (who is denied × the
// resource), is not counted as a right, says what it holds against, and one the PR narrows is marked as loosened.
{
  const m = rightsOf({ arch, access: [
    acc("a1", "Orders function", "q", ["sqs:SendMessage"]),
    acc("a2", "everyone but the Orders role", "q", ["sqs:SendMessage"], { effect: "deny", auth: "resource policy", holds_against: "Another role of the account sends forged events to the queue." }),
    acc("a3", "Orders function", "q", ["deny sqs:PurgeQueue"], { change: "narrowed" })] });
  assert.equal(m.total, 1, "one right; the two guards are none");
  assert.deepEqual(marks(m, "everyone but the Orders role", "Orders queue"), ["guard added: sqs:SendMessage"]);
  assert.deepEqual(marks(m, "Orders function", "Orders queue"), ["added: sqs:SendMessage", "guard narrowed: sqs:PurgeQueue"], "a guard beside the right in the same cell (an older run: actions that begin with deny)");
  const [g, loose] = [cell(m, "everyone but the Orders role", "Orders queue")[0], cell(m, "Orders function", "Orders queue")[1]];
  assert.deepEqual([g.guard, g.unused, g.loosened, loose.loosened], [true, false, false, true]);
  assert.equal(entryText(g), "⛨ guard, + added: denies sqs:SendMessage (t.yaml:2). Holds against: Another role of the account sends forged events to the queue.");
  assert.match(entryText(loose), /^⛨ guard, ▼ narrowed: denies sqs:PurgeQueue .*This PR loosens it\.$/);
  assert.equal(m.line, "1 right added, 2 guards, 1 narrowed or removed");
}

// Wildcards are said in words and marked: every action, every action of a service, a pattern, every resource.
{
  assert.deepEqual(["*", "s3:*", "s3:Get*", "s3:GetObject", "deny *"].map(actionOf), [{ text: "* (all actions)", wild: "all" }, { text: "s3:* (all actions)", wild: "all" }, { text: "s3:Get* (wildcard)", wild: "some" }, { text: "s3:GetObject", wild: null }, { text: "* (all actions)", wild: "all" }]);
  const m = rightsOf({ arch, access: [acc("a1", "Admin role", null, ["*"], { resource: "*" }), acc("a2", "Reader", "b", ["s3:Get*"]), acc("a3", "Gone", "b", ["s3:*"], { change: "removed" })] });
  assert.deepEqual(m.cols.map((c) => [c.name, c.wild]), [["* (all resources)", true], ["Archive bucket", false]]);
  assert.equal(m.line, "2 rights added, 1 removed, 1 with all actions", "a removed right with every action no longer counts as one");
}

// A cell names its crossing's number and carries the findings of that crossing (views.js crossingsOf's rows), and a
// finding that names the row itself.
{
  const f1 = { id: "f1", severity: "high", title: "Wide grant" }, f2 = { id: "f2", severity: "low", title: "Names the row", reachable_from: ["a2"] };
  const rows = [{ key: "e:3", aliases: ["a:a1"], findings: [f1] }, { key: "a:a9", findings: [] }];
  const m = rightsOf({ arch, access: [acc("a1", "Orders function", "q", ["sqs:*"]), acc("a2", "Orders function", "b", ["s3:PutObject"])], crossings: rows, findings: [f1, f2] });
  const [a, b] = [cell(m, "Orders function", "Orders queue")[0], cell(m, "Orders function", "Archive bucket")[0]];
  assert.deepEqual([a.crossing, a.crossKey, a.findings, b.crossing, b.findings], [1, "e:3", [f1], null, [f2]]);
  const md = rightsMd(m).join("\n");
  assert.match(md, /^## Who may do what \(2\)\n\n2 rights added, 1 with all actions\.\n/);
  assert.ok(md.includes(NOTE) && md.includes("| Who | Orders queue (queue) | Archive bucket (queue) |"));
  assert.ok(md.includes("| Orders function (role) | + added: sqs:* (all actions) (crossing 1, `t.yaml:2`) | + added: s3:PutObject (`t.yaml:2`) |"), md);
  assert.ok(md.includes("- Orders function on Orders queue: 1 unresolved finding (1 high), listed at crossing 1") && md.includes("- Orders function on Archive bucket: 1 unresolved finding (1 low): Names the row"), md);
}

// A large table: only the rows and columns this PR changes are open, at most MAX of each, with a line that counts the
// rest; a small one is open whole; "all" opens everything.
{
  const big = rightsOf({ arch, access: [...Array.from({ length: 14 }, (_x, i) => acc(`r${i}`, `Role ${i}`, null, ["s3:GetObject"], { resource: `Bucket ${i % 10}`, change: i < 3 ? "added" : "unchanged" }))] });
  assert.deepEqual([big.rows.length, big.cols.length], [14, 10]);
  const v = rightsShown(big);
  assert.deepEqual([v.rows.map((r) => r.name), v.cols.map((c) => c.name), v.more], [["Role 0", "Role 1", "Role 2"], ["Bucket 0", "Bucket 1", "Bucket 2"], 18]);
  assert.equal(v.moreLine, "11 more principals and 7 more resources are folded: this PR changes nothing there or they did not fit.");
  assert.deepEqual([rightsShown(big, true).rows.length, rightsShown(big, true).cols.length, rightsShown(big, true).moreLine], [14, 10, null]);
  const wide = rightsOf({ arch, access: Array.from({ length: 16 }, (_x, i) => acc(`r${i}`, `Role ${i}`, null, ["s3:GetObject"], { resource: `Bucket ${i}` })) });
  assert.deepEqual([rightsShown(wide).rows.length, rightsShown(wide).cols.length], [MAX.rows, MAX.cols], "all changed: the first that fit");
  const small = rightsOf({ arch, access: [acc("a1", "A", "q", ["x:y"], { change: "unchanged" })] });
  assert.deepEqual([rightsShown(small).rows.length, rightsShown(small).more, small.line], [1, 0, "no right changed by this PR"]);
  assert.equal(rightsMd(big).filter((l) => /^\| Role \d+ /.test(l)).length, 14, "the Markdown folds nothing");
}

// Nothing to show: no section.
assert.equal(rightsOf({ arch, access: [] }), null);
assert.equal(rightsOf(), null);
assert.deepEqual(rightsMd(null), []);

// PR #2 of the demo, as the security run wrote it: three rights added, the operator's way unchanged, each cell with
// the number of its crossing on the boundary map.
const fx = new URL("../../demo/fixtures/review/", import.meta.url);
if (existsSync(new URL("findings-s.json", fx))) {
  const an = JSON.parse(readFileSync(new URL("analysis-s.json", fx), "utf8")), fd = JSON.parse(readFileSync(new URL("findings-s.json", fx), "utf8"));
  const ai = withSecurity({ arch: (an.answer ?? an).architecture, access: [] }, fd.security);
  const rows = crossingsOf({ arch: ai.arch, access: ai.access, threats: ai.threats, gates: ai.gates, bypasses: ai.bypasses, findings: [] });
  const m = rightsOf({ arch: ai.arch, access: ai.access, crossings: rows });
  assert.equal(m.line, "3 rights added");
  assert.deepEqual(m.rows.map((r) => r.name), ["anyone on the internet", "FrontDesk function", "ReminderConsumer function", "operator who deploys handler (handler.py)"]);
  assert.deepEqual(m.cols.map((c) => [c.name, c.kinds]), [["handler (handler.py)", ["route", "configuration"]], ["LoanEvents (SQS)", ["queue"]]]);
  assert.deepEqual(marks(m, "FrontDesk function", "LoanEvents (SQS)"), ["added: sqs:SendMessage"]);
  const send = cell(m, "FrontDesk function", "LoanEvents (SQS)")[0];
  assert.ok(send.unused && send.crossing && rows[send.crossing - 1].key === send.crossKey && (rows[send.crossing - 1].aliases ?? [rows[send.crossing - 1].key]).includes("a:acc2"), "the cell opens the crossing its right is part of");
  assert.deepEqual(marks(m, "operator who deploys handler (handler.py)", "handler (handler.py)"), ["unchanged: set FRONT_DESK_TOKEN"]);
}
console.log("rights ok");
