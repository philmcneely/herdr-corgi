// Run: node test_markdown.mjs
import assert from "node:assert/strict";
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
  for (const line of ["- **Severity:** high. On this scale, high means: it breaks a requirement, leaves a dead path, allows unauthorized access, exposes data or loses data. Here: unauthorized access.",
    "- **Where:** `a.py:3-9`", "- **State:** Unresolved", "- **Found by:** Security review (high), Analysis (medium)", "- **Category:** security", "- **Certainty:** Assumed, not checked",
    "- **Preconditions:**\n  - no token set\n  - no authorizer", "- **Breaks these criteria:**\n  - broken: Only staff call it", "## Effect\n\nAnyone calls it.", '## Detail\n\nThe token defaults to `""`.',
    "## Suggestion\n\nFail closed:\n\n```py\nif not TOKEN:\n    raise RuntimeError\n```", "## Also reported as\n\n- Analysis (medium): No token. Template sets none."]) assert.ok(text.includes(line), line);
  // An older finding says nothing about certainty or effect: those lines are not there, nothing is made up.
  const old = findingMd(f("o1", "medium"), base);
  assert.doesNotMatch(old, /Certainty|Preconditions|Effect|Detail|Suggestion|Also reported/);
  assert.match(findingMd(f("o2", "low", { certainty: "derived" }), base), /- \*\*Preconditions:\*\* none, it always happens/);
  // All unresolved ones, most severe first; the dismissed one is out, a fix sent stays in.
  const list = findingsMd(all, { ...base, statusOf, asks });
  assert.ok(list.startsWith(`${first}\n\n# 3 unresolved findings: 1 high, 1 medium, 1 low\n\n## 1. T s1\n`));
  assert.deepEqual(list.match(/^## \d+\. .*/gm), ["## 1. T s1", "## 2. T m1", "## 3. T l1"]);
  assert.match(list, /## 2\. T m1\n\n- \*\*Severity:\*\* medium[^\n]*\n- \*\*Where:\*\* `a\.py:3`\n- \*\*State:\*\* Fix sent/);
  assert.match(list, /### Effect\n\nAnyone calls it\./, "a finding's parts sit one level below its heading");
  assert.ok(findingsMd([], base).startsWith(`${first}\n\n# 0 unresolved findings\n`));
  console.log("ok findings");
}

{
  const ai = { asks, unlinked: ["c2"], summary: "Adds a route.", behavior: "Staff can remind.", behaviorPoints: [], mergeRisk: { level: "high", why: "No auth." }, componentCounts: { new: 1, changed: 0, no_owner: 1, codeowners: true },
    rules: [{ rule: "Tests for new code", source: "CLAUDE.md", status: "fail", where: "a.py:3", why: "None." }] };
  const text = overviewMd({ ...base, ai, findings: all, statusOf, checks: [{ name: "Conventional Commit title", ok: true, why: "feat: x" }, { name: "CI: unit", ok: false, why: "fail", ci: true }, { name: "Tests for new code", ok: false, rule: true }],
    related: { stacked_on: { number: 1, title: "base", url: "https://example.test/pull/1" } } });
  assert.ok(text.startsWith(`${first}\n\n# Review overview: feat: x\n\n**Verdict:** 1 security cause, high (reach assumed) · 0 of 2 acceptance criteria met · 2 checks failed\n**Merge risk:** high. No auth.\n`));
  assert.match(text, /\*\*Stacked on:\*\* #1 base \(https:\/\/example\.test\/pull\/1\)\. This PR merges after it\.\n\*\*Components:\*\* 1 new component, 1 without an owner\n/);
  assert.match(text, /## Check against the task: 0 of 2 acceptance criteria met, 1 extra\n\n### Security\n\n- \*\*high\*\* security: T s1 \(`a\.py:3-9`\) · Assumed, not checked\n/);
  assert.match(text, /### Acceptance criteria\n\n- \*\*broken\*\*: Only staff call it\n  - Why: No check\.\n  - \*\*high\*\* security: T s1 [^\n]*\n- \*\*partly\*\*: Mails once\n  - No finding backs this state\.\n/);
  assert.match(text, /### Not in the task\n\n- \*\*extra\*\*: A new route\n- 2 unresolved findings belong to no criterion:\n  - \*\*medium\*\*: T m1 \(`a\.py:3`\) · Fix sent\n  - \*\*low\*\*: T l1 /);
  assert.match(text, /## What changed\n\nAdds a route\.\n\n## Behavior\n\nStaff can remind\.\n\n## Repo rules and checks\n\n- passed: Conventional Commit title\n- failed: CI: unit\. fail\n- failed: Tests for new code \(CLAUDE\.md, `a\.py:3`\)\. None\.\n$/);
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
  assert.match(text, /## Findings: 3 unresolved, 1 high, 1 medium, 1 low\n\n- \*\*high\*\* security: T s1 [^\n]*\n- \*\*medium\*\*: T m1 [^\n]*\n- \*\*low\*\*: T l1 [^\n]*\n\n## Pictures\n\n### Sequence: Call\n\n```mermaid\nsequenceDiagram\n/);
  assert.match(text, /## Functions with example values\n\n- `remind` at `a\.py:3`\n  - in: `id` \(int\), for example `7`\n  - out: dict, for example `\{\}`\n  - side effects: mails\n  - calls: `send`\n$/);
  assert.match(layerMd({ title: "Docs", risk: "skim" }, base), /# Layer: Docs\n\n\*\*Risk:\*\* low, skimmed by the analysis\n\n## Findings: none unresolved\n$/);
  console.log("ok layer");
}

{
  const ai = { arch: { groups: [{ id: "g1", label: "API", kind: "Service" }], nodes: [{ id: "h", group: "g1", label: "handler", type: "function", status: "changed", at: "a.py:3", description: "The entry." }, { id: "c", label: "consumer", status: "new" }],
    edges: [{ from: "h", to: "c", label: "calls", status: "new" }] }, componentCounts: { new: 1, changed: 0, no_owner: 1, codeowners: true },
    components: [{ name: "consumer | v2", kind: "lambda", status: "new", at: "c.py:1", operate: ["no alarm", "no DLQ"], owner: null }, { name: "queue", kind: "queue", status: "new", at: "", operate: [], owner: "@team" }],
    visuals: [{ kind: "state_machine", title: "Loan", nodes: [{ id: "a", label: "A" }], transitions: [] }] };
  const text = architectureMd({ ...base, ai, findings: all, statusOf });
  assert.ok(text.startsWith(`${first}\n\n# Architecture impact\n\n2 cards: 1 new, 1 changed. A card's class in the diagram is its status; a dashed call is only in the spec.\n1 new component, 1 without an owner.\n\n\`\`\`mermaid\nflowchart LR\n  subgraph group0["API (Service)"]\n    h["handler"]:::changed\n  end\n  c["consumer"]:::new\n  h -->|"calls (new)"| c\n`));
  assert.match(text, /## Cards\n\n- \*\*handler\*\* \(changed, function, `a\.py:3`\): The entry\.\n- \*\*consumer\*\* \(new\)\n/);
  assert.match(text, /## Where the flow breaks\n\n- Call handler → consumer: \*\*high\*\* security: T s1 [^\n]*\n- Card consumer: \*\*medium\*\*: T m1 [^\n]*\n/);
  assert.match(text, /## Components\n\n\| Component \| Kind \| Status \| Where \| Owner \| To operate \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| consumer \\\| v2 \| lambda \| new \| `c\.py:1` \| no owner \| no alarm; no DLQ \|\n\| queue \| queue \| new \| - \| @team \| - \|\n/);
  assert.match(text, /## Other pictures\n\n### State diagram: Loan\n\n```mermaid\nstateDiagram-v2\n  state "A" as a\n  \[\*\] --> a\n```\n$/);
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
  assert.ok(text.startsWith(`${first}\n\n# Security\n\n1 unresolved security finding: 1 high.\n\n## Findings\n\n### 1. T s1\n\n- **Severity:** high`));
  assert.match(text, /#### Suggestion\n\nFail closed:\n\n```py\n/, "a security finding is here in full");
  assert.match(text, /## Exposure\n\n1 way in: 1 reachable from the internet \(0 without a check of the caller\), 0 opened by this PR\.\n\n\| Way in \| Kind \| Who \| May \| From the internet \| Check \| Opened by this PR \| Evidence \|\n[^\n]*\n\| Api \| route \| anyone on the internet \| call GET \/late; call POST \/remind \| yes \| bearer token \| not stated \| `t\.yaml:24` \|\n\n/);
  // Without zones the blast radius is the rights by who holds them; the rights table has no way in twice.
  assert.match(text, /## Blast radius\n\nThe analysis names no trust zones\. The rights granted, by who holds them:\n\n- \*\*role\*\* can sqs:SendMessage on Queue\.\n\n## Rights granted\n\n\| Resource \| Kind \| Who \| May \| Auth \| Used by the code \| Where \|\n[^\n]*\n\| Queue \| queue \| role \| sqs:SendMessage \| IAM \| - \| - \|\n\n/);
  assert.match(text, /### Analysis\n\n\| Area \| Result \| Note \|\n\| --- \| --- \| --- \|\n\| authentication \| finding \| empty token \|\n\| input validation \| not checked \| - \|\n\n### Security review: done \(m-1\)\n\nRead: the diff; a\.py\n\n\| Area[^\n]*\n[^\n]*\n\| secrets \| clean \| none \|\n\nSkipped:\n- tests\n\n### Codex review: failed\n\nError: boom\n$/);
  assert.doesNotMatch(text, /Claude code review/, "a run that looked at no security area is not on this page");
  assert.match(securityMd({ ...base, findings: [] }), /0 unresolved security findings\.\n\n## What was checked\n\n[^\n]*\n\n### Analysis\n\nNo analysis of this diff yet\.\n\nNo reviewer has looked at security\.\n$/);
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
  assert.deepEqual(sec.match(/^### \d+\. .*/gm), ["### 1. T t1", "### 2. T t2"]);
  assert.match(sec, /- \*\*Reachable:\*\* anyone on the internet can reach it\. Stated by the analysis, with the way in it names\.\n- \*\*Way in:\*\* Client → handler \(a\.py\) \(HttpApi; from the internet, check: in the code: token in handler; opened by this PR\)\. It crosses a trust boundary\. The analysis names this way in\.\n/);
  assert.match(sec, /- \*\*Reachable:\*\* only something inside can reach it\. Stated by the analysis, which names no way in\.\n- \*\*Way in:\*\* events \(Admin; from the internet, check: none\)\. Derived from the map\.\n/);
  // Exposure: the unchecked public way in first, the sum in the first sentence.
  assert.match(sec, /## Exposure\n\n2 ways in: 2 reachable from the internet \(1 without a check of the caller\), 1 opened by this PR\.\n\n[^\n]*\n[^\n]*\n\| Admin \| endpoint \| anyone \| call \/admin \| yes \| none \| no \| - \|\n\| HttpApi \| route \| anyone \| call POST \/remind \| yes \| in the code: token in handler \| yes \| `t\.yaml:24` \|\n/);
  // Blast radius per zone: the rights its holder has (unused marked), the zones and loose cards its calls reach; a
  // zone of external callers only is left out.
  assert.match(sec, /## Blast radius\n\n[^\n]*\n\n- \*\*Front "desk": fn\*\* \(authenticated\): If it is compromised, it can sqs:SendMessage on Send policy \(granted, not used by the code\)\. Its calls reach 1 card outside every zone \(events\)\.\n\n## Rights granted/);
  assert.doesNotMatch(sec, /\*\*Internet\*\*/);
  // The architecture with zones: the frames are zones, so each card names its group and zone.
  const am = architectureMd({ ...base, ai: { arch } });
  assert.match(am, /the frames are trust zones, a thick call crosses a trust boundary\.\n/);
  assert.match(am, /- \*\*handler \(a\.py\)\*\* \(changed, in Lambda, zone: Front "desk": fn \(authenticated\), `a\.py:10`\)\n- \*\*events\*\* \(unchanged, in Lambda, zone: none, `e\.py:1`\)\n/);

  // The context for a checking agent: the findings, the whole map with the way in red and as text, exposure, blast
  // radius, the threat model, what this PR cannot tell, the layer's pictures. No instructions.
  const steps = [{ title: "The route", findings: [{ id: "t1" }], visuals: [{ kind: "sequence", title: "Call", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }] }] },
    { title: "Other", findings: [{ id: "zz" }], visuals: [{ kind: "flow", title: "not this", nodes: [{ id: "q", label: "Q" }], edges: [] }] }];
  const threats = [{ id: "T1", where: "acc1", boundary: "Internet to FrontDesk", threat: "An empty bearer passes the check.", findings: ["t1"], result: "finding", note: "" },
    { id: "T2", where: { from: "h", to: "ev" }, boundary: "FrontDesk to events", threat: "A forged event is mailed.", findings: [], result: "not_checked", note: "no publisher yet" }];
  const ctx = verifyContextMd([tok], { ...base, ai: { ...ai, steps }, statusOf: () => "open", threats });
  assert.ok(ctx.startsWith(`${first}\n\n# Context to check a finding\n\n## T t1\n\n- **Severity:** high`));
  for (const part of ["- **Preconditions:**\n  - TOKEN is unset", "- **Certainty:** Derived from the code", "- **Breaks these criteria:**\n  - broken: Only staff call it", "### Suggestion\n\nSet it.",
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

// ---- Resilience: paths, ladder, budget, the race as a sequence diagram
{
  const { resilienceMd } = await import("./markdown.js");
  const res = { head: "ccddf95aa", summary: "2 paths stand before the merge.", paths: [
    { id: "p2", trigger: "A race", end: "both mail", result: "mitigated", limited_by: "consumer.py:19", steps: ["queue"], race: { actors: ["delivery A", "delivery B"], steps: [["delivery A", "reads: empty"], ["delivery B", "mails; sets x"]], breaks_at: 1 } },
    { id: "p1", trigger: "One record raises", end: "the batch comes back", result: "finding", blocker: { reason: "no limit" }, steps: ["queue", "e6", "consumer"], visible: false,
      ladder: [{ name: "batch", factor: "up to 10", at: "template.yaml:37" }], product: "up to 30 mails", budget: { value_s: 70, limit_s: 10 }, action: "Decouple: add a DLQ", probe: "pr1" }],
    probes: [{ id: "pr1", status: "done", result: "reproduced", number: "19 calls for 10 records", head: "ccddf95aa" }], checks: [{ check: "cors", result: "clean", why: "no browser" }], not_checked: ["SMTP timeout"], watch: ["queue age"] };
  const md = resilienceMd({ pr: { repo: "o/r", number: 2, title: "t" }, head: "ccddf95aa", res, names: new Map([["queue", "LoanEvents"], ["consumer", "consumer"]]) });
  assert.match(md, /## 1\. One record raises: the batch comes back\n\n- Verdict: Blocker: no limit\n- Way: LoanEvents → consumer\n- Seen: no, silent\n- batch: up to 10 \(template\.yaml:37\)/);
  assert.match(md, /- Budget: worst case 70 s against 10 s/); assert.match(md, /- Probe: reproduced, 19 calls for 10 records at ccddf95/);
  assert.match(md, /sequenceDiagram\n  participant A0 as delivery A\n  participant A1 as delivery B\n  Note over A0: reads#58; empty\n  Note over A1: breaks here#58; mails#59; sets x/);
  assert.match(md, /## Not checkable\n\n- SMTP timeout/); assert.match(resilienceMd({ pr: {}, head: "" }), /has not run/);
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
  assert.match(md, /Failing: no dead-letter queue/); assert.match(md, /Seen: no, silent/); assert.doesNotMatch(md, /Bash/);
  assert.match(md, /## Before merge, not observable\n\n- Mail loss is not visible/); assert.equal(md.match(/oldest message in LoanEvents/g)?.length, 1);
}
