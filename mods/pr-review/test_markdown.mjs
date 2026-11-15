// Run: node test_markdown.mjs
import assert from "node:assert/strict";
import { diffRows } from "./pr.js";
import { rowsByPath, codeContext, codeStats, mdParts, mdJoin, mdHead, mdLines, CODE_MAX, fenceLang } from "./markdown.js";
import { prLine, mermaidFlow, visualMd, findingMd, findingsMd, overviewMd, layerMd, architectureMd, securityMd, cardOf, wayIn, verifyContextMd } from "./markdown.js";

const pr = { repo: "o/r", number: 2, title: "feat: x", url: "https://example.test/pull/2" }, head = "abcdef1234", base = { pr, head };
const first = 'PR o/r#2 "feat: x" at commit abcdef1 (https://example.test/pull/2)';
assert.equal(prLine(base), first);
const mermaid = (text) => { const m = /```mermaid\n([\s\S]*?)\n```/.exec(text); assert.ok(m, "a mermaid block"); return m[1].split("\n"); };

{
  // A flowchart stays valid Mermaid whatever the names are: a keyword, a space or a bracket in an id gets a numbered
  // id, a label is quoted with its quotes, angle brackets, pipes and "#" as entity codes, a backtick as an apostrophe.
  // An id used twice is one card (the first); a call to something that is no card gets one.
  const lines = mermaidFlow({ groups: [{ id: "g", label: 'Front "desk" (Lambda)', kind: "Service" }],
    nodes: [{ id: "end", group: "g", label: 'handler: POST /remind (new) "x" <b> a|b #1 `code`', status: "new" }, { id: "a b", label: "plain", status: "changed" }, { id: "ok_1", label: "third", source: "spec" },
      { id: "ok_1", label: "twice" }],
    edges: [{ from: "end", to: "a b", label: 'calls "it": f(x) | g', status: "removed" }, { from: "a b", to: "ok_1", label: "", source: "spec" }, { from: "ok_1", to: "queue[1]" }] });
  assert.deepEqual(lines, ["```mermaid", "flowchart LR",
    '  subgraph group0["Front #quot;desk#quot; (Lambda) (Service)"]',
    "    n0[\"handler: POST /remind (new) #quot;x#quot; #lt;b#gt; a#124;b #35;1 'code'\"]:::new",
    "  end",
    '  n1["plain"]:::changed', '  ok_1["third (spec only)"]', '  n3["queue[1]"]',
    '  n0 -->|"calls #quot;it#quot;: f(x) #124; g (removed)"| n1', '  n1 -.->|"(spec only)"| ok_1', "  ok_1 --> n3",
    "  classDef new stroke:#2da44e,stroke-width:2px", "  classDef changed stroke:#bf8700,stroke-width:2px", "```"]);
  // A numbered id never takes a card's own.
  assert.deepEqual(mermaidFlow({ nodes: [{ id: "a b", label: "x" }, { id: "n0", label: "y" }], edges: [] }).slice(2, 4), ['  n0_["x"]', '  n0["y"]']);
  console.log("ok flowchart");
}

{
  // A state diagram: a name in quotes, a transition's text without ":" and ";" (they end it); the start points at the
  // state nothing leads to, the state that leads nowhere ends it. A sequence: participants without the characters
  // that end a name, messages numbered in order, a semicolon as its code.
  const state = visualMd({ kind: "state_machine", title: "Loan: status", nodes: [{ id: "state", label: 'BORROWED "new"' }, { id: "due", label: "DUE: soon", changed: true }, { id: "back", label: "RETURNED" }],
    transitions: [{ from: "state", to: "due", event: "tick", guard: "days <= 2", action: "mail; publish x:y", changed: true }, { from: "due", to: "back", label: "give_back" }, { from: "due", to: "due", error: "retry" }] });
  assert.equal(state[0], "### State diagram: Loan: status");
  assert.deepEqual(mermaid(state.join("\n")), ["stateDiagram-v2", '  state "BORROWED #quot;new#quot;" as s0', '  state "DUE: soon (changed)" as due', '  state "RETURNED" as back', "  [*] --> s0",
    "  s0 --> due : tick [days #lt;= 2] / mail#59; publish x#58;y (changed)", "  due --> back : give_back", "  due --> due : retry", "  back --> [*]"]);
  const seq = mermaid(visualMd({ kind: "sequence", title: "", nodes: [{ id: "loop", label: "handler: /remind, v2" }, { id: "mail", label: "Mailer" }],
    edges: [{ from: "loop", to: "mail", label: "send(to); retry #2" }, { from: "mail", to: "loop", label: "", source: "spec" }] }).join("\n"));
  assert.deepEqual(seq, ["sequenceDiagram", "  participant p0 as handler#58; /remind#44; v2", "  participant mail as Mailer", "  p0->>mail: 1. send(to)#59; retry #35;2", "  mail-->>p0: 2. calls (spec only)"]);
  // Steps are a numbered list in their order; a flow is a flowchart.
  assert.deepEqual(visualMd({ kind: "steps", title: "Run", nodes: [{ id: "b", label: "second", at: "a.py:2" }, { id: "a", label: "first", note: "once" }], edges: [{ from: "a", to: "b" }] }),
    ["### Steps: Run", "", "1. first: once", "2. second (`a.py:2`)", ""]);
  assert.equal(mermaid(visualMd({ kind: "flow", title: "f", nodes: [{ id: "a", label: "A", changed: true }], edges: [] }).join("\n"))[1], '  a["A"]:::changed');
  console.log("ok pictures");
}

const f = (id, severity, extra = {}) => ({ id, ids: [id], severity, title: `T ${id}`, file: "a.py", line: 3, end: 3, security: false, category: "bug", criteria: [], preconditions: [], certainty: null, impact: null,
  effect: "", detail: "", suggestion: "", sources: [{ id, reviewer: "analysis", severity, title: `T ${id}`, detail: "" }], ...extra });
const sec = f("s1", "high", { security: true, category: "security", end: 9, impact: "unauthorized_access", certainty: "assumed", preconditions: ["no token set", "no authorizer"], effect: "Anyone calls it.",
  detail: "The token defaults to `\"\"`.", suggestion: "Fail closed:\n\n```py\nif not TOKEN:\n    raise RuntimeError\n```", criteria: ["c1"], breaks: { from: "h", to: "c" },
  sources: [{ id: "s1", reviewer: "security", severity: "high", title: "T s1", detail: "The token defaults to `\"\"`." }, { id: "a9", reviewer: "analysis", severity: "medium", title: "No token", detail: "Template sets none." }], ids: ["s1", "a9"] });
const asks = [{ id: "c1", text: "Only staff call it", state: "broken", why: "No check.", acceptance: true, findings: ["a9"] }, { id: "c2", text: "Mails once", state: "partly", why: "", acceptance: true, findings: [] },
  { id: "x1", text: "A new route", state: "extra", why: "", acceptance: false, findings: [] }];
const all = [f("m1", "medium", { breaks: { node: "c" } }), sec, f("l1", "low"), f("d1", "high")], st = { d1: "dismissed", m1: "progress" }, statusOf = (x) => st[x.id] ?? "open";

{
  // A finding: everything it says, a security finding too; the suggestion's own markdown (a fenced block) stays.
  const text = findingMd(sec, { ...base, status: "open", asks });
  assert.ok(text.startsWith(`${first}\n\n# Finding: T s1\n\n`));
  for (const line of ["- **Severity:** high, because it allows access without permission. On this scale, high means: it breaks a requirement, leaves a dead path, allows unauthorized access, exposes data or loses data.",
    "- **Where:** `a.py:3-9`", "- **State:** Unresolved", "- **Found by:** Security review (high), Analysis (medium)", "- **Category:** security", "- **Certainty:** Assumed: it depends on something that could not be checked.",
    "- **Preconditions:**\n  - no token set\n  - no authorizer", "- **Breaks these criteria:**\n  - broken: Only staff call it", "## Effect\n\nAnyone calls it.", '## Detail\n\nThe token defaults to `""`.',
    "## Suggestion\n\nFail closed:\n\n```py\nif not TOKEN:\n    raise RuntimeError\n```", "## Also reported as\n\n- Analysis (medium): No token. Template sets none."]) assert.ok(text.includes(line), line);
  // An older finding says nothing about certainty or effect: those lines are not there, nothing is made up.
  const old = findingMd(f("o1", "medium"), base);
  assert.doesNotMatch(old, /Certainty|Preconditions|Effect|Detail|Suggestion|Also reported/);
  assert.match(findingMd(f("o2", "low", { certainty: "derived" }), base), /- \*\*Preconditions:\*\* none, it always happens/);
  // All unresolved ones, most severe first; the dismissed one is out, a fix sent stays in.
  const list = findingsMd(all, { ...base, statusOf, asks });
  assert.ok(list.startsWith(`${first}\n\n# 3 unresolved findings: 1 high, 1 medium, 1 low\n\n`) && list.includes("\n\n## High (1)\n\n### 1. T s1\n"));
  assert.match(list, /\n3 unresolved: 1 high, 1 medium, 1 low · 1 with a fix sent · 1 dismissed\n/, "the tab's count line");
  assert.match(list, /## Fixed or dismissed \(1\)\n\n- \*\*high\*\*: T d1/, "the settled ones by title");
  assert.deepEqual(list.match(/^##+ .*\(\d+\)$|^### \d+\. .*/gm), ["## High (1)", "### 1. T s1", "## Medium (1)", "### 2. T m1", "## Low (1)", "### 3. T l1", "## Fixed or dismissed (1)"], "a part per severity, the findings numbered through");
  assert.match(list, /### 2\. T m1\n\n- \*\*Severity:\*\* medium[^\n]*\n- \*\*Where:\*\* `a\.py:3`\n- \*\*State:\*\* Fix sent/);
  assert.match(list, /#### Effect\n\nAnyone calls it\./, "a finding's parts sit one level below its heading");
  assert.ok(findingsMd([], base).startsWith(`${first}\n\n# 0 unresolved findings\n`));
  console.log("ok findings");
}

{
  const ai = { asks, unlinked: ["c2"], summary: "Adds a route.", behavior: "Staff can remind.", behaviorPoints: [], mergeRisk: { level: "high", why: "No auth." }, componentCounts: { new: 1, changed: 0, no_owner: 1, codeowners: true },
    rules: [{ rule: "Tests for new code", source: "CLAUDE.md", status: "fail", where: "a.py:3", why: "None." }] };
  const text = overviewMd({ ...base, ai, findings: all, statusOf, checks: [{ name: "Conventional Commit title", ok: true, why: "feat: x" }, { name: "CI: unit", ok: false, why: "fail", ci: true }, { name: "Tests for new code", ok: false, rule: true }],
    related: { stacked_on: { number: 1, title: "base", url: "https://example.test/pull/1" } } });
  assert.ok(text.startsWith(`${first}\n\n# Review overview: feat: x\n\n**Verdict:** 1 security cause, high (assumed reachable) · 0 of 2 acceptance criteria met · 2 checks failed\n**Merge risk:** high. No auth.\n`));
  assert.match(text, /\*\*Stacked on:\*\* #1 base \(https:\/\/example\.test\/pull\/1\)\. This PR merges after it\.\n\*\*Components:\*\* 1 new component, 1 without an owner\n/);
  assert.match(text, /## Check against the task: 0 of 2 acceptance criteria met, 1 extra\n\n### Security\n\n- \*\*high\*\* security: T s1 \(`a\.py:3-9`\) · Assumed, not checked\n/);
  assert.match(text, /### Acceptance criteria\n\n- \*\*broken\*\*: Only staff call it\n  - Why: No check\.\n  - \*\*high\*\* security: T s1 [^\n]*\n- \*\*partly\*\*: Mails once\n  - No finding backs this state\.\n/);
  assert.match(text, /### Not in the task\n\n- \*\*extra\*\*: A new route\n- 2 unresolved findings belong to no criterion:\n  - \*\*medium\*\*: T m1 \(`a\.py:3`\) · Fix sent\n  - \*\*low\*\*: T l1 /);
  // What the PR does, as the page lists it (pr.js doesList: what it adds, changes and does at run time), then the rules.
  assert.match(text, /## What changed\n\nAdds a route\.\n\n## What the PR does\n\nAdds:\n\n- Adds a route\.\n\nAt run time:\n\n- Staff can remind\.\n\n## Repo rules and checks \(3\)\n\n- passed: Conventional Commit title\n- failed: CI: unit\. fail\n- failed: Tests for new code \(CLAUDE\.md, `a\.py:3`\)\. None\.\n$/);
  // What the view adds: the suggested action, the rows before the merge with their code, what nobody checked.
  const rows = [{ kind: "security", title: "T s1", finding: sec, asks: [{ text: "Only staff call it", short: "Staff only" }], where: "a.py:3", also: ["t.yaml:14"] }, { kind: "resilience", title: "A mail is lost", why: "Blocker: an effect is lost", where: "a.py:4", asks: [] }];
  const code = rowsByPath(new Map([["a.py", diffRows(["@@ -1,3 +1,6 @@", " import os", "-TOKEN = None", "+TOKEN = os.environ.get('T', '')", " ", "+def remind():", "+    send()", "+    return 202"])]]));
  const full = overviewMd({ ...base, ai, findings: all, statusOf, action: "Request changes", rows, code, nc: { text: "1 area not checked", areas: ["dependencies"], assumptions: [sec], security: "2 findings" }, resLine: "3 paths, 1 blocker", cost: "$0.50 (Analysis $0.50)", size: "2 files +5 −1" });
  assert.match(full, /\*\*Verdict:\*\* Request changes: 1 security cause/);
  assert.match(full, /## Before merge \(2\)\n\nWhat stands before the merge, most urgent first\.\n\n- \*\*Security:\*\* \*\*high\*\* security: T s1 [^\n]*\n  - Breaks: Staff only\n(  - [a-z ]*reachable[a-z ]*\n)?  - Same cause also at t\.yaml:14\n\nCode `a\.py:1-6`:\n\n```diff\n import os\n-TOKEN = None\n\+TOKEN = os\.environ\.get\('T', ''\)\n/);
  assert.match(full, /- \*\*Resilience:\*\* A mail is lost \(`a\.py:4`\)\n  - Blocker: an effect is lost\n\nCode: see `a\.py:1-6` above\.\n/, "a place already shown is not shown twice");
  assert.match(full, /## Not checked\n\n1 area not checked\n\n- Areas no run checked: dependencies\n- 1 finding rests on an assumption nobody checked:\n  - \*\*high\*\* security: T s1 [^\n]*\n- Security review: 2 findings\n- Resilience review: 3 paths, 1 blocker\n/);
  // An analysis from before the newer fields: the asks without reason and findings, every ask a criterion.
  const old = overviewMd({ ...base, ai: { asks: asks.map((a) => ({ ...a, why: "", acceptance: null, findings: [] })), unlinked: [], rules: [] }, findings: [], statusOf });
  assert.match(old, /## Check against the task: 0 of 2 criteria met, 1 extra\n\n### Criteria\n\n- \*\*broken\*\*: Only staff call it\n- \*\*partly\*\*: Mails once\n\n### Not in the task\n\n- \*\*extra\*\*: A new route\n$/);
  // No analysis: the reviewers' findings under the PR's line, and it says so.
  const none = overviewMd({ ...base, findings: [f("r1", "medium")], statusOf });
  assert.match(none, /\*\*Verdict:\*\* 1 unresolved finding\nNo analysis of this diff yet[^\n]*\n\n## Unresolved findings\n\n### Other findings\n\n- \*\*medium\*\*: T r1 /);
  console.log("ok overview");
}

{
  const step = { title: "The route", risk: "high", why: "It is public.", text: "Adds `POST /remind`.", questions: ["Who may call it?", "Is it tested?"], questionFiles: ["a.py", ""],
    visuals: [{ kind: "sequence", title: "Call", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }] }],
    flows: [{ function: "remind", at: "a.py:3", inputs: [{ name: "id", type: "int", example: "7" }], output: { type: "dict", example: "{}" }, side_effects: ["mails"], calls: ["send"] }] };
  const text = layerMd(step, { ...base, n: 2, files: ["a.py", "b.py"], findings: all, statusOf });
  assert.ok(text.startsWith(`${first}\n\n# Layer 2: The route\n\n**Risk:** high\n**Why it matters:** It is public.\n\nAdds \`POST /remind\`.\n\n## Files\n\n- \`a.py\`\n- \`b.py\`\n\n## Questions to check\n\n- \`a.py\`: Who may call it?\n- Is it tested?\n`));
  assert.match(text, /## Findings: 3 unresolved, 1 high, 1 medium, 1 low\n\n- \*\*high\*\* security: T s1 [^\n]*\n  - Anyone calls it\.\n\n- \*\*medium\*\*: T m1 [^\n]*\n\n- \*\*low\*\*: T l1 [^\n]*\n\n## Pictures \(1\)\n\n### Sequence: Call\n\n```mermaid\nsequenceDiagram\n/);
  assert.match(text, /## Functions with example values \(1\)\n\n- `remind` at `a\.py:3`\n  - in: `id` \(int\), for example `7`\n  - out: dict, for example `\{\}`\n  - side effects: mails\n  - calls: `send`\n$/);
  assert.match(layerMd({ title: "Docs", risk: "skim" }, base), /# Layer: Docs\n\n\*\*Risk:\*\* low, skimmed by the analysis\n\n## Findings: none unresolved\n$/);
  console.log("ok layer");
}

{
  const ai = { arch: { groups: [{ id: "g1", label: "API", kind: "Service" }], nodes: [{ id: "h", group: "g1", label: "handler", type: "function", status: "changed", at: "a.py:3", description: "The entry." }, { id: "c", label: "consumer", status: "new" }],
    edges: [{ from: "h", to: "c", label: "calls", status: "new" }] }, componentCounts: { new: 1, changed: 0, no_owner: 1, codeowners: true },
    components: [{ name: "consumer | v2", kind: "lambda", status: "new", at: "c.py:1", operate: ["no alarm", "no DLQ"], owner: null }, { name: "queue", kind: "queue", status: "new", at: "", operate: [], owner: "@team" }],
    visuals: [{ kind: "state_machine", title: "Loan", nodes: [{ id: "a", label: "A" }], transitions: [] }] };
  const text = architectureMd({ ...base, ai, findings: all, statusOf });
  // The map as the page draws it: the systems as frames, the unresolved findings at a card or a call in its text.
  assert.ok(text.startsWith(`${first}\n\n# Architecture impact\n\n2 cards: 1 new, 1 changed. A card's class in the diagram is its status; a dashed call is only in the spec. The frames are the systems; a card or a call with unresolved findings says how many.\n1 new component, 1 without an owner.\n\n\`\`\`mermaid\nflowchart LR\n  subgraph group0["API (Service)"]\n    h["handler (low: 1 finding)"]:::changed\n  end\n  c["consumer (medium: 1 finding)"]:::new\n  h -->|"calls (new, high: 1 finding)"| c\n`));
  // Each card as its panel shows it: what it is, its file, the findings on it and on its calls, its connections, its text.
  assert.match(text, /## Cards \(2\)\n\n### handler\n\n- changed, function, in API\n- \*\*File:\*\* `a\.py:3`\n- \*\*Unresolved findings \(2\):\*\*\n  - \*\*high\*\* security: T s1 [^\n]*, breaks the call to consumer\n  - \*\*low\*\*: T l1 \(`a\.py:3`\)\n- \*\*Connections:\*\*\n  - → consumer: calls\n\nThe entry\.\n\n### consumer\n\n- new\n- \*\*File:\*\* the analysis names no file for this card\n/);
  assert.match(text, /  - \*\*medium\*\*: T m1 [^\n]*, breaks the flow here\n- \*\*Connections:\*\*\n  - ← handler: calls\n/);
  assert.match(text, /## Calls \(1\)\n\n[^\n]*\n\n\| # \| Call \| What \| Status \| Unresolved findings \|\n[^\n]*\n\| 1 \| handler → consumer \| calls \| new \| high: T s1 \|\n/);
  assert.match(text, /## Where the flow breaks \(2\)\n\n- Call handler → consumer: \*\*high\*\* security: T s1 [^\n]*\n- Card consumer: \*\*medium\*\*: T m1 [^\n]*\n/);
  assert.match(text, /## Components this PR adds or changes \(2\)\n\n\| Component \| Kind \| Status \| Where \| Owner \| To operate \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| consumer \\\| v2 \| lambda \| new \| `c\.py:1` \| no owner \| no alarm; no DLQ \|\n\| queue \| queue \| new \| - \| @team \| nothing named \|\n/);
  assert.match(text, /## Other pictures \(1\)\n\n### State diagram: Loan\n\n```mermaid\nstateDiagram-v2\n  state "A" as a\n  \[\*\] --> a\n```\n$/);
  // From the view: the layers that read a card's code, how many changed places its file has; the code where the flow breaks.
  const more = architectureMd({ ...base, ai, findings: all, statusOf, layersOf: (n) => (n.id === "h" ? ["The route"] : []), placesIn: () => 2, code: rowsByPath(new Map([["a.py", diffRows(["@@ -1,2 +1,3 @@", " a", "+b", " c"])]])) });
  assert.match(more, /- \*\*File:\*\* `a\.py:3`, 2 changed places in this PR\n/); assert.match(more, /- \*\*Layers on this code:\*\* The route\n/);
  assert.match(more, /## Code where the flow breaks\n\nCode `a\.py:1-3`:\n\n```diff\n a\n\+b\n c\n```\n/);
  assert.match(architectureMd({ ...base, ai: { arch: null } }), /# Architecture impact\n\nThe analysis has no architecture picture for this PR\.\n$/);
  console.log("ok architecture");
}

{
  const ai = { asks, access: [{ resource: "Api", kind: "route", principal: "anyone on the internet", actions: ["call GET /late", "call POST /remind"], public: true, auth: "bearer token", used: true, at: "t.yaml:24" },
    { resource: "Queue", kind: "queue", principal: "role", actions: ["sqs:SendMessage"], public: false, auth: "IAM", at: "" }],
    scope: { checked: [{ area: "authentication", result: "finding", note: "empty token" }, { area: "input_validation", result: "not_checked", note: "" }, { area: "tests", result: "clean", note: "" }] } };
  const runs = { claude: { state: "done", scope: { read: ["a.py"], checked: [{ area: "tests", result: "finding", note: "" }], skipped: [] } },
    security: { state: "done", model: "m-1", scope: { read: ["the diff", "a.py"], checked: [{ area: "secrets", result: "clean", note: "none" }], skipped: ["tests"] } }, codex: { state: "failed", scope: null, error: "boom" } };
  const text = securityMd({ ...base, ai, findings: all, statusOf, runs });
  // The page's sentence, then every crossing in its open form (views.js crossingsOf: here two the data does not assess).
  assert.ok(text.startsWith(`${first}\n\n# Security\n\n1 unresolved security finding: 1 high.\n\nThe way in is Api, open to anyone on the internet;`));
  assert.match(text, /## Trust boundary crossings \(2\)\n\n[^\n]*\n\n### 1\. anyone on the internet → no zone named\n\n- \*\*Way in:\*\* Api\n- \*\*Result:\*\* Not assessed: No threat names this crossing\. Change by this PR: not said\.\n- \*\*Who:\*\* anyone on the internet\n- \*\*Check:\*\* bearer token \(`t\.yaml:24`\)\n- \*\*Holds only if:\*\* not named\n/);
  assert.match(text, /### 2\. role → no zone named\n\n- \*\*Right:\*\* Queue \(sqs:SendMessage\)\n[^\n]*\n- \*\*Who:\*\* role \(principal not mapped to a card\)\n/);
  assert.doesNotMatch(text, /## Boundary picture/, "no picture without a line to draw");
  assert.match(text, /## Findings \(1, full text\)\n\n### 1\. T s1\n\n- \*\*Severity:\*\* high/);
  assert.match(text, /- \*\*Order:\*\* Not known from where it can be reached, high severity\.\n/, "why it stands where it stands, as on the page");
  assert.match(text, /#### Suggestion\n\nFail closed:\n\n```py\n/, "a security finding is here in full");
  assert.match(text, /## Exposure\n\n1 way in: 1 reachable from the internet \(0 without a check of the caller\), 0 opened by this PR\.\n\n\| Way in \| Kind \| Who \| May \| From the internet \| Check \| Opened by this PR \| Evidence \|\n[^\n]*\n\| Api \| route \| anyone on the internet \| call GET \/late; call POST \/remind \| yes \| bearer token \| not stated \| `t\.yaml:24` \|\n\n/);
  // Without zones the blast radius is the rights by who holds them; the rights table has no way in twice.
  assert.match(text, /## Blast radius\n\nThe analysis names no trust zones\. The rights granted, by who holds them:\n\n- \*\*role\*\* can sqs:SendMessage on Queue\.\n\n## Rights granted \(1\)\n\n\| Resource \| Kind \| Who \| May \| Auth \| Used by the code \| Where \|\n[^\n]*\n\| Queue \| queue \| role \| sqs:SendMessage \| IAM \| - \| - \|\n\n/);
  // What each run checked: the page's table (an area by run), each run's own line, and where two runs contradict.
  assert.match(text, /## What each run checked\n\n[^\n]*\n\n\| Area \| Analysis \| Claude code review \| Security review \|\n[^\n]*\n\| Authentication \| finding: empty token \| – \| – \|\n\| Input validation \| not checked \| – \| – \|\n\| Tests \| clean \| finding \| – \|\n\| Secrets \| – \| – \| clean: none \|\n/);
  assert.match(text, /- \*\*Security review:\*\* done \(m-1\)\. Read: the diff; a\.py\. Left out: tests\. Allowed: [^\n]*\.\n- \*\*Codex review:\*\* failed\. Error: boom\. It does not say what it checked\.\n\nContradictions:\n\n- Tests: [^\n]*\n$/);
  // With zones, gates and a threat: the way through the gate, what an attacker controls, the picture numbered like the list, the gate's code.
  const z = { asks, arch: { zones: [{ id: "pub", name: "Internet", trust: "public" }, { id: "app", name: "App", trust: "authenticated" }], groups: [{ id: "g", label: "API" }],
    nodes: [{ id: "client", label: "Client", type: "external", zone: "pub", group: "g" }, { id: "h", label: "handler", zone: "app", group: "g", at: "a.py:3" }], edges: [{ from: "client", to: "h", label: "POST /x", crosses: true, status: "new" }] },
    access: [{ id: "acc1", resource: "Api", kind: "route", principal: "anyone on the internet", actions: ["call POST /x"], public: true, auth: "token", node: "h", at: "a.py:3", opened_by_pr: true }],
    gates: [{ where: { access: "acc1" }, principal: "token holder", check: "token", at: "a.py:2", source: "code", holds_if: "TOKEN is set", carries: ["Authorization header"] }],
    threats: [{ id: "t1", where: { access: "acc1" }, threat: "An empty token passes.", stride: "S", result: "finding", findings: ["s1"], goal: "Calls the route" }] };
  const code = rowsByPath(new Map([["a.py", diffRows(["@@ -1,2 +1,4 @@", " import os", "+TOKEN = os.environ.get('T', '')", "+def handler(event):", " pass"])]]));
  const zoned = securityMd({ ...base, ai: z, findings: all, statusOf, runs: {}, code });
  assert.match(zoned, /### 1\. anyone on the internet → App\n\n- \*\*Way in:\*\* Api\n- \*\*Result:\*\* Finding\. Change by this PR: added\.\n- \*\*Who:\*\* anyone on the internet\n- \*\*Check:\*\* token, in the code, expects token holder \(`a\.py:2`\)\n- \*\*Holds only if:\*\* TOKEN is set\n- \*\*Way:\*\* [^\n]*handler\n- \*\*An attacker controls:\*\* Authorization header\n- \*\*At the end they reach:\*\* Calls the route\n/);
  assert.match(zoned, /- Threat t1 \(STRIDE S\), finding: An empty token passes\.\n- \*\*Findings at this crossing:\*\*\n  - \*\*high\*\* security: T s1 /);
  assert.match(zoned, /Code `a\.py:1-4`:\n\n```diff\n import os\n\+TOKEN = os\.environ\.get\('T', ''\)\n\+def handler\(event\):\n pass\n```\n/, "the gate's lines");
  assert.match(zoned, /## Boundary picture\n\n[^\n]*\n\n```mermaid\nflowchart LR\n  subgraph group0\["Outside \(public\)"\]\n    n0\["anyone on the internet"\]\n  end\n  subgraph group1\["App \(authenticated\)"\]\n    h\["handler[^"\n]*"\]\n  end\n  n0 -->\|"1\. ‖ token · Authorization header"\| h\n```\n/);
  assert.match(zoned, /### 1\. T s1\n\n[^]*?- \*\*Reachable from:\*\* anyone on the internet through Api \(crossing 1, anyone on the internet → App\)\.\n- \*\*Way:\*\* [^\n]* Holds only if: TOKEN is set\.\n\nCode: see `a\.py:1-4` above\.\n/);
  assert.match(securityMd({ ...base, findings: [] }), /0 unresolved security findings\.\n\n## Trust boundary crossings \(0\)\n\n[^]*## Findings \(0\)\n\nNo unresolved security finding\.\n\n## What each run checked\n\n[^\n]*\n\nNo analysis of this diff yet\.\n\nNo reviewer has looked at security\.\n$/);
  console.log("ok security");
}

{
  // Trust zones: they are the frames with their trust level, a card without a zone stands outside every frame, a
  // call over a boundary is a thick line that says so. The way to a finding is red: its cards in the class "way",
  // its calls by their place among the drawn lines.
  const arch = { groups: [{ id: "g", label: "Lambda" }], zones: [{ id: "z1", name: "Internet", trust: "public" }, { id: "z2", name: 'Front "desk": fn', trust: "authenticated" }],
    nodes: [{ id: "caller", label: "Client", type: "external", zone: "z1", group: "g" }, { id: "h", label: "handler (a.py)", zone: "z2", group: "g", at: "a.py:10", status: "changed" }, { id: "ev", label: "events", group: "g", at: "e.py:1" }],
    edges: [{ from: "x", to: "y" }, { from: "caller", to: "h", label: "POST /remind", crosses: true }, { from: "h", to: "ev", label: "publish", source: "spec", crosses: true }] };
  assert.deepEqual(mermaidFlow({ ...arch, edges: arch.edges.slice(1) }, { path: { nodes: ["caller", "h"], edges: [0] } }), ["```mermaid", "flowchart LR",
    '  subgraph zone0["Internet (trust: public)"]', '    caller["Client"]', "  end", '  subgraph zone1["Front #quot;desk#quot;: fn (trust: authenticated)"]', '    h["handler (a.py)"]:::changed', "  end", '  ev["events"]',
    '  caller ==>|"POST /remind (crosses a trust boundary)"| h', '  h -.->|"publish (crosses a trust boundary, spec only)"| ev',
    "  classDef changed stroke:#bf8700,stroke-width:2px", "  classDef way fill:#ffebe9,stroke:#cf222e,stroke-width:3px", "  class caller,h way", "  linkStyle 0 stroke:#cf222e,stroke-width:3px", "```"]);
  // linkStyle counts the drawn lines: a call between unknown cards is drawn too (each gets a card), so index 1 is line 1.
  assert.ok(mermaidFlow(arch, { path: { nodes: [], edges: [1] } }).includes("  linkStyle 1 stroke:#cf222e,stroke-width:3px"));

  // The card a finding sits on: the one it breaks, else the nearest in its file; none on the map: null.
  assert.equal(cardOf({ file: "x.py", line: 1, breaks: { node: "ev" } }, arch), "ev");
  assert.equal(cardOf({ file: "a.py", line: 3, breaks: { from: "h", to: "ev" } }, arch), "h");
  assert.equal(cardOf({ file: "a.py", line: 3 }, arch), "h");
  assert.equal(cardOf({ file: "zz.py", line: 3 }, arch), null);
  // A line in a template: the card of the component defined nearest to it, not the nearest card in that file.
  assert.equal(cardOf({ file: "t.yaml", line: 18 }, { nodes: [...arch.nodes, { id: "q", label: "Queue", at: "t.yaml:11" }] }, [{ name: "Fn", at: "t.yaml:14", node: "h" }, { name: "Gone", at: "t.yaml:18", node: "nope" }]), "h");

  // The way in: the entry the finding names (stated), else a way in whose card leads to the finding's (derived); an
  // external caller starts it.
  const access = [{ id: "acc1", resource: "HttpApi", kind: "route", principal: "anyone", actions: ["call POST /remind"], public: true, auth: "token in handler", auth_kind: "code", node: "h", at: "t.yaml:24", opened_by_pr: true },
    { id: "acc2", resource: "Send policy", kind: "queue", principal: 'Front "desk": fn', actions: ["sqs:SendMessage"], public: false, auth: "IAM", auth_kind: "iam", used: false, node: "ev" },
    { id: "acc3", resource: "Admin", kind: "endpoint", principal: "anyone", actions: ["call /admin"], public: true, auth: "none", auth_kind: "none", node: "ev", opened_by_pr: false }];
  const ai = { arch, access, asks };
  assert.deepEqual(wayIn({ file: "a.py", line: 9, reachable_from: ["acc1"] }, ai), { entry: access[0], nodes: ["caller", "h"], edges: [1], crosses: true, stated: true, card: "h", reaches: true });
  const derived = wayIn({ file: "e.py", line: 1 }, ai); // acc3 sits on ev itself: shorter than acc1's way over h
  assert.deepEqual([derived.entry.id, derived.nodes, derived.stated], ["acc3", ["ev"], false]);
  assert.equal(wayIn({ file: "zz.py", line: 1 }, ai), null);

  const tok = f("t1", "high", { security: true, category: "security", file: "a.py", line: 9, reachable_from: ["acc1"], reachability: "public", certainty: "derived", preconditions: ["TOKEN is unset"], suggestion: "Set it.", criteria: ["c1"] });
  const inner = f("t2", "high", { security: true, category: "security", file: "e.py", line: 1, reachability: "internal_only", certainty: "assumed" });
  const sec = securityMd({ ...base, ai, findings: [inner, tok], statusOf: () => "open" });
  // Most reachable first, each with how it is reached.
  assert.deepEqual(sec.slice(sec.indexOf("## Findings")).match(/^### \d+\. .*/gm), ["### 1. T t1", "### 2. T t2"]);
  // As the page says it: why it stands there, its crossing and the way through the gate; without a crossing, the way in it sits at.
  assert.match(sec, /- \*\*Order:\*\* Reachable from the internet, over a trust boundary, high severity\.\n- \*\*Reachable from:\*\* anyone through HttpApi \(crossing 1, anyone → Front "desk": fn\)\.\n- \*\*Way:\*\* anyone → ‖ token in handler → handler \(a\.py\)\.\n/);
  assert.match(sec, /- \*\*Order:\*\* Reachable only from inside, over a trust boundary, high severity\.\n- \*\*Reachable from:\*\* Admin: public, no auth, reached by anyone\. Derived from the map: the finding sits at this way in\.\n/);
  // Exposure: the unchecked public way in first, the sum in the first sentence.
  assert.match(sec, /## Exposure\n\n2 ways in: 2 reachable from the internet \(1 without a check of the caller\), 1 opened by this PR\.\n\n[^\n]*\n[^\n]*\n\| Admin \| endpoint \| anyone \| call \/admin \| yes \| none \| no \| - \|\n\| HttpApi \| route \| anyone \| call POST \/remind \| yes \| in the code: token in handler \| yes \| `t\.yaml:24` \|\n/);
  // Blast radius per zone: the rights its holder has (unused marked), the zones and loose cards its calls reach; a
  // zone of external callers only is left out.
  assert.match(sec, /## Blast radius\n\n[^\n]*\n\n- \*\*Front "desk": fn\*\* \(authenticated\): If it is compromised, it can sqs:SendMessage on Send policy \(granted, not used by the code\)\. Its calls reach 1 card outside every zone \(events\)\.\n\n## Rights granted/);
  assert.doesNotMatch(sec, /\*\*Internet\*\*/);
  // The architecture with zones, as the page draws it: the frames are the systems, each card names its zone.
  const am = architectureMd({ ...base, ai: { arch } });
  assert.match(am, /a card names its trust zone, a thick call crosses a trust boundary\. The frames are the systems;/);
  assert.match(am, /### handler \(a\.py\)\n\n- changed, in Lambda, zone: Front "desk": fn \(authenticated\)\n- \*\*File:\*\* `a\.py:10`\n/); assert.match(am, /### events\n\n- unchanged, in Lambda, zone: none\n- \*\*File:\*\* `e\.py:1`\n/);
  assert.match(am, /\["handler \(a\.py\) \(zone: authenticated[^"]*\)"\]/, "a card's zone is in its text on the map");

  // The context for a checking agent: the findings, the whole map with the way in red and as text, exposure, blast
  // radius, the threat model, what this PR cannot tell, the layer's pictures. No instructions.
  const steps = [{ title: "The route", findings: [{ id: "t1" }], visuals: [{ kind: "sequence", title: "Call", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }] }] },
    { title: "Other", findings: [{ id: "zz" }], visuals: [{ kind: "flow", title: "not this", nodes: [{ id: "q", label: "Q" }], edges: [] }] }];
  const threats = [{ id: "T1", where: "acc1", boundary: "Internet to FrontDesk", threat: "An empty bearer passes the check.", findings: ["t1"], result: "finding", note: "" },
    { id: "T2", where: { from: "h", to: "ev" }, boundary: "FrontDesk to events", threat: "A forged event is mailed.", findings: [], result: "not_checked", note: "no publisher yet" }];
  const ctx = verifyContextMd([tok], { ...base, ai: { ...ai, steps }, statusOf: () => "open", threats });
  assert.ok(ctx.startsWith(`${first}\n\n# Context to check a finding\n\n## T t1\n\n- **Severity:** high`));
  for (const part of ["- **Preconditions:**\n  - TOKEN is unset", "- **Certainty:** Derived: it follows from the code that was read.", "- **Breaks these criteria:**\n  - broken: Only staff call it", "### Suggestion\n\nSet it.",
    "## The map\n\nThe way from the entry to each finding is red.\n\n```mermaid\nflowchart LR\n", "  class caller,h way\n  linkStyle 1 stroke:#cf222e,stroke-width:3px\n```", "- T t1: Client → handler (a.py)\n",
    "## Exposure\n", "## Blast radius\n", "| T1 | HttpApi (acc1) | Internet to FrontDesk | An empty bearer passes the check. | t1 | finding | - |", "| T2 | handler (a.py) → events | FrontDesk to events | A forged event is mailed. | - | not checked | no publisher yet |",
    "## Not known from this PR\n\n- T t1 holds only if: TOKEN is unset.\n- 1 card of the map is in no trust zone: events.\n", '## Pictures of the layer "The route"\n\n### Sequence: Call\n']) assert.ok(ctx.includes(part), part);
  assert.doesNotMatch(ctx, /not this|Rights granted|What was checked|please|you should/i, "only the findings' layers; no instructions");
  // Nothing unknown and no threats: those sections are not there; an assumed finding and a model-only reachability are named.
  const plain = verifyContextMd([f("p1", "medium", { file: "a.py", line: 9 })], { ...base, ai: { arch: { nodes: arch.nodes.slice(0, 2), edges: arch.edges.slice(1, 2), zones: arch.zones }, access: [] } });
  assert.doesNotMatch(plain, /Not known from this PR|Threat model/);
  assert.match(verifyContextMd([inner], { ...base, ai }), /- T t2 is assumed: [^\n]*\n- How far T t2 can be reached \(internal only\) is the analysis' word only: it names no way in\.\n/);
  console.log("ok zones and the context for a checking agent");
}

// The Security page of a webhook PR (synthetic): the findings a threat stands on are counted apart and listed; the
// crossings with their threats and the guards are in the export; a deny rule is no right; the blast radius is by the
// principal's card; a run's tool words are left out; Codex is named as Codex; an analysis that checked other areas says so.
{
  const arch = { groups: [{ id: "acct", label: "Shop account", kind: "Cloud account" }],
    zones: [{ id: "z1", name: "Hook function", trust: "public" }, { id: "z3", name: "Stores", trust: "data" }],
    nodes: [{ id: "fn", group: "acct", zone: "z1", label: "hook fn" }, { id: "vault", group: "acct", zone: "z3", label: "Secrets" }, { id: "topic", group: "acct", zone: "z3", label: "Topic" }],
    edges: [{ from: "fn", to: "vault", status: "new", crosses: true, label: "read" }] };
  const access = [{ id: "acc1", resource: "route", kind: "route", principal: "anyone on the internet", principal_node: null, actions: ["call POST /hook"], public: true, auth: "token", auth_kind: "code", node: "fn", change: "added", at: "infra.tf:9" },
    { id: "acc2", resource: "fn-policy", kind: "secret", principal: "fn role", principal_node: "fn", actions: ["secrets:Get"], public: false, auth: "IAM", auth_kind: "iam", node: "vault", change: "added", used: true, at: "infra.tf:20" },
    { id: "acc3", resource: "fn-policy", kind: "log group", principal: "fn role", principal_node: "fn", actions: ["logs:Put"], public: false, auth: "IAM", auth_kind: "iam", change: "added", used: true, at: "infra.tf:24" },
    { id: "acc4", resource: "topic-policy", kind: "topic", principal: "everyone but the fn role", principal_node: null, actions: ["deny events:Put"], public: false, auth: "resource policy", auth_kind: "iam", node: "topic", change: "added", at: "infra.tf:30" }];
  const threats = [{ id: "t1", where: { access: "acc1" }, threat: "A flood crowds out real senders.", stride: "D", result: "finding", findings: ["flood"], note: "" },
    { id: "t2", where: { access: "acc2" }, threat: "A taken-over fn role reads the secrets.", stride: "I", result: "mitigated", evidence: "infra.tf:20", note: "two secrets only", findings: [] },
    { id: "t3", where: { access: "acc4" }, threat: "Another principal publishes directly.", stride: "S", result: "mitigated", evidence: "infra.tf:31", findings: [] }];
  const gates = [{ where: { access: "acc1" }, principal: "anonymous", check: "token", at: "fn.py:4", source: "code", holds_if: "the hook secret is set", carries: ["body"] }];
  const flood = f("flood", "medium", { title: "One limit for everyone", impact: "degraded_operation", category: "availability", reachable_from: ["acc1"], reachability: "authenticated" });
  const ai = { arch, access, threats, gates, bypasses: [], asks: [], scope: { checked: [{ area: "correctness", result: "clean", note: "" }, { area: "tests", result: "clean", note: "" }] } };
  const runs = { security: { state: "done", model: "m-1", scope: { read: ["fn.py"], checked: [{ area: "secrets", result: "clean", note: "" }], skipped: ["git diff not run: Bash denied, read the changed files instead"] } },
    codex: { state: "done", model: "claude-small-1", scope: null } };
  const text = securityMd({ ...base, ai, findings: [flood, f("other", "high")], statusOf: () => "open", runs });
  assert.match(text, /# Security\n\n0 unresolved security findings about access or data\. 1 other unresolved finding backs a threat named here \(1 medium\)\.\n/);
  assert.match(text, /## Findings \(1, full text\)\n\nNo unresolved finding is about access or data \(⛨\)\. 1 unresolved finding backs a threat named above without being about access or data: it is listed here too\.\n\n### 1\. One limit for everyone\n/);
  assert.doesNotMatch(text, /T other/, "a finding no threat names stays on its own pages");
  // Each crossing in full, with its named threats under it (id, STRIDE, result, evidence, note).
  assert.match(text, /## Trust boundary crossings \(3\)\n\n[^\n]*\n\n### 1\. anyone on the internet → Hook function\n\n- \*\*Way in:\*\* route\n- \*\*Result:\*\* Finding\. Change by this PR: added\.\n- \*\*Who:\*\* anyone on the internet\n- \*\*Check:\*\* token, in the code, expects anonymous \(`fn\.py:4`\)\n- \*\*Holds only if:\*\* the hook secret is set\n/);
  assert.match(text, /- Threat t1 \(STRIDE D\), finding: A flood crowds out real senders\.\n- \*\*Findings at this crossing:\*\*\n  - \*\*medium\*\*: One limit for everyone /);
  assert.match(text, /### 2\. Hook function → Stores\n\n- \*\*Right:\*\* fn-policy \(secrets:Get\); call: read\n- \*\*Result:\*\* Mitigated\. Change by this PR: added\.\n- \*\*Who:\*\* fn role\n- \*\*Check:\*\* IAM \(`infra\.tf:20`\)\n/);
  assert.match(text, /- Threat t2 \(STRIDE I\), mitigated: A taken-over fn role reads the secrets\. Evidence: `infra\.tf:20`\. \(two secrets only\)\n/);
  assert.match(text, /### 3\. Operator \(deploy\) → Hook function\n\n- \*\*Operator way:\*\* sets the configuration that check 1 holds on\n- \*\*Result:\*\* Not assessed: [^\n]*\n/);
  assert.match(text, /\n- If fn role is taken over, it can secrets:Get on Secrets; logs:Put on log group fn-policy\.\n/, "what a taken-over principal may do, by principal");
  assert.match(text, /## Guards \(1\)\n\n[^\n]*\n\n- Guard at Topic: denies events:Put to everyone but the fn role \(resource policy, infra\.tf:30\)\. Holds against: Another principal publishes directly \(mitigated, `infra\.tf:31`\)\.\n/);
  assert.match(text, /- \*\*Hook function\*\* \(public\): If it is compromised, fn role can secrets:Get on Secrets; logs:Put on log group fn-policy\. Its calls reach Stores \(data\)\.\n/, "the rights by the principal's card, each on its card or its kind and resource");
  assert.doesNotMatch(/## Rights granted[^\n]*\n[\s\S]*?\n\n\n?## /.exec(`${text}\n\n## `)[0], /topic-policy/, "a deny rule is no right granted");
  assert.match(text, /\| Correctness \| clean \| – \|\n\| Tests \| clean \| – \|\n\| Secrets \| – \| clean \|\n/, "the analysis' own areas beside the security review's");
  assert.match(text, /- \*\*Security review:\*\* done \(m-1\)\. Read: fn\.py\. Left out: git diff not run: read the changed files instead\. Allowed: [^\n]*\n/, "what was left out stays, the tool's words go");
  assert.match(text, /- \*\*Codex review:\*\* done \(Codex; its text turned into findings by claude-small-1\)\. It does not say what it checked\.\n/);
  console.log("ok security: threats, guards and the findings behind them");
}

// ---- Resilience: paths, ladder, budget, the race as a sequence diagram
{
  const { resilienceMd } = await import("./markdown.js");
  const res = { head: "ccddf95aa", summary: "2 paths stand before the merge.", paths: [
    { id: "p2", trigger: "A race", end: "both mail", result: "mitigated", limited_by: "consumer.py:19", steps: ["queue"], race: { actors: ["delivery A", "delivery B"], steps: [["delivery A", "reads: empty"], ["delivery B", "mails; sets x"]], breaks_at: 1 } },
    { id: "p1", trigger: "One record raises", end: "the batch comes back", result: "finding", blocker: { reason: "no limit" }, steps: ["queue", "e6", "consumer"], visible: false,
      ladder: [{ name: "batch", factor: "up to 10", at: "template.yaml:37" }], product: "up to 30 mails", budget: { value_s: 70, limit_s: 10 }, action: "Decouple: add a DLQ", probe: "pr1" }],
    probes: [{ id: "pr1", status: "done", result: "reproduced", number: "19 calls for 10 records", head: "ccddf95aa" }], checks: [{ check: "cors", result: "clean", why: "no browser" }], not_checked: ["SMTP timeout"], watch: ["queue age"] };
  const md = resilienceMd({ pr: { repo: "o/r", number: 2, title: "t" }, head: "ccddf95aa", res, names: new Map([["queue", "LoanEvents"], ["consumer", "consumer"]]) });
  // Blockers first, each path in full: verdict, way, who sees it, the ladder and the budget, the action, the probe.
  assert.match(md, /## Paths \(2, 1 blocks the merge\)\n\n[^\n]*\n\n### 1\. One record raises: the batch comes back\n\n- \*\*Verdict:\*\* Blocker: no limit\n- \*\*Way:\*\* LoanEvents → consumer\n- \*\*Seen:\*\* no, silent[^\n]*\n- \*\*Action:\*\* Decouple: add a DLQ\n/);
  assert.match(md, /Retries and redeliveries on this path:\n\n\| Step \| Factor \| Where \| Note \|\n[^\n]*\n\| batch \| up to 10 \| `template\.yaml:37` \| - \|\n\nTogether: up to 30 mails\n/);
  assert.match(md, /Time budget: worst case 70 s against the 10 s timeout\n/); assert.match(md, /- \*\*Probe:\*\* [^\n]*\n  - State: reproduced, 19 calls for 10 records at ccddf95\n/);
  assert.match(md, /### 2\. A race: both mail\n\n- \*\*Verdict:\*\* limited at `consumer\.py:19`\n/);
  assert.match(md, /\| 2 \(breaks here\) \| delivery B \| mails; sets x \| - \|\n\n```mermaid\nsequenceDiagram\n  participant A0 as delivery A\n  participant A1 as delivery B\n  Note over A0: reads#58; empty\n  Note over A1: breaks here#58; mails#59; sets x\n```\n/);
  assert.match(md, /## Checked, clean \(1\)\n\n- cors: no browser\n\n## Not checkable \(1\)\n\n- SMTP timeout\n/); assert.match(resilienceMd({ pr: {}, head: "" }), /has not run/);
  // With the map: a path's way as a flowchart over its cards, the map itself, the calls with their limits; the parts
  // this PR adds; a probe done with its script and output; the code of a path's places, each once.
  const arch = { groups: [{ id: "g", label: "AWS" }], nodes: [{ id: "queue", label: "LoanEvents", group: "g", description: "The queue." }, { id: "consumer", label: "consumer", group: "g", at: "c.py:1" }], edges: [{ from: "queue", to: "consumer", label: "SQS trigger" }] };
  const full = resilienceMd({ pr: { repo: "o/r", number: 2, title: "t" }, head: "ccddf95aa", arch, cost: 0.29,
    res: { ...res, paths: [{ ...res.paths[1], steps: ["queue", "e0", "c.py:2"], via: ["e0"], findings: ["x1"] }], deps: [{ edge: "e0", node: "consumer", at: "t.yaml:3", mode: "async", timeout: { s: 10 }, trigger: { batch: 10, dlq: false } }],
      additions: [{ what: "A queue", kind: "queue", at: "t.yaml:1", result: "questionable", purpose: "Decouples mailing.", solves: "Slow mail.", likelihood: "possible", cost: { ops: "a DLQ is missing" }, simpler: "Mail directly.", next: "Add a DLQ.", works_today: false, broken_by: "Nothing publishes." }] },
    probes: [{ id: "pr1", of: "p1", claim: "A failing record repeats", kind: "redelivery", strength: "runs_pr_code", status: "done", result: "reproduced", number: "19 calls", head: "ccddf95aa", ms: 1200, base: { verdict: "new_in_pr", line: "ImportError" }, network_barrier: true, script: "print('reproduced 19 calls')", output: "reproduced 19 calls" }],
    findings: [{ id: "x1", ids: ["x1"], severity: "high", title: "No DLQ", file: "t.yaml", line: 3 }],
    code: rowsByPath(new Map([["c.py", diffRows(["@@ -0,0 +1,3 @@", "+def handler(event):", "+    handle(event)", "+    return 1"])]])) });
  assert.match(full, /2 paths|1 path · 1 check clean · 1 not checkable · analysis of ccddf95 · \$0\.29\n/);
  assert.match(full, /## Parts this PR adds \(1\)\n\n[^\n]*\n\n- \*\*A queue\*\* \(queue\) at `t\.yaml:1`: questionable\n  - For: Decouples mailing\.\n  - Solves: Slow mail \(possible\)\.\n  - Costs to run: a DLQ is missing\.\n  - Simpler: Mail directly\.\n  - Works today: no, Nothing publishes\.\n  - Next: Add a DLQ\.\n/);
  assert.match(full, /- \*\*Findings \(1\):\*\*\n  - \*\*high\*\*: No DLQ \(`t\.yaml:3`\)\n/);
  assert.match(full, /```mermaid\nflowchart LR\n  queue\["LoanEvents"\]\n  consumer\["consumer"\]\n  queue -->\|"1\. SQS trigger"\| consumer\n```\n/, "the path's way over the cards");
  assert.match(full, /- \*\*Probe:\*\* A failing record repeats \(redelivery, runs PR code\)\n  - State: reproduced, 19 calls at ccddf95, 1\.2 s\n  - On the base: new in this PR \(ImportError\)\n  - Ran in a sandbox, without network\n\nProbe script:\n\n```python\nprint\('reproduced 19 calls'\)\n```\n\nProbe output:\n\n```\nreproduced 19 calls\n```\n/);
  assert.match(full, /Code `c\.py:1-3`:\n\n```diff\n\+def handler\(event\):\n\+    handle\(event\)\n\+    return 1\n```\n/);
  assert.match(full, /## Map\n\n[^\n]*\n\n```mermaid\nflowchart LR\n  subgraph group0\["AWS"\]\n    queue\["LoanEvents"\]\n    consumer\["consumer"\]\n  end\n  queue -->\|"SQS trigger"\| consumer\n```\n\n- \*\*LoanEvents:\*\* The queue\.\n/);
  assert.match(full, /## Calls and their limits \(1\)\n\n[^\n]*\n\n\| Call \| Where \| Mode \| Limits \|\n[^\n]*\n\| LoanEvents → consumer \| `t\.yaml:3` \| async \| timeout 10 s; trigger: batch 10, no receive limit, no DLQ \|\n/);
  console.log("ok resilience md");
}

// ---- wave R2: the export says what the page says (words, before merge, one watch entry per queue, no tool text)
{
  const { resilienceMd } = await import("./markdown.js");
  const arch = { nodes: [{ id: "queue", label: "LoanEvents", at: "template.yaml:11" }], edges: [] };
  const res = { head: "ccddf95aa", paths: [{ id: "p1", trigger: "x", end: "y", result: "finding", steps: [], failing: ["no_dlq"], signal: "none", findings: [] }],
    not_checked: ["Runtime behaviour: nothing was executed, because Bash was denied"], blind_spots: [{ failure: "Mail loss is not visible", at: "mailer.py:19", signal: "none" }],
    deps: [{ at: "template.yaml:32", mode: "async" }, { at: "template.yaml:40", mode: "async" }] };
  const md = resilienceMd({ pr: { repo: "o/r", number: 2, title: "t" }, head: "ccddf95aa", res, arch });
  assert.match(md, /- \*\*Fails by:\*\* no dead-letter queue/); assert.match(md, /- \*\*Seen:\*\* no, silent/); assert.doesNotMatch(md, /Bash/);
  assert.match(md, /\(no picture: the run named no call on this path that multiplies or times out\.\)/, "why a path has no picture, as the page says it");
  assert.match(md, /## Before merge, not observable \(1\)\n\n- Mail loss is not visible/); assert.equal(md.match(/oldest message in LoanEvents/g)?.length, 1);
  assert.doesNotMatch(md, /When a dependency fails/, "no section without dependencies");
  // Dependencies that fail or are overloaded: a line each, its cases under it with the number of their path here.
  const dep = resilienceMd({ pr: {}, head: "h", res: { ...res, downstream: [{ dep: "Mailer", kind: "external", mode: "sync", at: "library/mailer.py:14", cases: [
    { when: "slow", handled: "no", how: "waits up to 7 s", effect: "The request hangs until its timeout.", path: "p1" }, { when: "down", handled: "yes", how: "fails fast", at: "library/mailer.py:19" },
    { when: "recovers", handled: "not_checkable" }] }] }, arch });
  assert.match(dep, /## When a dependency fails \(1\)\n\n- Mailer \(external, sync, library\/mailer\.py:14\)\n  - slow: waits up to 7 s ✗, path 1\. The request hangs until its timeout\.\n  - down: fails fast ✓ \(library\/mailer\.py:19\)\n  - The code cannot tell: recovers\.\n/);
}

// ---- a fence's language: a script without an ending is fenced as bash by its first line
{
  for (const [file, first, lang] of [["scripts/a.sh", "", "bash"], ["bin/release", "#!/usr/bin/env bash", "bash"], [".envrc", "", "bash"], ["hooks/pre-commit", "", "bash"], ["bin/tool", "#!/usr/bin/env python3", "python"],
    ["Makefile", "", "makefile"], ["rules.mk", "", "makefile"], [".github/workflows/ci.yml", "", "yaml"], ["application-prod.yml", "", "yaml"], ["app.properties", "", "properties"], ["tox.ini", "", "ini"], ["Cargo.lock", "", "toml"], ["LICENSE", "", ""], ["a.py", "", "python"], ["x.toml", "", "toml"], ["bin/release", undefined, ""]]) assert.equal(fenceLang(file, first), lang, file);
  const cx = codeContext(rowsByPath(new Map([["bin/release", diffRows(["@@ -1,3 +1,3 @@", " #!/bin/sh", " set -eu", " echo hi"])]])));
  assert.equal(cx.block("bin/release", 2)[2], "```bash");
}

// ---- the code context: the lines a place names, from the rows the review holds
{
  const rows = diffRows(["@@ -1,4 +1,5 @@", " import os", "-TOKEN = None", "+TOKEN = os.environ.get('T', '')", " ", " def late():", "@@ -20,2 +21,18 @@", ...Array.from({ length: 18 }, (_x, k) => `+line ${21 + k}`)]);
  const cx = codeContext(rowsByPath(new Map([["lib/a.py", rows], ["lib/b.yaml", diffRows(["@@ -1,2 +1,2 @@", " a: 1", " b: 2"])]])));
  // A place with its two lines around, the replaced line with its mark, under its head; the path is the file's whole one.
  assert.deepEqual(cx.block("a.py", 2), ["Code `lib/a.py:1-4`:", "", "```diff", " import os", "-TOKEN = None", "+TOKEN = os.environ.get('T', '')", "", " def late():", "```", false, ""]);
  // The same place again, also as a part of it: said, not shown twice. A place the review holds no line of: nothing.
  assert.deepEqual(cx.at("lib/a.py:2-3"), ["Code: see `lib/a.py:1-4` above.", ""]); assert.deepEqual(cx.at("lib/a.py:300"), []); assert.deepEqual(cx.at("nowhere.py:1"), []); assert.deepEqual(cx.at("no place"), []);
  // A long place: its first CODE_MAX lines and how many are left out; unchanged lines in the file's language.
  const long = cx.block("lib/a.py", 21, 38);
  assert.equal(long.filter((l) => typeof l === "string" && l.startsWith("+line")).length, CODE_MAX); assert.ok(long.includes("(6 more lines of this place not shown.)") && long[0] === "Code `lib/a.py:21-32`:");
  assert.deepEqual(cx.block("lib/b.yaml", 1, 2).slice(0, 5), ["Code `lib/b.yaml:1-2`:", "", "```yaml", "a: 1", "b: 2"]);
  assert.deepEqual(cx.stats, { blocks: 3, lines: 5 + CODE_MAX + 2 });
  // Lines the review does not hold between two hunks are said in the block.
  const gap = codeContext(rowsByPath(new Map([["a.py", rows]]))).block("a.py", 4, 22);
  assert.ok(gap.includes("@@ line 21 @@"), "a jump between hunks is marked");
  assert.deepEqual(codeContext(null).block("a.py", 2), [], "no code context asked for");
  // The preview's parts: the head, one part per "## " heading with its lines, a heading inside a fence is none; a part left out; the code counted.
  const text = ["PR x", "", "# Title", "", "Summary.", "", "## One (2)", "", "- a", "", "Code `a.py:1-2`:", "", "```diff", "+x", "## not a heading", "```", "", "## Two", "", "b", ""].join("\n");
  const doc = mdParts(text);
  assert.deepEqual(doc.parts.map((p) => [p.title, p.n]), [["One (2)", 7], ["Two", 2]]); assert.deepEqual(doc.head, ["PR x", "", "# Title", "", "Summary.", ""]);
  assert.equal(mdJoin(doc), text);
  // A part left out is named under the title, which counts the whole page (acceptance, UX 2).
  assert.equal(mdJoin(doc, new Set([0])), "PR x\n\n# Title\n\nLeft out of this text: One (2).\n\nSummary.\n\n## Two\n\nb\n");
  // One way to count, the lines with text: the head and the parts kept add up to the whole, with every choice.
  for (const off of [new Set(), new Set([0]), new Set([1]), new Set([0, 1])])
    assert.equal(mdLines(mdHead(doc, off)) + doc.parts.filter((_p, k) => !off.has(k)).reduce((n, p) => n + p.n, 0), mdLines(mdJoin(doc, off)), `the sizes add up with ${[...off]} left out`);
  assert.deepEqual([mdLines(mdHead(doc)), mdLines(text), mdLines(mdHead({ head: ["no title"], parts: doc.parts }, new Set([1])))], [3, 12, 2]);
  assert.deepEqual(codeStats(text), { blocks: 1, lines: 2 }); assert.deepEqual(codeStats(mdJoin(doc, new Set([0]))), { blocks: 0, lines: 0 });
  console.log("ok code context and parts");
}
