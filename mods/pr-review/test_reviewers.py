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
assert reviewers.allowed({"kind": "codex", "worktree": "/w"})[0].startswith("codex exec review: reads the checkout and its clone's .git only, no writes")
assert reviewers.review.git_hint("/work/check out").startswith(f"Call git only as `python3 {reviewers.review.SAFEGIT} '/work/check out' <command>")
assert reviewers.review.git_hint("/w") in reviewers.findings_schema("claude", "/w")["description"], "a slash command's fork sees the schema"
assert reviewers.review.permissions(None, "Read")[3:5] == ("--allowedTools", "Read") and reviewers.review.git_hint(None) == "", "no checkout: no git"
import llm  # noqa: E402
assert llm.env_for(None)["GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS"] == "1"
# A model run gets an allowlist of the window's environment: no key, password, token, agent socket, GIT_*, AWS_* or
# GH_* of the window; what a CLI needs to start and the run's own login stay.
_saved = dict(os.environ)
_gone = {"GH_TOKEN": "g", "GITHUB_TOKEN": "g", "AWS_SECRET_ACCESS_KEY": "a", "AWS_PROFILE": "p", "MY_SECRET": "s", "NPM_TOKEN": "n", "STRIPE_API_" + "KEY": "k",
         "DB_PASS" + "WORD": "w", "SSH_AUTH_SOCK": "/s", "GIT_SSH_COMMAND": "x", "GIT_DIR": "/elsewhere", "OPENAI_API_" + "KEY": "o", "HOME_X": "unknown"}
_kept = {"CLAUDE_CODE_OAUTH_TOKEN": "login", "ANTHROPIC_API_" + "KEY": "key", "CLAUDE_CONFIG_DIR": "/c", "PATH": "/bin", "HOME": "/h", "LANG": "C", "LC_ALL": "C",
         "TMPDIR": "/t", "https_proxy": "http://p", "CODEX_HOME": "/cx"}
os.environ.update({**_gone, **_kept})
os.environ.pop("CLAUDE_CODE_USE_BEDROCK", None), os.environ.pop("CLAUDE_CODE_USE_VERTEX", None)
_e = llm.env_for(None)
assert not set(_gone) & set(_e), sorted(set(_gone) & set(_e))
assert not {k: v for k, v in _kept.items() if k != "CODEX_HOME" and _e.get(k) != v}, "what a Claude run needs stays"
assert "CODEX_HOME" not in _e, "Codex's login is for the Codex run only"
_cx = llm.env_for(None, llm.CODEX_LOGIN)
assert (_cx["CODEX_HOME"], _cx["OPENAI_API_" + "KEY"], _cx["PATH"], _cx["HOME"]) == ("/cx", "o", "/bin", "/h") and not [k for k in _cx if k.startswith(("CLAUDE_", "ANTHROPIC_", "GH_", "SSH_"))], \
    "a Codex run gets Codex's login and not Claude's"
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
assert reviewers.security_view({}, [], {}, {}) == {"zones": [], "access": [], "crossing": [], "bypasses": [], "gates": [], "threats": [], "effective_zones": [], "data": []}
# The sensitive data the answer names: only steps on a card of the picture, a kind or a sink outside the lists does not
# pass as said, empty texts stay empty (the page says "not stated"), an entry without a step on the picture goes.
dv = reviewers.security_view({"data": [
    {"id": "x", "name": " bearer token ", "kind": "credential", "steps": [{"node": "client"}, {"node": "handler", "at": "lib/handler.py:9", "protected": " TLS ", "sink": "nowhere"}, {"node": "moon", "sink": "log"}]},
    {"name": "mail address", "kind": "pii", "steps": [{"node": "worker", "at": "lib/worker.py:4", "sink": "log", "retention": None}]},
    {"name": "gone", "kind": "secret", "steps": [{"node": "moon"}]}, {"name": "", "steps": [{"node": "handler"}]}, "text"]}, [], pic, None)["data"]
assert dv == [{"id": "d1", "name": "bearer token", "kind": "credential", "steps": [{"node": "client", "at": "", "protected": "", "retention": ""}, {"node": "handler", "at": "lib/handler.py:9", "protected": "TLS", "retention": ""}]},
              {"id": "d2", "name": "mail address", "kind": "other", "steps": [{"node": "worker", "at": "lib/worker.py:4", "sink": "log", "protected": "", "retention": ""}]}], dv
assert set(reviewers.SECURITY["data"]["items"]["properties"]["kind"]["enum"]) == set(reviewers.DATA_KINDS) and "data" in reviewers.findings_schema("security")["required"], "the schema asks for it"

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

# A webhook into one cloud account with an admin script that reaches another: a deny rule is a guard (no grant, no
# placeholder), a right on something off the picture is no crossing, a call the run named through its access row gets
# no second "no threat was named", a call out of the account is a crossing at equal trust, and two checks that hold on
# unnamed secrets give one operator way with both names.
hook = {"architecture": {
    "groups": [{"id": "out", "kind": "External"}, {"id": "acct", "kind": "Cloud account"}, {"id": "ops", "kind": "Client"}, {"id": "org", "kind": "Cloud account"}],
    "nodes": [{"id": "sender", "group": "out", "status": "unchanged"}, {"id": "gw", "group": "acct", "status": "new", "label": "Hooks API"}, {"id": "fn", "group": "acct", "status": "new"},
              {"id": "vault", "group": "acct", "status": "new"}, {"id": "topic", "group": "acct", "status": "new"}, {"id": "sink", "group": "acct", "status": "new"},
              {"id": "tool", "group": "ops", "status": "new"}, {"id": "policies", "group": "org", "status": "unchanged"}, {"id": "peer", "group": "org", "status": "new"}],
    "edges": [{"from": "sender", "to": "gw", "status": "new"}, {"from": "gw", "to": "fn", "status": "new"}, {"from": "fn", "to": "vault", "status": "new"},
              {"from": "fn", "to": "topic", "status": "new"}, {"from": "topic", "to": "sink", "status": "new"}, {"from": "tool", "to": "policies", "status": "new"},
              {"from": "topic", "to": "peer", "status": "new"}]}}
row = lambda **kw: {"public": False, "auth_kind": "iam", "change": "added", "principal_kind": "role", "at": "infra.tf:1", **kw}  # noqa: E731
hook_ans = {
    "zones": [{"id": "z0", "trust": "public", "nodes": ["sender"]}, {"id": "z1", "trust": "public", "nodes": ["gw", "fn"]}, {"id": "z2", "trust": "internal", "nodes": ["topic"]},
              {"id": "z3", "trust": "data", "nodes": ["vault", "sink"]}, {"id": "z4", "trust": "authenticated", "nodes": ["tool"]}, {"id": "z5", "trust": "internal", "nodes": ["policies", "peer"]}],
    "access": [row(resource="route", principal="anyone on the internet", public=True, auth_kind="code", node="gw", principal_kind="internet"),
               row(resource="fn-policy", principal="fn role", principal_node="fn", node="vault", actions=["secrets:Get"]),
               row(resource="fn-policy", principal="fn role", principal_node="fn", actions=["logs:Put"]),
               row(resource="topic-policy", principal="everyone but the fn role", node="topic", actions=["deny events:Put"]),
               row(resource="sink-policy", principal="anyone in the account", node="sink", actions=["store:*"], effect="deny"),
               row(resource="admin.sh", principal="operator", principal_node="ops", principal_kind="operator", node="tool", actions=["org:Detach"])],
    "gates": [{"where": {"access": "acc1"}, "principal": "anonymous", "check": "token", "at": "fn.py:4", "source": "code", "holds_if": "the first hook secret is set and not empty", "carries": ["body"]},
              {"where": {"access": "acc1"}, "principal": "anonymous", "check": "signature", "at": "fn.py:9", "source": "code", "holds_if": "the second hook secret is set", "carries": ["body"]}],
    "threats": [{"where": {"access": "acc1"}, "threat": "A forged call.", "result": "mitigated", "evidence": "fn.py:4", "path": ["sender", "gw", "fn"]},
                {"where": {"access": "acc2"}, "threat": "A taken-over fn role reads the secrets.", "result": "mitigated", "evidence": "infra.tf:1", "path": ["fn", "vault"]},
                {"where": {"access": "acc4"}, "threat": "Another principal publishes directly.", "result": "mitigated", "evidence": "infra.tf:2", "path": ["topic"]},
                {"where": {"access": "acc6"}, "threat": "The operator leaves the policies detached.", "result": "not_assessed", "note": "no time", "path": ["ops", "tool", "policies"]}]}
hv = reviewers.security_view(hook_ans, [], hook, None)
assert [(r["id"], r.get("effect")) for r in hv["access"] if r.get("effect")] == [("acc4", "deny"), ("acc5", "deny")], "a deny rule is a guard: by its effect, or (an older run) by its actions"
assert {"from": "topic", "to": "peer", "edge": "e6"} in hv["crossing"], "a call out of the cloud account is a crossing, also between two internal zones"
derived = [x["where"] for x in hv["threats"] if x.get("derived")]
assert derived == [{"from": "fn", "to": "topic", "edge": "e3"}, {"from": "topic", "to": "sink", "edge": "e4"}, {"from": "topic", "to": "peer", "edge": "e6"}], \
    ("placeholders only for the calls nothing names: not for a guard (acc5), a right off the picture (acc3), the call a right's threat covers (fn → vault, acc2) "
     f"or the call an operator's threat walks (tool → policies, acc6): {derived}")
hop = [r for r in hv["access"] if r.get("derived")]
assert [(r["resource"], r["actions"], r["from_gate"], r["from_gates"], r["node"]) for r in hop] == \
    [("first hook secret; second hook secret", ["set first hook secret", "set second hook secret"], 0, [0, 1], "gw")], "one operator way per card, named by the conditions' subjects"
assert "effect (deny" in reviewers.findings_schema("security")["description"] and "replayed genuine request" in reviewers.findings_schema("security")["description"]
assert "make this threat possible or worse" in reviewers.findings_schema("security")["description"], "a threat cites what enables it, not a defect at the same place"
assert "never a tool" in reviewers.findings_schema("claude")["description"], "a run's skipped list is about the PR, not about its tools"
# Second round: a zone of operator scripts only is the operator's zone, whatever the answer calls it; a finding a
# threat stands on carries that threat (isSecurity in pr.js reads it), a defect named as a threat does not count; a
# guard the PR narrows or removes gets a placeholder like a crossing, one it adds does not.
assert {z["id"]: z["trust"] for z in hv["zones"]}["z4"] == "operator" and "operator" in reviewers.TRUST and reviewers.RULES == 2
loose = {**hook_ans, "access": [*hook_ans["access"][:3], {**hook_ans["access"][3], "change": "narrowed", "holds_against": "another role publishes"}, {**hook_ans["access"][4], "change": "removed"},
                                hook_ans["access"][5]],
         "threats": [{"where": {"access": "acc1"}, "threat": "A flood crowds out real senders.", "result": "finding", "findings": ["f1"], "path": []},
                     {"where": {"access": "acc2"}, "threat": "The loop never ends.", "result": "finding", "findings": ["f2"], "goal": "Not an attacker goal.", "path": []}]}
lf = [{"id": "flood", "ref": "f1", "file": "infra.tf", "line": 1, "impact": "degraded_operation"}, {"id": "loop", "ref": "f2", "file": "fn.py", "line": 2, "impact": "edge_case"}]
lv = reviewers.security_view(loose, lf, hook, None)
assert [f.get("threats") for f in lf] == [["t1"], None], "the flood is what a threat stands on; a defect named as a threat is not"
assert [x["where"] for x in lv["threats"] if x.get("derived") and x["where"].get("access") in ("acc4", "acc5")] == [{"access": "acc4"}, {"access": "acc5"}], "a loosened and a removed guard are to assess"
# A threat at the call names the operator's row at the same place too (the row at what the script reaches).
at_call = {**hook_ans, "access": [*hook_ans["access"][:5], {**hook_ans["access"][5], "node": "policies"}],
           "threats": [{"where": {"from": "tool", "to": "policies"}, "threat": "The operator leaves the policies detached.", "result": "not_assessed", "note": "no time", "path": []}]}
assert not [x for x in reviewers.security_view(at_call, [], hook, None)["threats"] if x.get("derived") and x["where"] == {"access": "acc6"}], "one place, one entry"
as_principal = {**hook_ans, "access": [*hook_ans["access"][:5], {k: v for k, v in {**hook_ans["access"][5], "principal_node": "tool"}.items() if k != "node"}],
                "threats": [{"where": {"access": "acc6"}, "threat": "The operator leaves the policies detached.", "result": "not_assessed", "note": "no time", "path": []}]}
assert not [x for x in reviewers.security_view(as_principal, [], hook, None)["threats"] if x.get("derived") and x["where"].get("edge") == "e5"], "the script named as the principal: its one call is that row"
# A guard without a card gets the card its resource names, else the one card the grants of its kind sit at.
pic_nodes = [{"id": "queue", "label": "LoanEvents (SQS)"}, {"id": "vault", "label": "Secrets"}, {"id": "fn", "label": "hook fn"}]
assert reviewers.guard_node({"resource": "LoanEventsPolicy OnlyTwo", "actions": ["deny x"]}, pic_nodes, []) == "queue"
assert reviewers.guard_node({"resource": "tls", "kind": "secret", "effect": "deny"}, pic_nodes, [{"resource": "p", "kind": "secret", "node": "vault", "actions": ["get"]}]) == "vault"
assert reviewers.guard_node({"resource": "tls", "kind": "bucket", "effect": "deny"}, pic_nodes, []) is None
no_card = {**hook_ans, "access": [*hook_ans["access"][:4], {k: v for k, v in hook_ans["access"][4].items() if k != "node"} | {"resource": "sink-policy", "kind": "store"},
                                  {**hook_ans["access"][1], "kind": "store", "node": "sink"}]}
assert reviewers.security_view(no_card, [], hook, None)["access"][4]["node"] == "sink", "the guard stands at the card of its kind"
assert lv["access"][3]["holds_against"] == "another role publishes" and "holds_against what the rule stops" in reviewers.findings_schema("security")["description"]

# The view lands in the findings file next to the runs; a run without one leaves it.
file = home / "findings" / "123.json"
reviewers.merge(file, "security", "h1", [{"id": "s1", "reviewer": "security"}], {"state": "done"}, {"threats": []})
reviewers.merge(file, "security", "h1", None, {"state": "running"})
doc = json.loads(file.read_text())
assert doc["security"] == {"threats": []} and doc["runs"]["security"] == {"state": "running"} and doc["findings"][0]["head"] == "h1"
# The Codex run: a permission profile instead of Codex's "read-only" sandbox (which reads the whole disk), and nothing
# of the user's or the PR's Codex setup (MCP servers, hooks, plugins, apps, rules, config).
import shutil  # noqa: E402
import subprocess  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    d = os.path.realpath(d)
    g = lambda *a, cwd: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t", *a], cwd=cwd, check=True, capture_output=True,  # noqa: E731
                                    env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})  # no hooks or templates of this machine
    clone, wt, out = f"{d}/clone", f"{d}/clone/.worktrees/review", f"{d}/outside"
    os.makedirs(clone), os.makedirs(out), pathlib.Path(out, "marker.txt").write_text("MARKER\n")
    g("init", "-q", cwd=clone), pathlib.Path(clone, "f.txt").write_text("in the PR\n"), g("add", ".", cwd=clone), g("commit", "-qm", "c", cwd=clone)
    g("worktree", "add", "-q", "--detach", wt, cwd=clone)
    a = reviewers.codex_args({"worktree": wt, "base": "main", "codexModel": "m-1"}, "/bin/echo")
    assert a[:5] == [os.path.realpath("/bin/echo"), "exec", "review", "--base", "origin/main"] and a[-2:] == ["-c", 'model="m-1"'], a
    for flag in ("--ignore-user-config", "--ignore-rules", "--strict-config"):
        assert flag in a, flag
    assert [a[k + 1] for k, x in enumerate(a) if x == "--disable"] == ["hooks", "plugins", "apps"], "no hooks, plugins or connectors"
    sets = [a[k + 1] for k, x in enumerate(a) if x == "-c"]
    assert not [s for s in sets if s.startswith("sandbox_mode")] and 'default_permissions="review"' in sets and 'approval_policy="never"' in sets, sets
    files = next(s for s in sets if s.startswith("permissions.review.filesystem="))
    assert f'"{wt}"="read"' in files and f'"{clone}/.git"="read"' in files and '":slash_tmp"="none"' in files and '"write"' not in files, files
    assert f'"{clone}"=' not in files and f'"{os.path.expanduser("~")}"=' not in files, "neither the clone's other files nor the home folder"
    assert '"inherit"="core"' in next(s for s in sets if s.startswith("shell_environment_policy=")), "the model's commands get no key of Codex's own"
    codex = shutil.which("codex")
    if codex and sys.platform == "darwin":  # Codex's own sandbox with exactly these settings (`codex sandbox`: no model, no login)
        profile = [x for s in sets if s.startswith(("default_permissions", "permissions.", "shell_environment_policy")) for x in ("-c", s)]
        os.makedirs(f"{d}/codex-home")
        script = f"cat f.txt; git log --stat --format=%s | grep -c f.txt; cat '{out}/marker.txt'; ls '{os.environ['HOME']}'; ls '{d}/codex-home'; cat '{clone}/f.txt'; echo x > w.txt; env"
        r = subprocess.run([os.path.realpath(codex), "sandbox", *profile, "--", "/bin/sh", "-c", script], cwd=wt, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=120, env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "CODEX_HOME": f"{d}/codex-home", "LEAK_API_" + "KEY": "k"})
        assert r.stdout.startswith("in the PR\n1\n"), ("the checkout and, through git, the clone's history are readable", r.stdout[:200], r.stderr[:300])
        assert r.stderr.count("not permitted") == 5 and "MARKER" not in r.stdout, ("a file beside the clone, the home folder, Codex's home, the clone's other files, a write", r.stderr)
        assert not os.path.exists(f"{wt}/w.txt") and "LEAK_API_" not in r.stdout and "GIT_CONFIG_GLOBAL=/dev/null" in r.stdout, r.stdout[:300]
print("ok")
