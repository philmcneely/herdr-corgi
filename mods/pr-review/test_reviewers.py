"""Run: python3 test_reviewers.py  (no network, no model): the security reviewer's view of a PR."""
import json
import os
import pathlib
import sys
import tempfile
import time

sys.dont_write_bytecode = True
import reviewers  # noqa: E402

# The security reviewer answers with its view too; the other reviewers do not.
sec, code = reviewers.findings_schema("security"), reviewers.findings_schema("claude")
assert {"zones", "access", "threats"} <= set(sec["required"]) and not {"zones", "access", "threats"} & set(code["properties"])
assert "ref" in sec["properties"]["findings"]["items"]["required"] and "reachability" not in code["properties"]["findings"]["items"]["properties"]
for part in ("never a defect of the code", "an attacker who has taken over the principal", "zones: the trust zones", "auth_kind (none:", "threats: a threat model", "at least one entry for each of them", "gates: the check", "principal_kind (internet", "without an authorizer"):
    assert part in sec["description"] and part not in code["description"], part

# The security run's own prompt carries the steps of the /security-review template (which cannot run: its template runs
# plain git) plus rights and retries; it asks for nothing it could only guess.
plain = reviewers.PLAIN["security"].format(base="b", number=2)
for part in ("authentication and authorization", "a grant with no such call is a finding", "error and retry paths", "re-run a whole batch",
             "state across components", "secrets:", "personal data and logging", "dependencies:", "Leave out what you could not confirm"):
    assert part in plain, part

# A reviewer reads someone else's code: only the checkout, read-only git, no network, and nothing that is not allowed.
p = reviewers.permissions("/work/check out")
assert p[:3] == ("--restricted", "--permission-mode", "dontAsk"), "file tools confined to the checkout, its .claude settings ignored, the rest refused"
allowed, denied = p[p.index("--allowedTools") + 1:p.index("--disallowedTools")], p[p.index("--disallowedTools") + 1:]
git = f"Bash(python3 {reviewers.review.SAFEGIT} '/work/check out' *)"
assert allowed == ("Read", "Grep", "Glob", "Agent", git), allowed
assert "Bash(git *)" in denied, "no plain git at all: only safegit.py, fixed to this checkout"
assert reviewers.allowed({"kind": "security", "worktree": "/work/check out"}) == list(allowed), "the run records what it was allowed"
assert reviewers.allowed({"kind": "codex", "worktree": "/w"})[0].startswith("codex review: sandbox_mode read-only")
assert reviewers.review.git_hint("/work/check out").startswith(f"Call git only as `python3 {reviewers.review.SAFEGIT} '/work/check out' <command>")
assert reviewers.review.git_hint("/w") in reviewers.findings_schema("claude", "/w")["description"], "a slash command's fork sees the schema"
assert reviewers.review.permissions(None, "Read")[3:5] == ("--allowedTools", "Read") and reviewers.review.git_hint(None) == "", "no checkout: no git"
import llm  # noqa: E402
assert llm.env_for(None)["GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS"] == "1"
# C2 S4: a model run gets no tokens, secrets, AWS_* or GH_* of the window; the account's login stays.
_saved = dict(os.environ)
os.environ.update({"GH_TOKEN": "g", "GITHUB_TOKEN": "g", "AWS_SECRET_ACCESS_KEY": "a", "AWS_PROFILE": "p", "MY_SECRET": "s", "NPM_TOKEN": "n",
                   "CLAUDE_CODE_OAUTH_TOKEN": "login", "ANTHROPIC_API_KEY": "key", "HOME_X": "keep"})
os.environ.pop("CLAUDE_CODE_USE_BEDROCK", None)
_e = llm.env_for(None)
assert not {"GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "MY_SECRET", "NPM_TOKEN"} & set(_e), sorted(k for k in _e if "TOKEN" in k or k.startswith(("AWS_", "GH_")))
assert (_e["CLAUDE_CODE_OAUTH_TOKEN"], _e["ANTHROPIC_API_KEY"], _e["HOME_X"]) == ("login", "key", "keep")
assert llm.env_for({"env": {"CLAUDE_CODE_USE_BEDROCK": "1"}})["AWS_PROFILE"] == "p", "on Bedrock the AWS login stays"
assert llm.env_for({"env": {"GH_TOKEN": "mine"}})["GH_TOKEN"] == "mine", "what the context sets itself stays"
os.environ.clear(); os.environ.update(_saved)
assert json.loads(llm.LEAN[llm.LEAN.index("--settings") + 1])["permissions"] == {"blockReadsOutsideWorkingDirectories": True,
    "additionalDirectories": [str(reviewers.review.SAFEGIT.parent)]}, "built-in reads stay in the checkout and the mod's folder (for safegit.py)"
assert {"Edit", "Write", "WebFetch", "WebSearch"} <= set(denied)

# The picture comes from the newest analysis of the same PR that has one; a request file next to it is no analysis.
home = pathlib.Path(tempfile.mkdtemp())
(home / "cache").mkdir()
(home / "findings").mkdir()
write = lambda name, doc, age: (home / "cache" / name).write_text(json.dumps(doc)) or os.utime(home / "cache" / name, (time.time() - age,) * 2)  # noqa: E731
write("rv-123-aa-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "old"}]}}, "generated": "g1"}, 300)
write("rv-123-bb-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "new"}]}}, "generated": "g2"}, 200)
write("rv-123-cc-sonnet.json", {"answer": {"architecture": {"nodes": []}}}, 100)
write("rv-123-bb-sonnet.json.req.json", {"answer": {"architecture": {"nodes": [{"id": "req"}]}}}, 0)
write("rv-999-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "other PR"}]}}}, 0)
pic, made = reviewers.picture(home / "findings" / "123.json")
assert pic["architecture"]["nodes"] == [{"id": "new"}] and made == "g2", (pic, made)
assert reviewers.picture(home / "findings" / "7.json") == ({}, None)
assert "- new: " in reviewers.picture_text(pic) and "no architecture picture" in reviewers.picture_text({})
# the edges carry the ids the runs name them by (e0, e1 …: the order of the picture, as pr.js and view() count)
assert "- e1: b -> c: x, new" in reviewers.picture_text({"architecture": {"nodes": [{"id": "a"}], "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c", "label": "x", "status": "new"}]}})

# The view: zones over the picture's nodes, the calls between zones of different trust, access rows with their place
# in the diff, and from where each finding is reached (the access rows in its lines, at its node, or at its callers).
pic = {"architecture": {
    "nodes": [{"id": "client", "status": "unchanged"}, {"id": "api", "at": "template.yaml:24", "status": "new"}, {"id": "handler", "at": "lib/handler.py:9", "status": "changed"},
              {"id": "store", "at": "lib/store.py:1", "status": "unchanged"}, {"id": "queue", "status": "new"}, {"id": "worker", "status": "unchanged"},
              {"id": "lone", "status": "unchanged"}, {"id": "cron", "status": "unchanged"}],
    "edges": [{"from": "client", "to": "api", "status": "new"}, {"from": "api", "to": "handler", "status": "new"}, {"from": "handler", "to": "store", "status": "unchanged"},
              {"from": "handler", "to": "queue", "status": "new"}, {"from": "queue", "to": "worker", "status": "new"}, {"from": "cron", "to": "worker", "status": "unchanged"}]},
    "components": [{"name": "FrontDesk", "at": "template.yaml:26", "node": "handler"}]}
answer = {
    "zones": [{"id": "net", "name": "Internet", "trust": "public", "nodes": ["client", "api", "made-up"]}, {"id": "fd", "name": "Front desk", "trust": "authenticated", "nodes": ["handler", "store", "api"]},
              {"id": "q", "name": "Queue", "trust": "data", "nodes": ["queue"]}, {"id": "w", "name": "Worker", "trust": "internal", "nodes": ["worker", "cron"]},
              {"id": "odd", "name": "?", "trust": "secret", "nodes": ["lone"]}, {"id": "net", "name": "again", "trust": "data", "nodes": []}],
    "access": [{"id": "acc1", "resource": "Api", "principal": "anyone on the internet", "public": True, "auth_kind": "code", "at": "template.yaml:24", "node": "api"},
               {"id": "acc2", "resource": "Queue", "principal": "handler", "public": False, "auth_kind": "iam", "at": "./template.yaml:30", "node": "queue"},
               {"id": "acc3", "resource": "Docs", "principal": "anyone", "public": True, "auth_kind": "none", "at": "template.yaml", "node": "lone"},
               {"id": "acc4", "resource": "Ghost", "principal": "x", "public": False, "auth_kind": "iam", "at": "template.yaml:40", "node": "nowhere"},
               {"resource": ""}],
    "threats": [{"where": {"access": "acc1"}, "boundary": "Internet → Front desk", "threat": "An empty token passes the check in `handler.py`.", "findings": ["f1", "f9"], "result": "checked_clean"},
                {"where": {"access": "acc2"}, "boundary": "Front desk → Queue", "threat": "Unchanged grant.", "findings": [], "result": "checked_clean"},
                {"where": {"from": "handler", "to": "queue"}, "boundary": "Front desk → Queue", "threat": "Any loan id lands on the queue.", "findings": [], "result": "checked_clean", "note": "id checked"},
                {"where": {"from": "handler", "to": "store"}, "boundary": "none", "threat": "Same trust, no boundary.", "findings": [], "result": "not_checked"},
                {"where": {"from": "cron", "to": "worker"}, "boundary": "x", "threat": "Unchanged call.", "findings": [], "result": "not_checked"},
                {"where": {"access": "acc3"}, "boundary": "Internet → Docs", "threat": "", "findings": [], "result": "not_checked"},
                {"where": {"from": "client", "to": "api"}, "boundary": "Internet → API", "threat": "Says finding, names none.", "findings": ["f7"], "result": "finding"},
                {"where": {}, "boundary": "", "threat": "Nowhere.", "findings": [], "result": "not_checked"},
                {"where": {"from": "queue", "to": "worker"}, "boundary": "Queue → Worker", "threat": "A forged message.", "stride": "T", "findings": [], "result": "mitigated",
                 "evidence": "worker.py:3", "goal": "Mail any member."}],
    "gates": [{"where": {"access": "acc1"}, "principal": "anyone", "check": "token", "at": "lib/handler.py:9", "source": "code", "holds_if": "FRONT_DESK_TOKEN is set", "carries": ["Authorization header"]},
              {"where": {"from": "handler", "to": "queue"}, "principal": "FrontDesk role", "check": "iam", "at": "template.yaml:30", "source": "config", "holds_if": "", "carries": ["body.id"]},
              {"where": {"from": "api", "to": "handler"}, "principal": "anyone", "check": "none", "at": "template.yaml:24", "source": "config", "holds_if": "", "carries": ["body"]},
              {"where": {"from": "client", "to": "api"}, "principal": "x", "check": "none", "at": "", "source": "config", "holds_if": "", "carries": []},
              {"where": {"access": "acc2"}, "principal": "x", "check": "magic", "at": "", "source": "code", "holds_if": "", "carries": []}]}
f = lambda **kw: {"file": "lib/handler.py", "line": 9, "impact": "edge_case", **kw}  # noqa: E731
findings = [f(id="s1", ref="f1", title="token check fails open", impact="unauthorized_access"),
            f(id="s2", ref="f2", title="by its node, above its line", line=30),
            f(id="s3", title="no place, the model's word", file="nowhere.py", reachability="internal_only"),
            f(id="s4", title="no place, no word", file="nowhere.py"),
            f(id="s5", title="unused grant", file="template.yaml", line=29, end=31),
            f(id="s6", title="by the component above it", file="template.yaml", line=27)]
changed = {"template.yaml": {24, 40}}
v = reviewers.security_view(answer, findings, pic, changed)
assert [(z["id"], z["nodes"]) for z in v["zones"]] == [("net", ["client", "api"]), ("fd", ["handler", "store"]), ("q", ["queue"]), ("w", ["worker", "cron"])], \
    "unknown trust, unknown nodes, a node's second zone and a second zone of the same id go"
assert v["crossing"] == [{"from": "api", "to": "handler", "edge": "e1"}, {"from": "handler", "to": "queue", "edge": "e3"}, {"from": "queue", "to": "worker", "edge": "e4"}], v["crossing"]
assert [(r["id"], r.get("node"), r["opened_by_pr"]) for r in v["access"] if not r.get("derived")] == [("acc1", "api", True), ("acc2", "queue", False), ("acc3", "lone", False), ("acc4", None, True)]
op = [r for r in v["access"] if r.get("derived")]
assert [(r["id"], r["resource"], r["principal_kind"], r["actions"], r["from_gate"], r["value_from"], r.get("node")) for r in op] == [("acc5", "FRONT_DESK_TOKEN", "operator", ["set FRONT_DESK_TOKEN"], 0, None, "api")], \
    "a holds_if that names a setting gives an operator way in; nothing in the repository sets it"
got = {x["title"]: (x["reachable_from"], x["reachability"]) for x in findings}
assert got["token check fails open"] == (["acc1"], "public"), "the broken check itself is reached before any check"
assert got["by its node, above its line"] == (["acc1"], "authenticated"), "the node above its line, then its callers to the entry"
assert got["no place, the model's word"] == ([], "internal_only") and got["no place, no word"] == ([], "unknown")
assert got["unused grant"] == (["acc2"], "internal_only"), "an access row in the finding's own lines is its place"
assert got["by the component above it"] == (["acc1"], "authenticated")
assert not any("ref" in x for x in findings), "the refs are the model's, the ids stay"
old = [f(id="o1", ref="o1", title="old check, new way in", introduced_here=False, impact="unauthorized_access"), f(id="o2", ref="o2", title="old, unreached", file="x.py", introduced_here=False)]
reviewers.security_view(answer, old, pic, changed)
assert [x["introduced_here"] for x in old] == [True, False], "a flaw behind a way in the PR opens is the PR's; one no new way reaches keeps the model's word"
assert "impact" in reviewers.findings_schema("security")["properties"]["findings"]["items"]["required"], "every reviewer finding names its impact (isSecurity reads it)"
t = v["threats"]
assert [(x["id"], x["where"], x["result"], x.get("derived", False)) for x in t] == [
    ("t1", {"access": "acc1"}, "finding", False), ("t2", {"from": "handler", "to": "queue", "edge": "e3"}, "not_assessed", False),
    ("t3", {"from": "queue", "to": "worker", "edge": "e4"}, "mitigated", False),
    ("t4", {"access": "acc4"}, "not_assessed", True), ("t5", {"from": "api", "to": "handler", "edge": "e1"}, "not_assessed", True)], \
    "an unchanged grant, a call within one trust level, an unchanged call, an empty threat and no place go; every new crossing has an entry"
assert (t[0]["findings"], t[0]["stride"]) == (["s1"], "") and (t[2]["stride"], t[2]["goal"], t[2]["evidence"]) == ("T", "Mail any member.", "worker.py:3"), \
    "findings by ref; mitigated keeps its evidence; mitigated without evidence (t2, an older checked_clean) is not assessed"
assert t[4]["boundary"] == "Internet → Front desk" and t[3]["threat"] == "No threat was named for this crossing."
assert [(g["where"], g["check"], g["source"]) for g in v["gates"]] == [({"access": "acc1"}, "token", "code"), ({"from": "handler", "to": "queue", "edge": "e3"}, "iam", "config"),
                                                                      ({"from": "api", "to": "handler", "edge": "e1"}, "none", "config")], "a gate at no crossing or with an unknown check goes"
assert v["effective_zones"] == [{"node": "handler", "drawn": "authenticated", "effective": "public", "where": {"from": "api", "to": "handler", "edge": "e1"}}], \
    "nothing checks the call into handler: it stands in its caller's zone; acc1's check in code leaves api public, as drawn"
code_gate = reviewers.security_view({**answer, "gates": [{**answer["gates"][0], "where": {"from": "api", "to": "handler"}, "check": "token", "source": "code"}]}, [], pic, changed)
assert [z["effective"] for z in code_gate["effective_zones"]] == ["public"], "a check in the card's own code: the card is as exposed as its caller"
assert reviewers.security_view({"threats": [answer["threats"][6]]}, [], {"architecture": {"nodes": pic["architecture"]["nodes"], "edges": pic["architecture"]["edges"]}}, None)["threats"] == [], \
    "no zones: no call crosses a boundary"
lone = reviewers.security_view({"access": [{"resource": "Api", "at": "t.yaml:3", "principal": "anyone", "principal_kind": "robot", "change": "added"}],
                                "threats": [{"where": {"access": "acc1"}, "threat": "x", "result": "finding", "findings": []}]}, [], {}, None)
assert "opened_by_pr" not in lone["access"][0] and "principal_kind" not in lone["access"][0] and lone["access"][0]["change"] == "added"
assert [x["result"] for x in lone["threats"]] == ["not_assessed"], "no diff: the row stays; a finding result needs a finding"
assert reviewers.security_view({"access": [{"resource": "Old", "at": "t.yaml:3", "change": "unchanged"}]}, [], {}, {"t.yaml": {3}})["threats"] == [], "an unchanged grant needs no entry"
assert reviewers.security_view({}, [], {}, {}) == {"zones": [], "access": [], "crossing": [], "bypasses": [], "gates": [], "threats": [], "effective_zones": []}

# Welle 5: zones through runs_in, a call in one process is no crossing but may bypass one, the principal's node, the
# path of a threat, a reach that disagrees with its threat, and an operator way in from a gate's condition.
w5 = {"architecture": {"groups": [{"id": "g_fd"}, {"id": "g_c"}],
      "nodes": [{"id": "h", "status": "changed", "at": "lib/handler.py:9"}, {"id": "c", "status": "new", "runs_in": "g_c"}, {"id": "m", "status": "unchanged", "runs_in": "c"},
                {"id": "q", "status": "new"}],
      "edges": [{"from": "h", "to": "c", "status": "new", "in_process": True}, {"from": "q", "to": "c", "status": "new"}, {"from": "c", "to": "m", "status": "new", "in_process": True},
                {"from": "h", "to": "lib", "status": "new", "in_process": True}]}}
w5["architecture"]["nodes"].append({"id": "lib", "status": "unchanged"})
cfg = pathlib.Path(tempfile.mkdtemp()) / "repo"
cfg.mkdir()
(cfg.parent / "secret.yaml").write_text("FRONT_DESK_TOKEN: from-outside\n")  # outside the checkout
(cfg / "template.yaml").write_text("Resources:\n  Fn:\n    Environment:\n      API_KEY: x\n")
(cfg / "config.yaml").symlink_to(cfg.parent / "secret.yaml")  # a PR can check in a symlink to a file outside
import subprocess  # noqa: E402
subprocess.run(["git", "init", "-q"], cwd=cfg, check=True)
subprocess.run(["git", "add", "template.yaml", "config.yaml"], cwd=cfg, check=True)
ans5 = {"zones": [{"id": "p", "trust": "public", "nodes": ["h"]}, {"id": "i", "trust": "internal", "nodes": ["g_c", "c", "lib"]}, {"id": "d", "trust": "data", "nodes": ["q"]}],
        "access": [{"resource": "Api", "public": True, "auth_kind": "code", "at": "lib/handler.py:9", "node": "h", "change": "added", "principal": "anyone"},
                   {"resource": "Queue", "public": False, "auth_kind": "iam", "at": "t.yaml:5", "node": "q", "change": "added", "principal": "FrontDesk role", "principal_node": "g_fd"},
                   {"resource": "X", "public": False, "at": "t.yaml:6", "change": "added", "principal_node": "ghost"}],
        "gates": [{"where": {"access": "acc1"}, "principal": "bearer", "check": "token", "at": "lib/handler.py:9", "source": "code", "holds_if": "FRONT_DESK_TOKEN and API_KEY are set", "carries": []}],
        "threats": [{"where": {"from": "h", "to": "c"}, "threat": "An internet request reaches the queue handler.", "result": "not_assessed", "note": "no time",
                     "path": ["internet", "h", "c", "m", "made-up"]},
                    {"where": {"access": "acc1"}, "threat": "Empty token passes.", "findings": ["f1"], "result": "finding", "path": ["h", "internet"]}]}
tok = [{"id": "tk", "ref": "f1", "file": "t.yaml", "line": 5, "impact": "unauthorized_access"}]  # placed at the queue's row: reachable_from acc2
v5 = reviewers.security_view(ans5, tok, w5, {"lib/handler.py": {9}, "t.yaml": {5, 6}}, cfg)
assert v5["crossing"] == [{"from": "q", "to": "c", "edge": "e1"}] and v5["bypasses"] == [{"from": "h", "to": "c", "edge": "e0"}], \
    ("in one process: no crossing; into a callee with its own way in (c, the queue's) it bypasses the boundary; c -> m stays inside (m runs in c); "
     "h -> lib reaches a library with no way in of its own: no bypass")
assert [r["principal_node"] for r in v5["access"][:3]] == [None, "g_fd", None], "a principal's node only when the picture has it"
t5 = {x["id"]: x for x in v5["threats"]}
assert (t5["t1"]["where"], t5["t1"]["result"], t5["t1"]["note"], t5["t1"]["path"]) == ({"from": "h", "to": "c", "edge": "e0"}, "not_assessed", "no time", ["internet", "h", "c", "m"]), \
    "a bypass carries a threat; a path keeps the picture's ids and internet first"
assert t5["t2"]["path"] == ["h"] and any(x["where"] == {"from": "q", "to": "c", "edge": "e1"} and x["derived"] for x in v5["threats"])
assert tok[0]["reach_conflict"] == {"finding": {"reachable_from": ["acc2"], "reachability": "internal_only"}, "threat": {"id": "t2", "where": {"access": "acc1"}, "reachability": "public"}}
assert (tok[0]["reachability"], tok[0]["reachable_from"]) == ("public", ["acc1", "acc2"]), "the more exposed side wins, the threat's row first"
ops = [(r["resource"], r["value_from"], r["node"]) for r in v5["access"] if r.get("derived")]
assert ops == [("FRONT_DESK_TOKEN", None, "h"), ("API_KEY", "template.yaml:4", "h")], "an operator way in per setting, with where the repository sets it"
assert reviewers.value_from(cfg, "FRONT_DESK_TOKEN") is None, "a tracked symlink to a file outside is never read"
# The code line of a finding is read only from a regular file inside the checkout, whatever path the model names.
outside = reviewers.normalize([{"file": "../secret.yaml", "line": 1, "title": "t", "detail": "d"}, {"file": "config.yaml", "line": 1, "title": "t2", "detail": "d"},
                               {"file": str(cfg.parent / "secret.yaml"), "line": 1, "title": "t3", "detail": "d"}, {"file": "template.yaml", "line": 4, "title": "t4", "detail": "d"}], "claude", cfg)
assert [x["code"] for x in outside] == ["", "", "", "      API_KEY: x"], [x["code"] for x in outside]
loop = {"architecture": {"groups": [], "nodes": [{"id": "a", "runs_in": "b"}, {"id": "b", "runs_in": "a"}, {"id": "c", "runs_in": "a"}], "edges": []}}
assert reviewers.security_view({"zones": [{"id": "z", "trust": "public", "nodes": []}]}, [], loop, None)["zones"][0]["nodes"] == [], "a runs_in cycle ends, nothing inherits"
agree = [{"id": "ok", "ref": "f1", "file": "lib/handler.py", "line": 9, "impact": "unauthorized_access"}]
reviewers.security_view(ans5, agree, w5, {"lib/handler.py": {9}}, None)
assert "reach_conflict" not in agree[0] and agree[0]["reachable_from"] == ["acc1"], "finding and threat at the same row: no conflict"
shared = {"architecture": {"groups": [], "nodes": [{"id": "h"}, {"id": "c"}, {"id": "mailer", "runs_in": ["c", "h"]}, {"id": "old", "runs_in": "c"}], "edges": []}}
sv = reviewers.security_view({"zones": [{"id": "p", "trust": "public", "nodes": ["h"]}, {"id": "i", "trust": "internal", "nodes": ["c"]}]}, [], shared, None)
assert {z["id"]: z["nodes"] for z in sv["zones"]} == {"p": ["h"], "i": ["c"]}, "the zones list only the run's nodes"
assert reviewers.picture_text(shared).count("runs in c, h") == 1
shared["architecture"]["edges"] = [{"from": "c", "to": "mailer", "status": "new"}, {"from": "c", "to": "old", "status": "new"}]
sv = reviewers.security_view({"zones": [{"id": "p", "trust": "public", "nodes": ["h"]}, {"id": "i", "trust": "internal", "nodes": ["c"]}]}, [], shared, None)
assert [c["to"] for c in sv["crossing"]] == ["mailer"], "a library in a public and an internal process stands in the public one (the most exposed); a single old runs_in still counts"
assert "principal_node (the id" in reviewers.findings_schema("security")["description"] and "bypasses the boundary" in reviewers.findings_schema("security")["description"]
entry = {"architecture": {"nodes": [{"id": "c", "status": "unchanged"}, {"id": "h", "status": "changed"}], "edges": [{"from": "c", "to": "h", "status": "changed"}]}}
ez = {"zones": [{"id": "p", "trust": "public", "nodes": ["c"]}, {"id": "a", "trust": "authenticated", "nodes": ["h"]}],
      "access": [{"resource": "Api", "public": True, "node": "h", "at": "t.yaml:1", "change": "added"}], "threats": [{"where": {"access": "acc1"}, "threat": "x", "result": "not_assessed"}]}
assert [x["where"] for x in reviewers.security_view(ez, [], entry, None)["threats"]] == [{"access": "acc1"}], "the caller's edge into a public entry is that entry, not a second crossing"
assert [x["where"] for x in reviewers.security_view({**ez, "threats": []}, [], entry, None)["threats"]] == [{"access": "acc1"}], "one way in, one not assessed entry"

# The view lands in the findings file next to the runs; a run without one leaves it.
file = home / "findings" / "123.json"
reviewers.merge(file, "security", "h1", [{"id": "s1", "reviewer": "security"}], {"state": "done"}, {"threats": []})
reviewers.merge(file, "security", "h1", None, {"state": "running"})
doc = json.loads(file.read_text())
assert doc["security"] == {"threats": []} and doc["runs"]["security"] == {"state": "running"} and doc["findings"][0]["head"] == "h1"
print("ok")
