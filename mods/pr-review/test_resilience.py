"""Run: python3 test_resilience.py  (no network, no model): the resilience run's schema, prompt and checks."""
import json
import pathlib
import sys
import tempfile

sys.dont_write_bytecode = True
import resilience  # noqa: E402
import reviewers  # noqa: E402

# The run is a reviewer like the others: its schema asks for the block, the prompt says hints are no limit.
s = reviewers.findings_schema("resilience", "/w")
assert {"paths", "deps", "effects", "state", "races", "blind_spots", "checks", "probes", "not_checked"} <= set(s["required"]) and "ref" in s["properties"]["findings"]["items"]["required"]
plain = reviewers.PLAIN["resilience"].format(base="b", number=2)
for part in ("are hints, not your limit", "unchanged templates and infrastructure", "worst_record_s", "a reader of state another process holds is no race",
             "never advice without a line", "what happens when they run out"):
    assert part in plain, part
assert reviewers.allowed({"kind": "resilience", "worktree": "/w"}) == list(reviewers.review.allowed_rules(reviewers.permissions("/w"))), "the same rights as the other reviewers"
assert reviewers.AREAS["resilience"] == resilience.AREAS and "consistency" in reviewers.review.CATEGORIES

# Hints: the security view and the findings so far, by id.
h = resilience.hints({}, {"zones": [{"name": "Front desk", "trust": "authenticated", "nodes": ["handler"]}], "access": [{"id": "acc1", "resource": "Api", "principal": "anyone", "at": "t.yaml:3"}]},
                     [{"id": "a1", "file": "x.py", "line": 3, "title": "Mailed twice", "reviewer": "analysis"}])
assert "Front desk (authenticated): handler" in h and "acc1 Api for anyone at t.yaml:3" in h and "- a1: x.py:3 Mailed twice (analysis)" in h
assert resilience.hints({}, None, []) == ""

# The answer, checked against the picture and the findings: unknown edges, nodes, enums and ids go; a finding result
# names a finding; mitigated names what limits it; a path's probe exists.
pic = {"architecture": {"nodes": [{"id": "handler"}, {"id": "consumer"}, {"id": "mailer"}], "edges": [{"from": "handler", "to": "consumer"}, {"from": "consumer", "to": "mailer"}]}}
new = [{"id": "n1", "ref": "r_f1", "title": "Batch retried"}]
answer = {
    "deps": [{"edge": "e1", "at": "./library/consumer.py:12", "mode": "async", "retry": {"layer": "platform", "attempts": 3, "exhausted": "explode"},
              "trigger": {"batch": 10, "fn_timeout_s": 10, "worst_record_s": 7, "dlq": False, "retention_s": 345600}, "context": {"kind": "weird"}},
             {"edge": "e9", "at": "x.py:1", "mode": "telepathy"}],
    "effects": [{"id": "mail", "kind": "mail", "at": "library/mailer.py:10", "node": "mailer", "order": "after_commit", "retried_by": ["sqs"], "findings": ["a1", "r_f1", "zz"]},
                {"kind": "no id"}],
    "state": [{"id": "store", "what": "loans", "writers": [{"node": "handler", "at": "a.py:1", "guard": ""}, {"node": "ghost", "at": "b.py:2"}], "readers": [{"node": "consumer", "at": "c.py:3"}]}],
    "races": [{"id": "x1", "shared": "store", "pattern": "check_then_act", "actors": ["a", "b"], "steps": [["a", "reads", "c.py:1"], ["b"], ["b", "writes", "c.py:2", "extra"]], "breaks_at": 1, "findings": []}],
    "blind_spots": [{"id": "b1", "failure": "publish never reaches SQS", "at": "events.py:20", "signal": "none", "alarm": "maybe", "findings": ["a1"]}],
    "paths": [{"id": "anything", "kind": "retry", "trigger": "one record raises", "steps": ["consumer", "e1", "library/consumer.py:12", "nowhere", "e7"], "end": "mails again",
               "result": "finding", "failing": ["unbounded_retry", "no_dlq", "vibes"], "visible": False, "findings": ["r_f1"], "probe": "r1"},
              {"kind": "timeout", "trigger": "t", "steps": [], "end": "e", "result": "finding", "failing": [], "visible": True, "findings": ["nope"]},
              {"kind": "effect", "trigger": "t", "steps": [], "end": "e", "result": "mitigated", "failing": [], "visible": True, "findings": []},
              {"kind": "effect", "trigger": "t", "steps": [], "end": "e", "result": "mitigated", "limited_by": "library/x.py:4", "failing": [], "visible": True, "probe": "r9"}],
    "checks": [{"check": "cors", "result": "clean", "why": "no browser route"}, {"check": "rollback", "result": "nah", "why": "?"}],
    "probes": [{"id": "r1", "claim": "mailer.send: 19 calls for 10 records", "of": "p1", "kind": "redelivery", "strength": "runs_pr_code"}, {"id": "r2", "of": "p2"}],
    "not_checked": ["load under real traffic"]}
v = resilience.view(answer, new, pic, ["a1"])
d = v["deps"]
assert [(x["edge"], x["at"], x["mode"]) for x in d] == [("e1", "library/consumer.py:12", "async"), (None, "x.py:1", None)]
assert d[0]["retry"]["exhausted"] is None and d[0]["context"]["kind"] is None and d[0]["trigger"]["worst_record_s"] == 7
assert v["effects"] == [{"id": "mail", "kind": "mail", "idempotency_key": None, "at": "library/mailer.py:10", "node": "mailer", "order": "after_commit", "retried_by": ["sqs"], "findings": ["a1", "n1"]}]
assert [w["node"] for w in v["state"][0]["writers"]] == ["handler", None] and v["races"][0]["steps"] == [["a", "reads", "c.py:1"], ["b", "writes", "c.py:2"]]
assert v["blind_spots"][0]["alarm"] == "unknown"
p = v["paths"]
assert [(x["id"], x["result"]) for x in p] == [("p1", "finding"), ("p2", "not_assessed"), ("p3", "not_assessed"), ("p4", "mitigated")]
assert p[0]["steps"] == ["consumer", "e1", "library/consumer.py:12"] and p[0]["failing"] == ["unbounded_retry", "no_dlq"] and p[0]["findings"] == ["n1"] and p[0]["probe"] == "r1"
assert p[3]["probe"] is None and p[3]["limited_by"] == "library/x.py:4"
assert [(c["check"], c["result"]) for c in v["checks"]] == [("cors", "clean"), ("rollback", "not_checkable")]
assert [(x["id"], x["status"]) for x in v["probes"]] == [("r1", "proposed")] and v["not_checked"] == ["load under real traffic"]
assert "ref" not in new[0], "the ref is the model's, the id stays"
# A probe id names a file, a branch and a write rule: 1 to 40 letters, digits, - and _. Another one is dropped, and
# not_checked says so; a path's link to it goes too.
bad = ["../x", "a/b", "*", "a b", "", "x" * 41]
w = resilience.view({**answer, "probes": [{"id": b, "claim": "c", "of": "p1", "kind": "race", "strength": "runs_pr_code"} for b in bad] + [{"id": "ok_1-" + "y" * 35, "claim": "c", "of": "p1"}],
                     "paths": [{**answer["paths"][0], "probe": "../x"}]}, new, pic, ["a1"])
assert [x["id"] for x in w["probes"]] == ["ok_1-" + "y" * 35], w["probes"]
assert sum("A probe was dropped" in x for x in w["not_checked"]) == len(bad) and w["paths"][0]["probe"] is None
# The base rule (wave R2, D5): a new finding is the PR's only in lines the diff adds; one whose lines stand unchanged
# in the base was there before, also on a path through a new node; without the diff: unknown (None).
base = [{"id": "m1", "ref": "r_f1", "file": "library/mailer.py", "line": 14, "introduced_here": True},
        {"id": "m2", "ref": "r_f2", "file": "library/consumer.py", "line": 21, "end": 23, "introduced_here": False}]
fresh_pic = {"architecture": {"nodes": [{"id": "consumer", "status": "new", "at": "library/consumer.py:11"}, {"id": "mailer", "status": "unchanged"}], "edges": []}}
resilience.view({"paths": [{"kind": "silent", "steps": ["consumer", "library/mailer.py:14"], "result": "finding", "findings": ["r_f1", "r_f2"], "failing": [], "signal": "none", "seen_as": ""}]},
                base, fresh_pic, [], {"library/consumer.py": {22}})
assert [f["introduced_here"] for f in base] == [False, True], "the old mailer line was there before, whatever the model said; the consumer's added line is the PR's"
unknown = [{"id": "u1", "ref": "r_f1", "file": "a.py", "line": 3}]
resilience.view({}, unknown, {}, [], None)
assert unknown[0]["introduced_here"] is None, "without the diff: old or new unclear"
assert resilience.view({}, [], {}, []) == {"deps": [], "effects": [], "state": [], "races": [], "additions": [], "downstream": [], "db_calls": [], "caches": [], "clocks": [], "blind_spots": [], "paths": [],
                                           "checks": [], "probes": [], "not_checked": []}

# The block lands in the findings file next to the security view; another run keeps it.
file = pathlib.Path(tempfile.mkdtemp()) / "findings" / "1.json"
reviewers.merge(file, "resilience", "h", [], {"state": "done"}, None, {"resilience": {"paths": []}})
reviewers.merge(file, "security", "h", [], {"state": "done"}, {"threats": []})
doc = json.loads(file.read_text())
assert doc["resilience"] == {"paths": []} and doc["security"] == {"threats": []}
# Complexity against use: each part the PR adds, with what it solves and the simpler way; an unjustified one that
# names no finding becomes a low complexity finding (never a blocker), the suggestion to remove it.
adds = resilience.view({"additions": [
    {"what": "Step Function for one call", "kind": "step_function", "at": "template.yaml:40", "solves": "nothing that fails here", "likelihood": "cannot_happen",
     "cost": {"mental": "a state machine to read", "ops": "its own alarms", "money": ""}, "simpler": "call the Lambda directly", "result": "unjustified"},
    {"what": "DLQ", "kind": "dlq", "at": "template.yaml:12", "solves": "the poison message of p1 at consumer.py:14", "likelihood": "likely", "cost": {}, "simpler": "none", "result": "justified"},
    {"what": "Cache", "kind": "cache", "at": "x.py", "solves": "", "likelihood": "often", "cost": {}, "simpler": "", "result": "unjustified"},
    {"kind": "no what"}]}, [], {}, [])["additions"]
assert [(a["what"], a["result"], a["likelihood"]) for a in adds] == [("Step Function for one call", "unjustified", "cannot_happen"), ("DLQ", "justified", "likely"), ("Cache", "unjustified", None)]
made = resilience.complexity_findings(adds, "h1")
assert [(f["file"], f["line"], f["category"], f["impact"], f["severity"], f["title"]) for f in made] == [("template.yaml", 40, "complexity", "maintainability", "low", "Step Function for one call adds a part this PR does not need")]
assert made[0]["suggestion"] == "Remove it: call the Lambda directly." and "It costs: a state machine to read; its own alarms" in made[0]["detail"] and adds[0]["findings"] == [made[0]["id"]]
assert adds[2]["findings"] == [], "without a line no finding"
assert resilience.complexity_findings(adds) == [], "once linked, no second finding"
plain2 = reviewers.PLAIN["resilience"].format(base="b", number=2)
assert "Recommend no mechanism by default" in plain2 and "came in because it sounded right" in plain2 and "additions (one per component" in resilience.ASK and "action (what to do" in resilience.ASK
assert "complexity" in reviewers.review.CATEGORIES
# Wave R2: calls bound to the map (node), what shows a failure (signal, seen_as), what on-call sees in a race, every
# writer of a field with its invariant, the purpose and next step of each added part; and the prompt asks for them.
r2 = resilience.view({"deps": [{"edge": "e1", "node": "consumer", "at": "template.yaml:32", "mode": "async"}, {"node": "ghost", "at": "x.py:1", "mode": "sync"}],
                      "paths": [{"kind": "request", "steps": ["handler"], "result": "not_assessed", "failing": ["dishonest_response"], "signal": "platform_only", "seen_as": "Lambda Errors only"},
                                {"kind": "silent", "steps": [], "result": "not_assessed", "failing": [], "signal": "none", "seen_as": "nothing"},
                                {"kind": "other", "steps": [], "result": "not_assessed", "failing": [], "visible": True}],
                      "races": [{"id": "x1", "shared": "s", "pattern": "lost_update", "actors": [], "steps": [], "breaks_at": 0, "oncall": "a second mail, no error", "possible_today": False, "note": "see p6"}],
                      "state": [{"id": "st", "what": "loan.status", "invariant": "only transition() changes the status", "writers": [{"node": "consumer", "at": "consumer.py:23", "breaks": True}], "readers": []}],
                      "additions": [{"what": "Mailer retry", "kind": "retry", "at": "mailer.py:13", "solves": "", "likelihood": "possible", "cost": {}, "simpler": "", "result": "unjustified",
                                     "purpose": "survive a flaky SMTP", "next": "Drop the mailer retry; the queue redelivers"}]},
                     [], {"architecture": {"nodes": [{"id": "consumer"}, {"id": "handler"}], "edges": [{"from": "h", "to": "c"}, {"from": "q", "to": "consumer"}]}}, [], {})
assert [(d["edge"], d["node"]) for d in r2["deps"]] == [("e1", "consumer"), (None, None)]
assert [(x["kind"], x["signal"], x["visible"], x["seen_as"]) for x in r2["paths"]] == [("request", "platform_only", True, "Lambda Errors only"), ("silent", "none", False, "nothing"), ("other", None, True, "")], \
    "visible follows the signal (only none is silent); an older answer's visible stays"
assert r2["paths"][0]["failing"] == ["dishonest_response"] and (r2["races"][0]["oncall"], r2["races"][0]["possible_today"], r2["races"][0]["note"]) == ("a second mail, no error", False, "see p6")
assert r2["state"][0]["invariant"] == "only transition() changes the status" and r2["state"][0]["writers"][0]["breaks"] is True
assert (r2["additions"][0]["purpose"], r2["additions"][0]["next"]) == ("survive a flaky SMTP", "Drop the mailer retry; the queue redelivers")
# A retry layer under a queue's redelivery is unjustified: the run's "questionable" is overruled, a missing one added.
trig = {"node": "consumer", "at": "template.yaml:31", "mode": "async", "trigger": {"batch": 10}}
under = lambda adds: resilience.view({"deps": [trig, {"node": "consumer", "edge": None, "at": "library/consumer.py:21", "mode": "in_process",
                                                     "retry": {"layer": "mailer", "attempts": 3, "at": "library/mailer.py:13-20"}},
                                               {"node": "handler", "at": "library/handler.py:21", "mode": "in_process", "retry": {"attempts": 3, "at": "library/x.py:1"}}],
                                      "additions": adds}, [], pic, [])["additions"]
got = under([{"what": "Mailer retry loop", "kind": "retry layer", "at": "library/mailer.py:13", "result": "questionable"}])
assert [(a["what"], a["result"], a["next"]) for a in got] == [("Mailer retry loop", "unjustified", "Drop the retry on the queue path; the queue already delivers the message again")], got
got = under([])
assert set(got[0]) >= {"works_today", "broken_by", "purpose", "next"}, "an added part has every field a run's part has"
assert [(a["what"], a["at"], a["result"], a["derived"]) for a in got] == [("mailer retry under the queue's redelivery", "library/mailer.py:13", "unjustified", True)], \
    "added when the run left it out; the handler's retry has no queue under it"
assert resilience.complexity_findings(got)[0]["file"] == "library/mailer.py" and got[0]["findings"]
# A failure that raises out of a function is at least platform_only; none stays for a swallow, a false 2xx, a missing call.
sig = lambda **p: resilience.signal_of(p)  # noqa: E731
assert [sig(raises=True, signal="none", seen_as="Nothing")["signal"], sig(failing=["poison_message"], signal="none")["signal"], sig(raises=True, signal="alarm")["signal"],
        sig(raises=False, failing=["swallowed_retry"], signal="none")["signal"], sig(failing=["dishonest_response"], signal="none")["visible"]] == ["platform_only", "platform_only", "alarm", "none", False]
up = sig(raises=True, signal="none", seen_as="Nothing")
assert (up["signal_said"], up["visible"], up["seen_as"].startswith("The function's error metric")) == ("none", True, True), up
assert "signal_said" not in sig(raises=True, signal="log")
# A part is judged by its purpose; a bug that keeps it from working today is works_today and broken_by.
q = resilience.view({"additions": [{"what": "LoanEvents queue", "kind": "queue", "result": "justified", "works_today": False, "broken_by": "nothing publishes"}]}, [], pic, [])["additions"][0]
assert (q["result"], q["works_today"], q["broken_by"]) == ("justified", False, "nothing publishes")
_pt = resilience.view({"paths": [{"kind": "effect", "steps": ["queue"], "result": "not_assessed", "possible_today": False, "note": "see p4"}, {"kind": "effect", "steps": [], "result": "not_assessed"}]}, [], pic, [])["paths"]
assert [x["possible_today"] for x in _pt] == [False, None]
sch = reviewers.findings_schema("resilience")
assert "node" in sch["properties"]["deps"]["items"]["required"] and {"signal", "seen_as"} <= set(sch["properties"]["paths"]["items"]["required"])
pr2 = reviewers.PLAIN["resilience"].format(base="b", number=2)
for part in ("every public route's request, always", "answers 202 while the mail is lost", "per field or row that two or more places write", "a retry layer under another one",
             "measured by its purpose, not by a bug in it"):
    assert part in pr2, part
for part in ("possible_today (false when the path cannot happen until", "raises (true when the failure ends in an exception", "never result)", "never cannot_happen because of a bug in the part", "for a queue trigger the consumer", "only when a protection stands behind it", "not possible today, see p4", "seen_as (one sentence", "oncall (one sentence", "next (one sentence with a verb"):
    assert part in resilience.ASK, part
# Seconds for the timing picture (timeline.js): the pauses as a list of numbers and one attempt's own timeout; a word,
# a negative or a guess-shaped value is left out (not stated), never turned into 0.
_secs = lambda retry: resilience.view({"deps": [{"at": "x.py:1", "mode": "sync", "node": "handler", "retry": {"attempts": 3, **retry}}]}, [], pic, [])["deps"][0]["retry"]  # noqa: E731
assert (_secs({"backoff_s": [1, 2, 4], "attempt_s": 0.5})["backoff_s"], _secs({"backoff_s": [1, 2, 4], "attempt_s": 0.5})["attempt_s"]) == ([1, 2, 4], 0.5)
assert all("backoff_s" not in _secs({"backoff_s": bad}) for bad in ("1, 2, 4", [1, "2"], [1, -2], None, [True])) and _secs({"backoff_s": []})["backoff_s"] == []
assert all("attempt_s" not in _secs({"attempt_s": bad}) for bad in (0, -1, "3", None, True))
assert {"attempt_s", "backoff_s"} <= set(sch["properties"]["deps"]["items"]["properties"]["retry"]["properties"])
assert "backoff_s (the pauses in seconds in their order" in resilience.ASK and "never a guess" in resilience.ASK
# Dependencies that fail or are overloaded: per dependency a case for each way it fails, once, in the order slow,
# overloaded, down, bad answer, recovers. A decided case names its line (else it is not checkable); its path is one of
# this run's, by the id the path got here; unknown nodes, edges, kinds and findings go; no dependency without a case.
dn = resilience.view({"paths": [{"id": "px", "kind": "request", "steps": ["handler"], "result": "not_assessed"}, {"id": "p9", "kind": "request", "steps": ["handler"], "result": "finding", "findings": ["a1"]}],
                      "downstream": [
    {"dep": "Mailer", "kind": "external", "node": "mailer", "edge": "e1", "at": "./library/mailer.py:14", "mode": "sync", "entry": "POST /remind", "cases": [
        {"when": "down", "at": "library/mailer.py:19", "handled": "no", "how": "3 tries, then drops the mail", "effect": "The mail is lost.", "path": "p9", "findings": ["zz"]},
        {"when": "slow", "at": "library/mailer.py:16", "handled": "no", "how": "waits up to 7 s of the 10 s request", "path": "p1"},
        {"when": "bad_answer", "at": "library/mailer.py:16", "handled": "partly", "how": "checks None only", "path": "px", "findings": ["a1"]},
        {"when": "slow", "at": "x.py:1", "handled": "yes", "how": "a second word"},
        {"when": "overloaded", "handled": "yes", "how": "backs off"},
        {"when": "recovers", "at": "library/mailer.py:14", "handled": "maybe", "how": ""},
        {"when": "on fire", "handled": "no"}, "junk"]},
    {"dep": "Token store", "kind": "vault", "node": "ghost", "edge": "e9", "at": "h.py:9", "mode": "telepathy", "cases": [{"when": "bad_answer", "at": "h.py:9", "handled": "yes", "how": "checks None"}]},
    {"dep": "No cases", "kind": "cache", "at": "c.py:1", "mode": "sync", "cases": []},
    {"dep": "LoanStore (in-memory)", "kind": "internal", "node": "handler", "at": "library/consumer.py:19", "mode": "in_process", "cases": [{"when": "down", "at": "library/consumer.py:19", "handled": "yes", "how": "a dict"}]}, {"kind": "queue", "cases": [{"when": "down", "handled": "no", "at": "q.py:1"}]}]}, [], pic, ["a1"])["downstream"]
assert [(d["dep"], d["kind"], d["node"], d["edge"], d["at"], d["mode"]) for d in dn] == [("Mailer", "external", "mailer", "e1", "library/mailer.py:14", "sync"), ("Token store", "other", None, None, "h.py:9", None)]
assert [(c["when"], c["handled"], c["at"], c["path"]) for c in dn[0]["cases"]] == [("slow", "not_checkable", "library/mailer.py:16", None), ("overloaded", "not_checkable", None, None),
                                                                                  ("down", "no", "library/mailer.py:19", "p2"), ("bad_answer", "partly", "library/mailer.py:16", "p1"),
                                                                                  ("recovers", "not_checkable", "library/mailer.py:14", None)], dn[0]["cases"]
# slow: no finding and no path shows it; down: its path's finding does; bad answer: its own finding does
assert (dn[0]["entry"], dn[1]["entry"]) == ("POST /remind", "") and dn[0]["cases"][2]["findings"] == [] and dn[0]["cases"][2]["effect"] == "The mail is lost." and dn[1]["cases"][0]["handled"] == "yes"
assert "downstream" in sch["required"] and "node" in sch["properties"]["downstream"]["items"]["required"] and sch["properties"]["downstream"]["items"]["properties"]["cases"]["items"]["properties"]["when"]["enum"] == resilience.WHENS
assert "downstream" in resilience.PROBE_KINDS and "dependencies" in resilience.AREAS and {"no_backoff", "thundering_herd", "unchecked_answer", "backpressure"} <= set(resilience.FAILING)
for part in ("State the same process holds", "dependencies that fail or are overloaded", "who waits how long at which line", "retries at once, retries on several layers", "A circuit breaker is no default answer",
             "whether the system gets back by itself", "what only a measurement can tell", "separately for each way in that reaches it"):
    assert part in pr2, part
for part in ("downstream (one per dependency the PR starts to use or uses differently", "cases (one for each of slow, overloaded, down, bad_answer, recovers", "kind downstream: a stub plays the dependency"):
    assert part in resilience.ASK, part
print("ok")
