"""Run: python3 test_review.py  (no network, no claude)."""
import review

# Jira keys: capitals in title/body, any case in the branch; PR-123, ADR-0043, UTF-8 and friends are not tickets.
assert review.jira_key("feat: SHELF-1234 delete users", None, None) == "SHELF-1234"
assert review.jira_key("fix: thing", "feat/shelf-77-x", None) == "SHELF-77"
assert review.jira_key("fix: thing", "revert/pr-267", "see ADR-0043, UTF-8 and sha-256") is None
assert review.jira_key("shelf-12 lower in title", "main", "Closes LOAN-9") == "LOAN-9"
assert review.jira_key("", "0433-round-a-blob", "") is None
assert review.jira_key("x", None, "https://x.atlassian.net/browse/ABC2-41") == "ABC2-41"

# Jira description: ADF flattened to text, plain strings kept.
adf = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Do "}, {"type": "text", "text": "it"}]},
                                  {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]}]}]}
assert review.adf_text(adf).split() == ["Do", "it", "a"], review.adf_text(adf)
assert review.adf_text("plain") == "plain"

# Line numbers the model can name: new side for + and context, old side for removed lines.
assert review.numbered(["@@ -10,2 +20,2 @@", " a", "-b", "+c", "\\ No newline at end of file"]) == \
    ["@@ -10,2 +20,2 @@", "    20 a", "-   11 b", "+   21 c", "\\ No newline at end of file"]

# The prompt: aliases, task, cut list; no task means an empty asks list.
p = review.prompt([{"alias": "h1", "path": "a.py", "lines": ["@@ -1 +1 @@", "-x", "+y"]}], ["h2", "h3"], "PR: do it", True)
assert "### h1 a.py" in p and "+    1 y" in p and "Task:\nPR: do it" in p and "h2, h3" in p
assert "asks: empty list." in review.prompt([], [], None, False)
assert "in German." in review.prompt([], [], None, False, lang="German")
assert "checkout" in p and "checkout" not in review.prompt([], [], None, False)  # tools only when there is a worktree
assert review.task("/repo#origin/main") is None  # a branch diff has no PR to compare against
print("ok")

# Repo rules: rule files capped, ADRs as title + status/decision only, the global convention always first.
import json, os, pathlib, tempfile  # noqa: E401,E402
import llm  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d)
    (root / "CLAUDE.md").write_text("Use uv.\n" + "x" * 9000)
    (root / ".github").mkdir(); (root / ".github/copilot-instructions.md").write_text("No print().")
    (root / "docs/adr").mkdir(parents=True)
    (root / "docs/adr/0001-db.md").write_text("# 1. Use DynamoDB\n\n## Context\nlong story\n\n## Status\nAccepted\n\n## Decision\nDynamoDB.\n\n## Consequences\nmeh\n")
    cfg = root / "pr-review.config.json"; cfg.write_text(json.dumps({"globalRules": "PR titles follow Conventional Commits."}))
    llm.CONFIG, saved = cfg, llm.CONFIG
    rules = review.repo_rules(d)
    assert rules.startswith("### Global conventions") and "Conventional Commits" in rules
    assert "Use uv." in rules and "x" * 4001 not in rules  # capped per file
    assert "No print()." in rules
    assert "# 1. Use DynamoDB" in rules and "Accepted" in rules and "DynamoDB." in rules and "long story" not in rules and "meh" not in rules
    assert len(review.repo_rules(d, budget=500)) < 1200 and "cut" in review.repo_rules(d, budget=500)
    assert review.repo_rules(None).startswith("### Global conventions")
    llm.CONFIG = saved
assert review.repo_rules(None) == "" or "Global conventions" in review.repo_rules(None)  # the real settings, if any
p = review.prompt([], [], "PR: x", False, rules="### R\nno globals", candidates=[("src/perm.ts", "invite")])
assert "findings (an architecture review" in p and "category" in str(review.SCHEMA["properties"]["steps"])
assert "rule_checks" in p and "no globals" in p and "src/perm.ts (names invite)" in p and "FOLLOW-UP" not in p
assert "FOLLOW-UP" in review.prompt([], [], "PR: x", False, previous="Title: t") and "Task:" not in review.prompt([], [], "PR: x", False, previous="Title: t")

# Incremental merge: old steps keep same-id hunks (gone ones become o<k>), new steps point at today's overlapping hunks.
prev = {"hunks": [{"alias": "h1", "id": "a.py:1"}, {"alias": "h2", "id": "b.py:2"}],
        "answer": {"title": "T", "summary": "S", "merge_risk": {"level": "low", "why": ""}, "asks": [{"text": "q", "coverage": "seen", "hunks": ["h1", "h2"]}],
                   "steps": [{"title": "old", "hunks": ["h1", "h2"], "suggestions": [{"hunk": "h1", "line": 3, "side": "new", "severity": "low", "text": "t"}], "findings": [{"file": "a.py", "line": 2, "severity": "medium", "category": "structure", "title": "f", "detail": "d", "suggestion": "s"}]}]}}
full = [{"alias": "h1", "id": "a.py:1", "path": "a.py", "head": "@@ -1,3 +1,4 @@"}, {"alias": "h2", "id": "b.py:9", "path": "b.py", "head": "@@ -10,2 +10,6 @@"}]
inc = [{"alias": "n1", "path": "b.py", "lines": ["@@ -12,1 +12,3 @@", "+x"]}]
ans = {"summary": "new bits", "steps": [{"title": "new", "reading_order": 1, "hunks": ["n1"], "suggestions": [{"hunk": "n1", "line": 13, "side": "new", "severity": "high", "text": "u"}, {"hunk": "n1", "line": 1, "side": "old", "severity": "low", "text": "v"}]}]}
hunks, merged = review.merge_incremental(prev, ans, inc, full)
assert hunks == [{"alias": "h1", "id": "a.py:1"}, {"alias": "h2", "id": "b.py:9"}, {"alias": "o2", "id": "b.py:2"}], hunks
new, old = merged["steps"]
assert new["new"] and new["hunks"] == ["h2"] and [g["hunk"] for g in new["suggestions"]] == ["h2"] and new["reading_order"] < 1
assert old["hunks"] == ["h1", "o2"] and old["suggestions"][0]["hunk"] == "h1" and not old.get("new")
assert old["findings"][0]["title"] == "f" and not new.get("findings")  # findings stay in their layer
assert merged["asks"][0]["hunks"] == ["h1", "o2"] and merged["merge_risk"]["level"] == "low" and "new bits" in merged["summary"]
assert review.span("@@ -5 +7 @@") == (7, 7) and review.span("@@ -5,2 +7,0 @@") == (7, 7)
print("ok rules/incremental")

# Refresh diagrams (a stubbed call): only the pictures are replaced, in the files that still hold this analysis.
import json, pathlib, tempfile  # noqa: E401,E402
d = pathlib.Path(tempfile.mkdtemp())
prev = {"generated": "2026-01-01T00:00:00", "hunks": [{"alias": "h1", "id": "x"}], "cost": 0.4, "answer": {
    "title": "T", "summary": "S", "behavior": "B", "asks": [{"text": "a", "coverage": "seen", "hunks": ["h1"]}],
    "architecture": {"groups": [], "nodes": [{"id": "old"}], "edges": []}, "visuals": [],
    "steps": [{"title": "one", "explanation": "e1", "hunks": ["h1"], "findings": [{"file": "a.py", "line": 2, "severity": "medium", "category": "structure", "title": "f", "detail": "d", "suggestion": "s"}], "visual": {"kind": "flow", "nodes": [{"id": "v"}]}}, {"title": "two", "hunks": []}]}}
(d / "a.json").write_text(json.dumps(prev))
(d / "latest.json").write_text(json.dumps(prev))
(d / "other.json").write_text(json.dumps({**prev, "generated": "2026-02-02T00:00:00"}))
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, schema=kw["schema"], model=kw["model"])
    kw["meta"].update(cost=0.12, model_id="claude-x")
    return {"architecture": {"groups": [{"id": "g", "label": "G", "kind": ""}], "nodes": [{"id": "new", "group": "g", "source": "spec"}], "edges": []},
            "visuals": [{"kind": "state_machine", "title": "Loan", "nodes": [{"id": "s"}], "edges": []}],
            "layers": [{"layer": 1, "visuals": [{"kind": "flow", "title": "f", "nodes": [{"id": "n"}], "edges": []}]}]}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_diagrams({"diagrams": str(d / "a.json"), "also": [str(d / "latest.json"), str(d / "other.json")], "head": "abc1234",
                              "model": "sonnet", "context": None, "pr": None, "worktree": None, "hunks": [{"alias": "h1", "path": "p.ts", "lines": ["@@ -1 +1 @@", "+x"]}]})
finally:
    review.llm.claude = real
out = json.loads((d / "a.json").read_text())
assert seen["feature"] == "Review diagrams" and seen["schema"] is review.DIAGRAMS_SCHEMA and "1. two" in seen["text"] and "Sources:" in seen["text"]
assert out["answer"]["architecture"]["nodes"][0]["id"] == "new" and out["answer"]["visuals"][0]["title"] == "Loan"
assert [s.get("visuals") for s in out["answer"]["steps"]] == [[], [{"kind": "flow", "title": "f", "nodes": [{"id": "n"}], "edges": []}]]
assert "visual" not in out["answer"]["steps"][0]  # the old single picture goes with the rest
assert out["answer"]["steps"][0]["findings"][0]["title"] == "f"  # refreshing pictures keeps the layer's findings
for k in ("title", "summary", "behavior", "asks"):
    assert out["answer"][k] == prev["answer"][k], k  # the text stays
assert [s["title"] for s in out["answer"]["steps"]] == ["one", "two"] and out["generated"] == prev["generated"] and out["cost"] == 0.4
assert out["diagrams"]["head"] == "abc1234" and out["diagrams"]["cost"] == 0.12 and r["cost"] == 0.12
assert json.loads((d / "latest.json").read_text())["diagrams"]["head"] == "abc1234"
assert "diagrams" not in json.loads((d / "other.json").read_text())  # a newer analysis there: untouched
print("ok diagrams")

# Ask about this: one call ("Review: architecture question") with the picture, the focus, the hunks and the thread;
# read-only tools only in an existing checkout.
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, **{k: kw[k] for k in ("schema", "model", "budget", "tools", "context")})
    kw["meta"].update(cost=0.05, ms=900, model_id="claude-y")
    return {"text": "Weil …", "highlights": {"nodes": ["api"], "edges": ["e0"]}, "evidence": [{"at": "src/api.py:3", "why": "hier"}]}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_ask({"ask": "Warum ruft die API den Worker?", "model": "haiku", "context": {"id": "work", "env": None}, "root": str(d / "missing"),
                         "analysis": {"title": "T", "summary": "S", "layers": [{"title": "L1", "why": "w"}]},
                         "picture": {"nodes": [{"id": "api", "label": "API"}], "edges": [{"id": "e0", "from": "api", "to": "w"}]},
                         "scope": {"kind": "node", "node": {"id": "api"}}, "hunks": [{"path": "src/api.py", "lines": ["@@ -1 +1,2 @@", "+call()"]}],
                         "history": [{"q": "Was ist das?", "a": "Ein Job."}]})
finally:
    review.llm.claude = real
assert seen["feature"] == "Review: architecture question" and seen["schema"] is review.ASK_SCHEMA and seen["model"] == "haiku"
assert seen["budget"] == review.BUDGET_ASK["haiku"] and seen["tools"] == "" and seen["context"]["id"] == "work"
for part in ("Warum ruft die API den Worker?", '"e0"', "L1: w", "call()", "Q: Was ist das?", "A: Ein Job.", '"kind": "node"'):
    assert part in seen["text"], part
assert r["answer"]["highlights"]["edges"] == ["e0"] and r["cost"] == 0.05
assert review.read_tools(str(d))["tools"] == "Read,Grep,Glob" and "Bash" in review.read_tools(str(d))["extra"]
print("ok ask")

# Show details: one call ("Review: drill down") with what to open, the path and the context.
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, schema=kw["schema"], budget=kw["budget"])
    kw["meta"].update(cost=0.07)
    return {"summary": "s", "visual": {"kind": "flow", "title": "t", "nodes": [{"id": "a", "label": "run()", "values": "x = 1"}], "edges": []}}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_drill({"drill": {"label": "Stages handler", "path": ["Architecture", "Workers", "Stages handler"], "subject": {"kind": "node", "id": "stages"}},
                           "model": "sonnet", "context": None, "root": None, "picture": {"nodes": [], "edges": []}, "hunks": []})
finally:
    review.llm.claude = real
assert seen["feature"] == "Review: drill down" and seen["schema"] is review.DRILL_SCHEMA and seen["budget"] == review.BUDGET_DRILL["sonnet"]
assert "Architecture › Workers › Stages handler" in seen["text"] and "debugger" in seen["text"] and r["answer"]["visual"]["nodes"][0]["values"] == "x = 1"
print("ok drill")

# The analysis' own scope: every hunk as a patch with an index, what fits inlined (never lockfiles), every alias in a
# layer (missing ones in "Skimmed (low value)"), and big PRs in cohort passes plus a merge pass, all under the cap.
import tempfile as _tf  # noqa: E402
d2 = pathlib.Path(_tf.mkdtemp())
hs = [{"alias": "h1", "id": "i1", "path": "src/a/x.ts", "lines": ["@@ -1 +1,2 @@", "+a", " b"]}, {"alias": "h2", "id": "i2", "path": "yarn.lock", "lines": ["@@ -1 +1 @@", "+v2"]}]
ix = review.write_run(d2 / "run", hs)
assert (d2 / "run/patches/h1.patch").read_text().startswith("src/a/x.ts\n@@") and json.loads((d2 / "run/index.json").read_text())[1]["low"] is True
assert [i["add"] for i in ix] == [1, 1] and "h2 yarn.lock +1 -0 low" in review.index_text(ix)
assert [h["alias"] for h in review.pick_inline(hs, 10_000)] == ["h1"], "lockfiles are never inlined"
ans = review.account({"steps": [{"title": "A", "hunks": ["h1", "h1", "zz"]}]}, ["h1", "h2"], ix)
assert ans["steps"][0]["hunks"] == ["h1"] and ans["steps"][1]["title"] == "Skimmed (low value)" and ans["steps"][1]["hunks"] == ["h2"]
assert "yarn.lock" in ans["steps"][1]["why_it_matters"]
assert review.scope_of(ans, ix) == {"files": 2, "detailed": 1, "skimmed": 1, "why": "lockfiles", "passes": 1}
cb, mb = review.pass_budgets(3.0, 4)
assert sum(cb) + mb <= 3.0 + 1e-9 and len(cb) == 4

big = [{"alias": f"h{k}", "id": f"i{k}", "path": f"{['api', 'web', 'jobs'][k % 3]}/m{k}/f{k}.ts", "lines": ["@@ -1 +1,400 @@"] + ["+" + "x" * 150] * 400} for k in range(1, 10)]
big.append({"alias": "h10", "id": "i10", "path": "package-lock.json", "lines": ["@@ -1 +1 @@", "+lock"]})
co = review.cohorts_of(big, review.INLINE["haiku"])
assert co and len(co) >= 2 and all(not review.low_value(h["path"]) for c in co for h in c)
assert sorted(h["alias"] for c in co for h in c) == sorted(f"h{k}" for k in range(1, 10)), "each high-value hunk in one cohort"
assert review.cohorts_of(hs, review.INLINE["haiku"]) is None, "a small PR: one pass"
calls, statuses = [], []
real_save = review.save
def stub2(feature, text, **kw):  # noqa: E302
    calls.append((feature, kw["budget"], kw["schema"]))
    kw["meta"].update(cost=0.1, ms=10, model_id="claude-z")
    if kw["schema"] is review.COHORT_SCHEMA:
        mine = [a for a in (f"h{k}" for k in range(1, 10)) if f"\n{a} " in "\n" + text.split("Index:")[-1]]
        return {"summary": "c", "steps": [{"title": f"L{mine[0]}", "risk": "low", "why_it_matters": "w", "explanation": "e", "reading_order": 1, "hunks": mine, "check_questions": []}]}
    return {"title": "T", "summary": "S", "behavior": "B", "merge_risk": {"level": "low", "why": "w"}, "effort": {"score": 2, "why": "w"},
            "rule_checks": [], "architecture": {"groups": [], "nodes": [], "edges": []}, "blast_radius": {"units": [], "context": []}, "asks": [], "reading_order": [1, 0],
            "read": ["lib/unchanged.py", "./lib/unchanged.py", big[0]["path"]]}
real, review.llm.claude = review.llm.claude, stub2
review.save = lambda path, value: (statuses.append(value) if str(path).endswith(".status") else None, real_save(path, value))[1]
try:
    r = review.main({"model": "haiku", "context": None, "worktree": None, "pr": None, "hunks": big, "out": str(d2 / "o.json"), "latest": str(d2 / "l.json"), "status": str(d2 / "o.json.status")})
finally:
    review.llm.claude, review.save = real, real_save
merge = [c for c in calls if c[2] is review.MERGE_SCHEMA]
assert len(merge) == 1 and len(calls) == len(co) + 1, "one pass per cohort, then the merge"
assert sum(b for _, b, _ in calls) <= review.BUDGET["haiku"] + 1e-9, "all under the cap"
assert any(c[0].startswith("Review analysis (pass") for c in calls)
placed = [a for st in r["answer"]["steps"] for a in st["hunks"]]
assert sorted(placed) == sorted(h["alias"] for h in big), "every alias accounted for"
assert r["answer"]["steps"][-1]["skimmed"] and r["answer"]["steps"][-1]["hunks"] == ["h10"]
assert r["scope"]["passes"] == len(co) + 1 and r["scope"]["skimmed"] == 1 and r["cut"] == []
assert r["scope"]["read"] == ["lib/unchanged.py"] and "read" not in r["answer"], "read: files outside the diff, once"
assert [x["pass"] for x in statuses if "pass" in x][0] == 1 and statuses[-1]["passes"] == len(co) + 1, "progress: Pass k of n"
assert r["usage"] == {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}  # the stub reports none
assert r["answer"]["title"] == "T" and r["cost"] == round(0.1 * (len(co) + 1), 10) or abs(r["cost"] - 0.1 * (len(co) + 1)) < 1e-9
print("ok scope")

# After the model (finish): requirements, findings and the picture linked; severity by the fixed scale; the id is the UI's.
assert review.fnv("structure|library/handler.py|Front desk calls the consumer directly") == "d2b4cdf9"  # pr.js hash() of the same text
assert review.fnv("test|a/ü.py|Täst 😀") == "2c51ed76"  # UTF-16 code units, as charCodeAt
assert [review.SCALE[k] for k in ("breaks_requirement", "dead_path", "unauthorized_access", "data_exposure", "degraded_operation", "unrequested")] == ["high"] * 4 + ["medium", "low"]
assert review.judge({"impact": "dead_path", "severity": "low"})["severity"] == "high", "the impact sets the severity"
assert review.judge({"impact": "nonsense", "severity": "low", "category": "x"}) == {"severity": "low"}, "no impact: its own severity; unknown values go"
assert review.judge({"impact": "edge_case"}, True) == {"impact": "breaks_requirement", "severity": "high"}
assert review.judge({"impact": "edge_case", "effort": "heavy"})["effort"] == "heavy" and "effort" not in review.judge({"impact": "edge_case", "effort": "huge"})
deps = review.finish({"steps": [{"title": "Model", "depends_on": []}, {"title": "API", "depends_on": ["Model", "Model", "API", "Nowhere"]}, {"title": "Old"}]})["steps"]
assert deps[1]["depends_on"] == ["Model"] and "depends_on" not in deps[2], "only other layers; a cached layer without it stays without"
assert "effort (what the fix takes" in review.prompt([], [], None, True) and "depends_on (the titles" in review.prompt([], [], None, True)
assert review.judge({"impact": "breaks_requirement", "category": "test"}, True)["severity"] == "medium", "a test gap leaves a requirement unguarded, it does not break it"
wt = pathlib.Path(tempfile.mkdtemp())
(wt / ".github").mkdir(); (wt / ".github/CODEOWNERS").write_text("# owners\n*.yaml @ops\n/library/ @lib-team @lead\nlibrary/tests/ \n")
(wt / "library").mkdir(); (wt / "library/loans.py").write_text("x")
fin = lambda **kw: {"file": "library/s.py", "line": 3, "title": "t", "detail": "d", "suggestion": "s", "category": "bug", "impact": "edge_case",  # noqa: E731
                    "effect": "e", "preconditions": [], "certainty": "derived", "criteria": [], **kw}
ans = review.finish({
    "asks": [{"id": "c1", "text": "one event per change", "acceptance": True, "state": "met", "why": "w", "hunks": ["h1"]},
             {"id": "c2", "text": "only the consumer mails", "acceptance": True, "state": "broken", "why": "w", "hunks": []},
             {"id": "c3", "text": "a new route", "acceptance": False, "state": "extra", "why": "w", "hunks": []}],
    "architecture": {"nodes": [{"id": "status"}, {"id": "mailer"}, {"id": "reminders"}], "edges": [{"from": "status", "to": "mailer"}, {"from": "reminders", "to": "mailer"}]},
    "components": [{"name": "LoanEvents", "kind": "queue", "status": "new", "at": "template.yaml:11", "node": "gone", "operate": ["no dead-letter queue"]},
                   {"name": "transition()", "kind": "function", "status": "changed", "at": "library/status.py:43", "node": "status", "operate": []},
                   {"name": "tests", "kind": "module", "status": "new", "at": "library/tests/test_x.py:1", "operate": []}],
    "steps": [{"check_questions": ["q1", "q2", "q3"], "question_files": ["./library/loans.py", "library/s.py", "made/up.py"], "findings": [
        fin(title="Status set outside transition()", criteria=["c1", "c2", "c1"]),
        fin(title="Mailed twice", criteria=["c2"], impact="breaks_requirement", breaks={"from": "reminders", "to": "mailer"}),
        fin(title="Unasked route", criteria=["c3"], category="scope", impact="unrequested", breaks={"node": "status"}),
        fin(title="No DLQ", criteria=["c9"], category="availability", impact="degraded_operation", breaks={"node": "nowhere"})]}]}, str(wt), {"h1": "library/s.py"})
c1, c2, c3 = ans["asks"]
f1, f2, f3, f4 = ans["steps"][0]["findings"]
assert f1["id"] == "a" + review.fnv("bug|library/s.py|Status set outside transition()") and f1["criteria"] == ["c1", "c2"], "a finding may break several requirements"
assert c1["findings"] == [f1["id"]] and c2["findings"] == [f1["id"], f2["id"]]
assert (f1["severity"], f1["impact"]) == ("high", "breaks_requirement"), "a finding that breaks a requirement is high"
assert (c1["state"], c1["coverage"]) == ("partly", "partly"), "met with a finding that breaks it is partly"
assert (c2["state"], c2["coverage"]) == ("broken", "absent") and (c3["state"], c3["coverage"]) == ("extra", "extra")
assert ans["unlinked"] == [], "every broken or partly requirement here has a finding"
assert f3["severity"] == "low" and f3["criteria"] == ["c3"] and c3["findings"] == [f3["id"]], "an extra change does not raise the severity"
assert f4["criteria"] == [] and f4["severity"] == "medium" and "breaks" not in f4, "unknown requirement and node dropped"
assert f2["breaks"] == {"from": "reminders", "to": "mailer", "edge": "e1"} and f3["breaks"] == {"node": "status"}
rp = {"architecture": {"groups": [{"id": "g_fd"}], "nodes": [{"id": "h", "runs_in": "g_fd"}, {"id": "c", "runs_in": "h"}, {"id": "x", "runs_in": "nowhere"}, {"id": "s", "runs_in": "s"}],
                       "edges": [{"from": "h", "to": "c", "in_process": True}, {"from": "c", "to": "x", "in_process": "yes"}]}, "steps": []}
review.place(rp)
assert [n.get("runs_in") for n in rp["architecture"]["nodes"]] == [["g_fd"], ["h"], None, None] and [e.get("in_process") for e in rp["architecture"]["edges"]] == [True, None], \
    "runs_in names a group or another node; in_process is a bool"
cy = {"architecture": {"groups": [], "nodes": [{"id": "a", "runs_in": "b"}, {"id": "b", "runs_in": "a"}, {"id": "c", "runs_in": "a"}, {"id": "d", "runs_in": "c"}], "edges": []}, "steps": []}
review.place(cy)
chain = {n["id"]: n.get("runs_in") for n in cy["architecture"]["nodes"]}
assert sum(1 for k in ("a", "b") if chain[k]) == 1 and chain["c"] == ["a"] and chain["d"] == ["c"], ("a cycle loses one link, the rest stays", chain)
many = {"architecture": {"groups": [{"id": "g_fd"}, {"id": "g_rc"}], "nodes": [{"id": "mailer", "runs_in": ["g_fd", "g_rc", "g_fd", "nowhere"]}, {"id": "x", "runs_in": []}], "edges": []}, "steps": []}
review.place(many)
assert [n.get("runs_in") for n in many["architecture"]["nodes"]] == [["g_fd", "g_rc"], None], "a library in several processes keeps each known one once"
assert review.runs_in_of({"runs_in": "g"}) == ["g"] and review.runs_in_of({}) == [] and "several when it runs in several" in review.prompt([], [], None, True)

# Files of a checkout are read only as regular files inside it: no symlink on the way, no .., no absolute path.
top = pathlib.Path(tempfile.mkdtemp())
(top / "outside.md").write_text("SECRET\n")
co = top / "co"
(co / "docs").mkdir(parents=True)
(co / "CONTRIBUTING.md").write_text("Use small PRs.\n")
(co / "CLAUDE.md").symlink_to(top / "outside.md")
(co / "linked").symlink_to(top)
(co / ".github").mkdir()
(co / ".github" / "CODEOWNERS").symlink_to(top / "outside.md")
assert review.read_checkout(co, "CONTRIBUTING.md") == "Use small PRs.\n" and review.read_checkout(co, "CONTRIBUTING.md", cap=3) == "Use"
for bad in ("CLAUDE.md", "linked/outside.md", "../outside.md", str(top / "outside.md"), "~/x", "docs", "nope.md"):
    assert review.read_checkout(co, bad) is None, bad
rules = review.repo_rules(co)
assert "Use small PRs." in rules and "SECRET" not in rules and review.code_owners(co) is None, "symlinked rules and CODEOWNERS are skipped"
assert ans["steps"][0]["question_files"] == ["library/loans.py", "library/s.py", ""], ans["steps"][0]["question_files"]
assert [c["owner"] for c in ans["components"]] == ["@ops", "@lib-team @lead", None], [c["owner"] for c in ans["components"]]
assert ans["component_counts"] == {"new": 2, "changed": 1, "no_owner": 1, "codeowners": True}
assert "node" not in ans["components"][0] and ans["components"][1]["node"] == "status"
assert review.code_owners(None) is None and review.owner_of("a/b.py", [("docs/", "@d"), ("*.py", "@py")]) == "@py"
assert review.checked([{"area": "secrets", "result": "clean", "note": "none in the diff"}, {"area": "tests", "result": "bogus"}], ["secrets", "tests", "state"]) == \
    [{"area": "secrets", "result": "clean", "note": "none in the diff"}, {"area": "tests", "result": "not_checked", "note": ""}, {"area": "state", "result": "not_checked", "note": ""}]

# An analysis cached before these fields loads: coverage becomes the state, findings keep their severity.
old = review.finish({"asks": [{"text": "a", "coverage": "absent", "hunks": []}, {"text": "b", "coverage": "seen", "hunks": []}],
                     "steps": [{"check_questions": ["q"], "findings": [{"file": "a.py", "line": 1, "severity": "medium", "category": "structure", "title": "f", "detail": "", "suggestion": ""}]}]})
assert [(a["id"], a["state"], a["coverage"], a["findings"]) for a in old["asks"]] == [("c1", "not_done", "absent", []), ("c2", "met", "seen", [])]
assert old["unlinked"] == ["c1"], "not_done without a finding that names it is reported, a met one is not"
assert old["steps"][0]["findings"][0]["severity"] == "medium" and old["steps"][0]["findings"][0]["criteria"] == [] and old["steps"][0]["question_files"] == [""] and "component_counts" not in old

# The prompt asks for all of it; a state diagram is not optional where the diff touches a state machine (also on a diagram refresh).
p = review.prompt([], [], "PR: x", True)
for part in ("state (met:", "not_done", "acceptance (true", "criteria (the ids", "is named by at least one finding", "breaks (where it breaks", "question_files", "category (as for findings)",
             "breaks_requirement (breaks an acceptance criterion", "certainty (confirmed", "preconditions (what must hold", "test: changed behavior",
             "titled \"Tests\"", "one finding per defect", "with impact untested", "components: the inventory", "checked: your own report"):
    assert part in p, part
# The security view is the security reviewer's (reviewers.py): the analysis asks for none of it and reports only the
# code areas of its scope; its security findings it still reports.
for part in ("zones", "access:", "auth_kind", "reachability", "without an authorizer", "authentication"):
    assert part not in p and part not in review.picture_guide("English"), part
assert "security: exposure, auth, secrets, permissions" in p
assert "zones" not in review.ARCHITECTURE["properties"] and "access" not in review.SCHEMA["properties"] and "reachability" not in review.FINDING["properties"]
assert review.SCHEMA["properties"]["checked"]["items"]["properties"]["area"]["enum"] == review.AREAS_CODE
assert "Texts: detail, suggestion, effect, why" in p and "title (one line, plain text)" in p and "fenced code block" in p and "short bullet list" in p
assert "Texts:" not in review.picture_guide("English"), "pictures carry no prose rules"
assert "This one is not optional" in p and "This one is not optional" in review.picture_guide("English")
assert "coverage" not in p and "severity (high|medium|low)," not in p, "a finding's severity comes from its impact"
assert "ids so far: old" in review.diagrams_prompt([], {"answer": {"architecture": {"nodes": [{"id": "old"}]}}}, None, False)
moved = review.merge_diagrams({"answer": {"steps": [{"findings": [{"title": "f", "breaks": {"node": "old"}}, {"title": "g", "breaks": {"node": "kept"}}]}]}},
                              {"architecture": {"groups": [], "nodes": [{"id": "kept"}], "edges": []}}, "h", {})
assert [f.get("breaks") for f in moved["answer"]["steps"][0]["findings"]] == [None, {"node": "kept"}], "a refreshed picture drops places it no longer has"

# A state diagram sits in the layer that changes the state machine, wherever the model put it (the whole PR, another layer).
sm = lambda **kw: {"kind": "state_machine", "title": "Loan", "nodes": [{"id": "b", "label": "borrowed", "at": "lib/status.py:8"}, {"id": "o", "label": "overdue", "at": "./lib/status.py:10"}],  # noqa: E731
                   "edges": [], "transitions": [{"from": "o", "to": "o", "evidence": "lib/reminders.py:33"}], **kw}
seated = review.finish({"visuals": [sm(), {"kind": "sequence", "title": "s", "nodes": [], "edges": []}],
                        "steps": [{"title": "reminders", "hunks": ["h1"]}, {"title": "state machine", "hunks": ["h2", "h3"]}, {"title": "tests", "hunks": ["h4"], "visuals": [sm(title="Again")]}]},
                       None, {"h1": "lib/reminders.py", "h2": "lib/status.py", "h3": "lib/events.py", "h4": "lib/test_status.py"})
assert [v["title"] for v in seated["steps"][1]["visuals"]] == ["Loan", "Again"] and [v["kind"] for v in seated["visuals"]] == ["sequence"]
assert not seated["steps"][0].get("visuals") and seated["steps"][2]["visuals"] == []
stays = review.finish({"visuals": [{"kind": "state_machine", "title": "No evidence", "nodes": [{"id": "a"}], "edges": []}], "steps": [{"title": "x", "hunks": ["h1"]}]}, None, {"h1": "a.py"})
assert [v["title"] for v in stays["visuals"]] == ["No evidence"], "nothing to go by: it stays where it is"
assert "except for the state diagram" in p and "a state diagram goes into the layer" in p
# Round 4: a finding in lines the PR adds is the PR's; else the model's word, else true. The way from outside is said
# apart from the flaw; a requirement's short name has at most eight words.
ch = review.changed_lines([{"path": "a.py", "lines": ["@@ -1,2 +5,3 @@", " x", "+y", "-z", "+w"]}])
assert ch == {"a.py": {6, 7}}
intro = lambda **kw: review.introduced({"file": "a.py", "line": 1, **kw}, ch)["introduced_here"]  # noqa: E731
assert [intro(line=6), intro(line=4, end=6, introduced_here=False), intro(line=1, introduced_here=False), intro(line=1), intro(file="b.py", introduced_here=False)] == [True, True, False, True, False]
assert intro(line=2, end=10**9, introduced_here=False) is True and intro(line=8, end=10**9, introduced_here=False) is False, "a huge end is compared, not enumerated"
assert review.introduced({"file": "a.py", "line": 9, "introduced_here": False}, None)["introduced_here"] is False, "a follow-up analysis without the whole diff keeps the model's word"
j = review.judge({"impact": "unauthorized_access", "certainty": "derived", "path_certainty": "assumed", "path_why": "gateway", "introduced_here": "yes"})
assert (j["certainty"], j["path_certainty"], j["path_why"], "introduced_here" in j) == ("derived", "assumed", "gateway", False)
assert "path_why" not in review.judge({"path_certainty": "maybe", "path_why": "x"})
sh = review.finish({"asks": [{"id": "c1", "text": "t", "short": "one  reminder mail per loan and never ever twice", "state": "met", "hunks": []}], "steps": [
    {"title": "x", "hunks": [], "findings": [fin(title="new", file="a.py", line=6, introduced_here=False), fin(title="old", file="a.py", line=1, introduced_here=False),
     fin(title="old line, breaks c1", file="a.py", line=1, introduced_here=False, criteria=["c1"])]}]}, None, {}, ch)
assert sh["asks"][0]["short"] == "one reminder mail per loan and never ever" and [f["introduced_here"] for f in sh["steps"][0]["findings"]] == [True, False, True], \
    "breaking a requirement of this PR is the PR's, also in old lines"
p4 = review.prompt([], [], "PR: x", True)
for part in ("what_changed: the change as three short lists", "read: the paths of the files outside the diff", "short (its name in at most eight words",
             "introduced_here (true when", "path_certainty (confirmed, derived or assumed", "certainty stays about the code alone",
             "one thought in at most twelve words", "one sentence of at most 20 words", "would be the same without the PR", "runs_in (for code",
             "in_process: true when the call stays in one process"):
    assert part in p4, part
assert {"what_changed", "read"} <= set(review.SCHEMA["required"]) and {"what_changed", "read"} <= set(review.MERGE_SCHEMA["required"])
print("ok finish")

