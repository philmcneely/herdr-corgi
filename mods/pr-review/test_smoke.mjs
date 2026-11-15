// Run: node test_smoke.mjs  (a render smoke test: the review loaded the way Herdr loads it, from the analyses, findings
// files, context and diffs in demo/fixtures/review, then every tab, page, layer, card, crossing, finding and step,
// the popovers, the offers and the other parts of the mod drawn with every virtual list's rows. Also without an
// analysis, without findings, while runs are going, after they failed, and for someone else's PR. Any exception,
// sync or in a spawned task, and any null or non-finite value handed to an element fails it.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S, cx as base } from "./render_stub.mjs";

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, hash } = await import("./pr.js");
const { foldOnOpen, resWatch } = await import("./views.js");
const R = await import("./review.js");
const { withThreadState } = await import("./threads.js");
const fx = (name) => readFileSync(new URL(`../../demo/fixtures/review/${name}`, import.meta.url), "utf8");

// cx.spawn runs the task (as Herdr does) and keeps it, to wait for; a task that throws is a failure, except for the
// stand-ins' own "stub" (no exec, no files) that the real code meets as a failed command.
const late = [];
const cx = { ...base, spawn(fn) { void (Promise.resolve().then(() => fn(cx)).catch((e) => { if (e?.message !== "stub") late.push(e?.stack ?? String(e)); })); } };
// Some tasks wait for ever (a folder watch, the next command): settle lets the others run to their end, not those.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

let shown = 0;
// The frame: the view, then each virtual list's every row (lists inside rows join the queue).
function frame(what, draw) {
  S.errs.length = 0; S.lists.length = 0;
  try { draw(); for (let k = 0; k < S.lists.length && k < 200; k++) S.lists[k].render({ start: 0, end: S.lists[k].n }, cx); }
  catch (e) { S.errs.push(`threw ${e?.stack ?? e}`); }
  assert.deepEqual(S.errs, [], what); shown++;
}
const draw = (v, what) => frame(what, () => v.render(cx));
const act = (v, c, what = c) => { v.command(c, cx); draw(v, `${what}`); };

async function open({ diff, analysis = null, findings = null, ctx = null, pr = 2, title = "feat(events): loan events", trusted = true }) {
  const url = `https://github.com/saefty/corgi-demo/pull/${pr}`, target = { url, repo: "saefty/corgi-demo", number: pr, title, base: "main", ...(trusted ? {} : { source: "repo", author: "someone" }) };
  S.store.clear(); S.files.clear(); S.props = null;
  S.store.set("review.target", target);
  if (findings) S.files.set(`/h/pr-data/findings/${hash(url)}.json`, findings);
  const v = new PrReview(); v.init({}, cx);
  v.prSel = target; v.patch = splitPatch(diff);
  v.hunks = hunksOf(v.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  v.byId = new Map(v.hunks.map((h) => [h.id, h])); v.fileHunks = new Map();
  for (const h of v.hunks) v.fileHunks.set(h.path, [...(v.fileHunks.get(h.path) ?? []), h]);
  v.collapsed = new Set(foldOnOpen(v.patch));
  v.ctx = ctx ? JSON.parse(ctx) : null; v.head = v.ctx?.head ?? null;
  await v.loadFindings(cx);
  if (analysis) v.ai = v.mapSaved(JSON.parse(analysis), true);
  v.securityNow(cx); v.publish();
  await settle();
  return v;
}

// Everything one review shows.
async function tour(v, name) {
  const at = (x) => `${name}: ${x}`;
  for (const tab of ["files", "steps", "comments", "findings"]) act(v, tab, at(`tab ${tab}`));
  // A comment written at a line: the composer, then a pending comment in the diff, the Comments tab and Finish.
  const line = v.hunks[0] && `${v.hunks[0].path}:${v.hunks[0].rows.find((r) => r.kind === "+")?.n ?? 1}`;
  // GitHub's comments on that line: Markdown, a suggestion, a reply, a bot, an outdated one, a resolved thread.
  if (line) {
    const [path, n] = [line.slice(0, line.lastIndexOf(":")), Number(line.slice(line.lastIndexOf(":") + 1))];
    const g = (id, user, body, extra = {}) => ({ id, path, line: n, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at: `2026-11-1${id % 10}T10:00:00Z`, commit_id: "c1", body, ...extra });
    v.gh = withThreadState([g(1, "anna", "**Why** this?\n\n```suggestion\nx = 1\n```\n\n- a\n- [link](https://example.org)"), g(2, "bob", "> quoted\n\nagreed `code`", { in_reply_to_id: 1 }),
      g(3, "lint[bot]", "<details><summary>Lint</summary>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>"), g(4, "carol", "old", { line: null, original_line: 2, outdated: true })], [{ id: 1, resolved: true, outdated: false }]);
    act(v, "comments", at("Comments with GitHub's threads")); v.showResolved = true; v.allBots = true; act(v, "files", at("files with GitHub's threads")); act(v, "comments", at("Comments, resolved and bots shown"));
  }
  if (line) { act(v, `comment:${line}`, at("composer open")); act(v, "draft:Why this?", at("composer with text")); act(v, "add", at("a pending comment")); assert.ok(v.comments.length > 0, at("the comment was added")); act(v, "comments", at("Comments with a pending comment")); act(v, "files", at("files again")); }
  // The pages, with their folds and rows clicked.
  for (const p of ["overview", "blast", "arch", "res"]) act(v, `page:${p}`, at(`page ${p}`));
  // Resilience: every path opened (its picture and probe), all paths, the clean checks, a probe's script, and none open.
  v.command("page:res", cx);
  for (const p of v.resNow()?.paths ?? []) act(v, `res-path:${p.id}`, at(`Resilience, path ${p.id}`));
  for (const c of ["res-more", "res-clean", "res-add", "res-probe-open:pr1", "res-path:"]) act(v, c, at(`Resilience, ${c}`));
  v.command("page:overview", cx); v.rulesOpen = true; draw(v, at("Overview, rules open"));
  for (const a of [...(v.ai?.asks ?? []).map((x) => x.id), "other"]) act(v, `criterion:${a}`, at(`Overview, criterion ${a}`));
  v.command("page:blast", cx);
  for (const k of ["quiet", "unchanged", ...(v.ai?.access ?? []).map((x) => `a:${x.id}`), ...(v.ai?.arch?.edges ?? []).map((_e, k) => `e:${k}`)]) act(v, `cross:${k}`, at(`Security, crossing ${k}`));
  for (const n of v.ai?.arch?.nodes ?? []) act(v, `sec-card:${n.id}`, at(`Security, card ${n.id}`));
  for (const k of [...(v.ai?.scope?.checked ?? []).map((x) => x.area), "run:claude", "run:security"]) act(v, `scope-row:${k}`, at(`Security, scope row ${k}`));
  v.command("page:arch", cx);
  for (const m of ["before", "after", "diff"]) act(v, `arch-view:${m}`, at(`Architecture, ${m}`));
  for (const n of v.ai?.arch?.nodes ?? []) act(v, `card:${n.id}`, at(`Architecture, card ${n.id}`));
  act(v, "card:", at("Architecture, no card")); act(v, "arch-fit", at("Architecture, fit")); act(v, "arch-wrap", at("Architecture, wrap")); act(v, "arch-wrap", at("Architecture, unwrap"));
  // Each layer, in both orders, with its pictures folded and open.
  for (const order of ["risk", "reading"]) {
    v.command(`order:${order}`, cx); v.page = null;
    v.steps().forEach((s, k) => {
      act(v, `step:${k}`, at(`layer ${k} (${order})`));
      (s.visuals ?? []).forEach((_x, j) => { act(v, `vis:vis|${k}|${j}`, at(`layer ${k}, picture ${j} toggled`)); v.command(`vis:vis|${k}|${j}`, cx); });
    });
  }
  // Each finding open, each of its steps' details, its card in the diff folded and open.
  v.command("findings", cx);
  for (const f of v.findings()) {
    act(v, `finding:${f.id}`, at(`finding ${f.id}`));
    for (const k of ["reported", "evidence", "sent", "verified", "in_pr"]) { v.fstep = { id: f.id, key: k }; draw(v, at(`finding ${f.id}, step ${k}`)); }
    v.fstep = null;
  }
  act(v, "findings-sort:quick", at("findings, quick wins first")); act(v, "findings-sort:", at("findings, usual order"));
  v.tab = "files";
  for (const f of v.findings()) act(v, `finding-card:${f.id}`, at(`files, card ${f.id} toggled`));
  v.fopen = null;
  // The popovers: Finish your review (verdicts, the approval asked about), a fix's and a verify agent's previews.
  act(v, "finish", at("Finish open"));
  for (const k of ["approve", "request_changes", "comment"]) act(v, `verdict:${k}`, at(`Finish, ${k}`));
  v.command("verdict:approve", cx); v.approveAsk = true; draw(v, at("Finish, approval asked about")); v.approveAsk = false;
  act(v, "finish", at("Finish closed"));
  const f = v.findings()[0];
  if (f) {
    for (const c of [`fix-finding:${f.id}`, `discuss:${f.id}`, `verify-agent:${f.id}`, "fix-several"]) {
      v.command(c, cx); await settle(); draw(v, at(`preview of ${c}`)); v.sendP = null;
    }
  }
  // The mod's other parts, on what this review published.
  for (const part of ["bar", "reviews", "agentbar", "keys", "cmenu", "mini"]) {
    S.props = { part }; const p = new PrReview(); p.init({}, cx); frame(at(`part ${part}`), () => p.render(cx)); S.props = null;
  }
  for (const r of [R.renderReviews, R.renderAgentBar, R.renderKeys, R.renderCardMenu, R.renderMini]) frame(at(r.name), () => r());
  await settle();
}

const PR2 = { diff: fx("pr2.diff"), ctx: fx("ctx.json") };
const pairs = [["analysis.json", "findings.json"], ["analysis-split.json", "findings-split.json"], ["analysis-zones.json", "findings.json"], ["analysis-md.json", "findings-md.json"],
  ["analysis-s.json", "findings-s.json"], ["analysis-w4.json", "findings-w4.json"]];
for (const [a, f] of pairs) await tour(await open({ ...PR2, analysis: fx(a), findings: fx(f) }), `PR #2 ${a} + ${f}`);
await tour(await open({ diff: fx("pr1.diff"), analysis: fx("analysis-pr1.json"), pr: 1, title: "feat(reminders): due-date reminders" }), "PR #1 without findings or context");
await tour(await open({ ...PR2, findings: fx("findings-split.json") }), "PR #2 without an analysis");
await tour(await open({ ...PR2 }), "PR #2 with nothing yet");

// Runs going: the analysis and every reviewer.
{
  const doc = JSON.parse(fx("findings-split.json")), now = new Date().toISOString();
  for (const k of ["claude", "security", "codex"]) doc.runs[k] = { state: "running", busy: true, started: now };
  const v = await open({ ...PR2, analysis: fx("analysis-split.json"), findings: JSON.stringify(doc) });
  v.aiBusy = { model: "sonnet", started: Date.now(), status: "/h/s" }; v.verifyBusy = { started: Date.now(), n: 2 };
  await tour(v, "PR #2 with every run going");
}
// Runs failed: the analysis and every reviewer, a verification that said not fixed.
{
  const doc = JSON.parse(fx("findings-split.json")), at = new Date().toISOString(), id = doc.findings[0].id;
  for (const k of ["claude", "security", "codex"]) doc.runs[k] = { state: "failed", error: "Stopped without a result", at };
  doc.status = { ...doc.status, [id]: { s: "progress", fixHead: "abc", verify: { result: "not_fixed", reason: "still there", head: "def", branch: "fix/2-x" } } };
  const v = await open({ ...PR2, analysis: fx("analysis-split.json"), findings: JSON.stringify(doc) });
  v.aiError = "The model gave no answer";
  await tour(v, "PR #2 after every run failed");
  v.ai = null; await tour(v, "PR #2, the analysis failed and none is shown");
}
// The Resilience run's block: read, on another head (stale), running, failed, and on someone else's PR (a probe asks first).
{
  const res = JSON.parse(fx("resilience.json")), doc = JSON.parse(fx("findings-s.json"));
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: res }) }), "PR #2 with its resilience paths");
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...res, head: "0000000aaaa" } }) }), "PR #2, resilience of an older head");
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...res, paths: res.paths.map((p) => ({ ...p, blocker: null, result: "mitigated", limited_by: "template.yaml:11" })) } }) }), "PR #2, every path limited");
  for (const state of ["running", "failed"]) await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, runs: { ...doc.runs, resilience: { state, busy: state === "running", error: "Stopped", at: new Date().toISOString() } } }) }), `PR #2, resilience ${state}`);
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: res }), trusted: false }), "someone else's PR with resilience paths");
  // Wave R2: signal and seen_as, a base not comparable, blind spots and calls for the watch list, a doubled effect, a
  // tool text to leave out, a race without on-call words, a probe that never ran and one with an unknown base.
  const r2 = { ...res, not_checked: [...(res.not_checked ?? []), "Runtime behaviour: nothing was executed, because Bash was denied"],
    blind_spots: [{ failure: "Mail transport failure is not visible", at: "library/mailer.py:19", signal: "none", alarm: "none" }, { failure: "Queue age is not monitored", at: "template.yaml:11", signal: "platform_only", alarm: "none" }],
    deps: [{ edge: "e6", at: "template.yaml:32", mode: "async" }], effects: [{ kind: "mail", node: "reminders" }, { kind: "mail", node: "consumer" }],
    paths: res.paths.map((p, k) => ({ ...p, signal: k % 2 ? "none" : "log", seen_as: "Lambda errors in the log", pre_existing: k === 0 ? "unknown" : p.pre_existing, failing: [...(p.failing ?? []), "duplicate_effect", "poison_message"],
      race: p.race ? { ...p.race, oncall: undefined } : p.race, kind: k === 2 ? "timeout" : p.kind, budget: k === 2 ? null : p.budget, ladder: k === 2 ? [] : p.ladder })) };
  const v2 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: r2 }) });
  v2.deep = { ...v2.deep, probes: { [v2.probeKey("pr1")]: { state: "done", status: "script_failed", line: "The agent ended without running the probe.", ms: 0, head: null },
    [v2.probeKey("pr2")]: { state: "done", status: "reproduced", line: "handled 1, no mail", ms: 1100, head: "ccddf95", base: { status: "unknown", line: "TypeError" }, pre_existing: "unknown", network_barrier: true, sandbox: "sandbox-exec" } } };
  await tour(v2, "PR #2, resilience with signals, blind spots and probes not run");
  const w = v2.resNow() && resWatch(v2.resNow(), v2.ai?.arch);
  assert.equal(w.before.length, 1, "a blind spot without any signal goes before the merge");
  assert.ok(!v2.mergeRows().some((r) => /Bash was denied/.test(r.title)) && v2.verdictNow().some((p) => p.key === "resilience"), "the Overview names the resilience blockers");
  // A real run with the R2 schema (deps bound to the map, signal, unseen and watch, same cause, an unclear blocker,
  // state with its rule, a race not possible today), a probe done with its base verdict.
  const r3 = JSON.parse(fx("resilience-r2.json")), v3 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: r3 }) });
  v3.deep = { ...v3.deep, probes: { [v3.probeKey("r1")]: { state: "done", status: "reproduced", line: "handled=1, no mail", ms: 1100, head: "ccddf95", base: { status: "script_failed", verdict: "new_in_pr", line: "ImportError" }, pre_existing: false, network_barrier: true, sandbox: "sandbox-exec" } } };
  assert.ok((v3.resNow()?.unseen ?? []).length > 0 && v3.resNow().paths.some((p) => p.same_cause), "unseen and one cause blocking once come from the data");
  await tour(v3, "PR #2, a real resilience run with the R2 schema");
}
// Someone else's PR with reasons for a security review: the offers instead of a start.
{
  const ctx = { ...JSON.parse(fx("ctx.json")), security_trigger: { run: true, reasons: [{ text: "New route /remind" }, { text: "Token check changed" }] } };
  const doc = JSON.parse(fx("findings.json")); delete doc.runs.security;
  const v = await open({ ...PR2, ctx: JSON.stringify(ctx), analysis: fx("analysis-split.json"), findings: JSON.stringify(doc), trusted: false });
  await tour(v, "someone else's PR, security offered");
  // Its checkout made: the trust question with everything trusting turns on.
  v.worktree = { url: v.prSel.url, head: v.head, path: "/h/w" }; v.repoVis = { [v.prSel.repo]: "PUBLIC" };
  for (const tab of ["files", "steps", "findings"]) act(v, tab, `someone else's PR, the trust question on ${tab}`);
}
await settle();
assert.deepEqual(late, [], "a spawned task threw");
console.log(`smoke ok: ${shown} frames`);
