"""The resilience run of the review layout (reviewers.py kind "resilience"): how a failure spreads through the PR's
code: timeouts, retries, redelivery, repeated or lost effects, shared state and races, load and coupling, database
volume, caches, clocks, what on-call would see, and how it runs in production. The model gives facts with file:line;
pr.js (withResilience) computes the ladders, budgets and blockers from them.

The architecture picture, the security view and the findings so far are hints for the run, not its limit: it reads
the code itself, also unchanged templates and infrastructure the PR reaches. It refers to an existing finding by its
id and writes a new finding only for what is new. view() checks the answer against the picture and the findings and
returns the block `resilience` of the findings file. Standard library only.
"""
import re

import review

S, STRINGS, INT, BOOL = review.S, review.STRINGS, {"type": "integer"}, {"type": "boolean"}
NUM = {"type": "number"}
AREAS = ["retries", "timeouts", "redelivery", "effects", "state", "races", "load", "db", "caches", "clocks", "observability", "operations"]
MODES = ["sync", "async", "in_process"]
EXHAUSTED = ["raise", "dlq", "swallowed"]
CONTEXT_KINDS = ["trace", "id_only", "inherited", "none", "broken"]
ORDERS = ["before_commit", "after_commit", "outbox", "none"]
INVALIDATE = ["before_write", "after_commit", "ttl_only", "none"]
SIGNALS = ["alarm", "log", "metric", "dlq", "platform_only", "none"]
ALARMS = ["in_repo", "elsewhere", "none", "unknown"]
RESULTS = ["finding", "mitigated", "not_assessed"]
CHECK_RESULTS = ["finding", "clean", "not_checkable", "elsewhere"]
PATH_KINDS = ["retry", "timeout", "race", "state", "effect", "load", "silent", "request", "other"]
ADD_RESULTS = ["justified", "questionable", "unjustified"]
LIKELIHOOD = ["likely", "possible", "rare", "cannot_happen"]
PROBE_KINDS = ["retry", "redelivery", "race", "idempotency", "clock", "db_count", "telemetry", "budget"]
PROBE_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")  # a probe id: a file name, a branch, a write rule (threads.js PROBE_ID, probe.py ID)
STRENGTHS = ["runs_pr_code", "forced_schedule", "models_env"]
# What a path breaks, in the words pr.js turns into a blocker's reason (pr.js RES_BLOCKING).
FAILING = ["unbounded_retry", "no_dlq", "poison_message", "over_timeout", "duplicate_effect", "lost_effect", "swallowed_retry",
           "shared_resource", "no_timeout_public", "silent", "removed_signal", "reads_foreign_state", "race", "no_jitter", "no_alarm",
           "no_breaker", "no_trace", "cardinality", "n_plus_one", "unbounded_queue", "no_throttle", "stale_cache", "clock", "dishonest_response"]
# What a function raises out of itself: its platform's error metric shows it (Lambda Errors), whatever else is silent.
RAISING = {"poison_message", "over_timeout", "no_dlq"}
FINDS = {"findings": {**STRINGS, "description": "ids of findings that show it: an existing finding's id from the list, or the ref of a new one"}}
AT = {**S, "description": "file:line"}

SCHEMA = {
    "deps": {"type": "array", "items": {"type": "object", "required": ["at", "mode", "node"], "properties": {
        "edge": S, "node": S, "at": AT, "mode": {"enum": MODES},
        "timeout": {"type": "object", "properties": {"s": NUM, "source": S}},
        "retry": {"type": "object", "properties": {"layer": S, "attempts": INT, "backoff": S, "jitter": BOOL, "on": S, "exhausted": {"enum": EXHAUSTED}, "at": AT}},
        "trigger": {"type": "object", "properties": {"batch": INT, "partial_batch": BOOL, "fn_timeout_s": NUM, "visibility_s": NUM, "retention_s": NUM,
                                                     "dlq": BOOL, "max_receive": INT, "worst_record_s": NUM}},
        "request_path": BOOL, "entry": S, "throttle": S,
        "context": {"type": "object", "properties": {"carrier": S, "kind": {"enum": CONTEXT_KINDS}, "missing": S, "receiver_logs": BOOL, "at": AT}}}}},
    "effects": {"type": "array", "items": {"type": "object", "required": ["id", "kind", "at", "order"], "properties": {
        "id": S, "kind": S, "at": AT, "node": S, "order": {"enum": ORDERS}, "idempotency_key": S, "retried_by": STRINGS, **FINDS}}},
    "state": {"type": "array", "items": {"type": "object", "required": ["id", "what", "writers", "readers"], "properties": {
        "id": S, "what": S, "store": S, "invariant": S, "writers": {"type": "array", "items": {"type": "object", "required": ["at"], "properties": {"node": S, "at": AT, "guard": S, "breaks": BOOL}}},
        "readers": {"type": "array", "items": {"type": "object", "properties": {"node": S, "at": AT}}}, "shared_across_process": BOOL, "isolation": S, "note": S}}},
    "races": {"type": "array", "items": {"type": "object", "required": ["id", "shared", "pattern", "actors", "steps", "breaks_at"], "properties": {
        "id": S, "shared": S, "pattern": S, "actors": STRINGS, "steps": {"type": "array", "items": {"type": "array", "items": S}}, "breaks_at": INT,
        "oncall": S, "possible_today": BOOL, "note": S, "needs": S, **FINDS}}},
    "db_calls": {"type": "array", "items": {"type": "object", "required": ["entry", "calls"], "properties": {
        "entry": S, "calls": {"type": "array", "items": {"type": "object", "properties": {"op": S, "target": S, "at": AT, "in_loop": BOOL}}}, "per_request": S}}},
    "caches": {"type": "array", "items": {"type": "object", "required": ["key", "at", "invalidate"], "properties": {
        "key": S, "at": AT, "invalidate": {"enum": INVALIDATE}, "read_your_writes": BOOL, "headers": S}}},
    "clocks": {"type": "array", "items": {"type": "object", "required": ["kind", "at", "effect"], "properties": {"kind": S, "at": AT, "effect": S, **FINDS}}},
    "blind_spots": {"type": "array", "items": {"type": "object", "required": ["id", "failure", "at", "signal", "alarm"], "properties": {
        "id": S, "failure": S, "at": AT, "signal": {"enum": SIGNALS}, "alarm": {"enum": ALARMS}, **FINDS}}},
    "paths": {"type": "array", "items": {"type": "object", "required": ["id", "kind", "trigger", "steps", "end", "result", "failing", "raises", "signal", "seen_as"], "properties": {
        "id": S, "kind": {"enum": PATH_KINDS}, "trigger": S, "steps": STRINGS, "end": S, "result": {"enum": RESULTS}, "limited_by": AT,
        "failing": {"type": "array", "items": {"enum": FAILING}}, "raises": BOOL, "possible_today": BOOL, "signal": {"enum": SIGNALS}, "seen_as": S, **FINDS, "probe": S, "note": S, "action": S}}},
    "checks": {"type": "array", "items": {"type": "object", "required": ["check", "result", "why"], "properties": {
        "check": S, "result": {"enum": CHECK_RESULTS}, "at": AT, "why": S, **FINDS}}},
    "additions": {"type": "array", "items": {"type": "object", "required": ["what", "kind", "at", "solves", "likelihood", "cost", "simpler", "result"], "properties": {
        "what": S, "kind": S, "at": AT, "solves": S, "likelihood": {"enum": LIKELIHOOD}, "cost": {"type": "object", "properties": {"mental": S, "ops": S, "money": S}},
        "simpler": S, "result": {"enum": ADD_RESULTS}, "purpose": S, "works_today": BOOL, "broken_by": S, "next": S, **FINDS}}},
    "probes": {"type": "array", "items": {"type": "object", "required": ["id", "claim", "of", "kind", "strength"], "properties": {
        "id": S, "claim": S, "of": S, "kind": {"enum": PROBE_KINDS}, "strength": {"enum": STRENGTHS}}}},
    "not_checked": STRINGS}

STEPS = (
    " This is a resilience review: how a failure spreads through this change, from what triggers it, along which calls, "
    "to where it ends (a repeated or lost effect, load without a limit, a request that hangs, a failure nobody sees). "
    "The architecture picture, the security view and the findings below are hints, not your limit: read the code "
    "yourself, also unchanged templates and infrastructure code the PR reaches, and name places that no picture shows "
    "(as file:line). Work in three steps. 1. Context: each way in (route, queue or event consumer, schedule, script), each "
    "call it makes (sync, async through a queue or event, or in one process) and each effect (mail, payment, insert, "
    "publish, external call). 2. Check every changed place and what it reaches:\n"
    "- calls: per call sync, async or in process; its timeout (where, how long, a library default); whether it fails fast;\n"
    "- budget: a caller's timeout against attempts times the callee's timeout plus backoff; a batch's worst run (batch "
    "size times the longest one record can take, worst_record_s) against the function timeout; visibility at least six "
    "times the function timeout;\n"
    "- retries: each layer (client, SDK, platform, batch, scheduler, stream), attempts, backoff, jitter, on which errors, "
    "and what happens when they run out (raise, dead-letter queue, silently swallowed); also retries the PR adds itself;\n"
    "- redelivery: dead-letter queue and maxReceiveCount, partial batch responses, retention;\n"
    "- effects: who repeats each effect, its idempotency key, its order to the commit (before, after, outbox), dual writes;\n"
    "- state: writers and readers of each state, across processes or not, the guard (conditional write, lock, version, "
    "unique key), check-then-act, a transaction around a network call; a race only on state that is really shared (one "
    "process, or shared_across_process); a reader of state another process holds is no race;\n"
    "- load and coupling: shared pools and concurrency, unbounded queues, buffers or fan-out, a public route without a "
    "throttle, depth of synchronous chains, a database shared across deployments, growth without a TTL or cleanup;\n"
    "- database volume: calls per request, N+1, calls inside retry loops, pool size against max connections;\n"
    "- caches: invalidation after a write, read-your-writes, Cache-Control on new routes, CORS;\n"
    "- clocks: equality on a date or window, state derived from the clock, local time, order from timestamps of "
    "different hosts, a TTL shorter than the work;\n"
    "- what on-call sees: an error path with no signal or alarm; context (correlation id, traceparent, event id) across "
    "every call, especially async ones; effects logged with their id; metric cardinality; alarms in the infrastructure "
    "code, or clearly central (elsewhere: no finding);\n"
    "- operations: rollback (migrations both ways, a flag), health and readiness, graceful shutdown, limits and quotas, "
    "new single points of failure, defaults that only bite under load.\n"
    "- every public route's request, always: each synchronous call it makes, the time the request can spend in them "
    "against its timeout, its throttle, and whether its answer is honest (a 2xx only when the work really happened or "
    "is safely queued); one path of kind request for each synchronous dependency in such a request, e.g. a route that "
    "calls a consumer in its own process, waits out a mail retry and answers 202 while the mail is lost;\n"
    "- shared state, per field or row that two or more places write: every writer with its line, also writers outside "
    "the diff, and the rule it should keep (invariant, e.g. \"only transition() changes the status\"), marking the "
    "writers that break it;\n"
    "- what the PR adds: every component or mechanism it brings in (queue, dead-letter queue, step function, retry "
    "layer, breaker, bulkhead, cache, scheduler, new service or library, a new route, a shortcut past an existing "
    "path such as a route that calls a consumer directly), each measured by its purpose, not by a bug in it (a queue "
    "nothing publishes to is a finding, not a question of its use; judge result as if its findings were fixed, and put "
    "what is broken today into findings and next); a retry layer under another one (a client retry "
    "under a queue's redelivery) is unjustified: what failure it solves at which line, how "
    "likely and how grave that failure is here, what it costs (parts, states and places to look; alarms, redrives, "
    "deploys; money, latency), the simpler alternative (a direct call instead of a step function, synchronous instead of "
    "a queue, no retry because the caller already retries) and what that would lose, and whether it fits the problem "
    "or came in because it sounded right (not asked by the task, not usual in the repo, tied to no failing path).\n"
    "Recommend no mechanism by default: suggest adding one only for a failing path of this PR that without it loses, "
    "repeats or endlessly grows a visible effect; otherwise prefer to simplify.\n"
    "3. Answer with facts at their file:line, never advice without a line (\"add a circuit breaker\") and never claims about "
    "runtime you cannot read in the code; what can only be measured goes to blind_spots. Leave out what you could not "
    "confirm and say so in not_checked.")

ASK = (
    " Answer with: findings (only new problems; one already in the list is named by its id in the parts below, not "
    "written again; each new one with ref r_f1, r_f2, …; category availability, consistency, observability, performance "
    "or another of the list; impact as always). deps (one per call: edge (the picture's e<k> of this call; for a queue trigger the edge from the queue to its consumer), "
    "node (the picture's node that makes the call; for a queue trigger the consumer), at, mode, timeout {s, source}, retry {layer, attempts, backoff, jitter, on, exhausted, at}, trigger for a consumer "
    "{batch, partial_batch, fn_timeout_s, visibility_s, retention_s, dlq, max_receive, worst_record_s}, request_path, "
    "entry, throttle, context {carrier, kind, missing, receiver_logs, at}); effects; state; races (steps as [actor, text, "
    "file:line], breaks_at the index of the step that breaks, oncall (one sentence: what on-call sees while it happens), "
    "possible_today (false when something else keeps it from happening today, with note naming that path)); state (per "
    "written field or row: what, store, invariant, writers [{node, at, guard, breaks}], readers); db_calls; caches; clocks; blind_spots; paths (one for each "
    "distinct way a failure spreads, not only the first you find: go through every way in, every effect and every finding "
    "in the list about availability, consistency, effects or missing signals, and give each its own path, also one that "
    "a limit stops (mitigated) or that you could not assess; a change that adds a queue usually has several; p1, p2, …: "
    "kind, trigger, steps (node ids, edge ids e<k> or file:line, in order), end, result (finding: a finding shows it; "
    "mitigated: only when a protection stands behind it (a dead-letter queue, a limit, a guard, a timeout) and limited_by "
    "names its file:line; not_assessed), possible_today (false when the path cannot happen until something this PR "
    "leaves undone is done, e.g. nothing publishes to the queue yet; result stays what the code shows, and note names "
    "what is missing, e.g. \"not possible today, see p4\"), failing (what it breaks, from: "
    + ", ".join(FAILING) + "), raises (true when the failure ends in an exception or timeout that leaves a function "
    "unhandled: the platform counts it as an error), signal (what shows the failure: alarm, log at warning or above, "
    "metric, dlq, platform_only for the platform's own error metrics of a function that raises, none only when nothing "
    "raises and nothing logs: a swallowed error, a success answer despite the loss, a call that never happens), seen_as (one sentence: what "
    "on-call sees, e.g. \"Lambda Errors on the consumer, no message\"), findings, probe (the id of a probe that would show "
    "it), note, action (what to do about it as one sentence starting with a verb, e.g. \"Decouple: add a dead-letter queue "
    "with maxReceiveCount\", only for this path's failure)); additions (one per component or mechanism the PR adds: what, "
    "kind, at, solves (the failure it solves in production once the PR works as intended, with its line), likelihood (of "
    "that failure: likely, possible, rare, cannot_happen; never cannot_happen because of a bug in the part), works_today "
    "(false when a bug keeps it from working, e.g. nothing publishes to the queue), broken_by (that bug, one sentence), cost "
    "{mental, ops, money}, simpler (the simpler alternative and what it would lose), result (justified: it solves a "
    "failing path of this PR; questionable: small use against its cost; unjustified: it solves nothing that can happen "
    "here, or it is a retry layer under another one; a bug that keeps it from working changes works_today, never result), purpose (what it is for, one sentence), next (one sentence with a "
    "verb: keep, drop or change it, together with what its findings ask, e.g. \"Keep the queue, add a dead-letter queue, "
    "drop the mailer retry\"), findings); checks (one row for each of cors, cache_control, rollback, limits, cardinality, clocks, health, shutdown, "
    "and any other check you made beyond the paths: result finding|clean|not_checkable|elsewhere, at, why); probes (r1, r2, …: a small "
    "script that would show a claim with stubs and a forced schedule, never sleep: claim (one sentence with the number "
    "it would show), of (a path, race, effect or blind spot id), kind, strength); not_checked. Every list may be empty.")


def hints(pic, security, findings):
    """The security view and the findings so far as hints for the prompt (the picture comes from reviewers.picture_text)."""
    out = []
    if security:
        z = "; ".join(f"{x.get('name')} ({x.get('trust')}): {', '.join(x.get('nodes') or [])}" for x in security.get("zones") or [])
        a = "; ".join(f"{r.get('id')} {r.get('resource')} for {r.get('principal')} at {r.get('at')}" for r in security.get("access") or [])
        out.append("Security view (hints): zones: " + (z or "none") + ". Ways in and rights: " + (a or "none") + ".")
    if findings:
        out.append("Findings so far (refer to them by id):\n" + "\n".join(f"- {f['id']}: {f.get('file')}:{f.get('line')} {f.get('title')} ({f.get('reviewer')})" for f in findings[:60]))
    return ("\n\n" + "\n\n".join(out)) if out else ""


def view(answer, findings, pic, known, changed=None):
    """The run's answer as the block `resilience`, checked: enums kept only when known (else dropped), a path's steps
    only the picture's node and edge ids or a file:line, edges only the picture's, findings only known ids or refs of
    this run's new findings (mapped to their ids), probes linked from paths only when they exist. A new finding on a
    finding is introduced_here only in lines the diff adds, else it was there before (the base rule wins over the
    model's word; changed: {path: added lines}; None: unknown). findings: this run's new findings (normalized, with ref); known: ids of findings already
    there. Pure but for popping each ref and setting introduced_here."""
    arch = pic.get("architecture") or {}
    nodes = {n.get("id") for n in arch.get("nodes") or []}
    edges = {f"e{k}" for k in range(len(arch.get("edges") or []))}
    refs = {f.pop("ref"): f["id"] for f in findings if f.get("ref")}
    ids = set(known) | {f["id"] for f in findings}
    fids = lambda xs: [refs.get(x, x) for x in dict.fromkeys(xs or []) if refs.get(x, x) in ids]  # noqa: E731
    at = lambda x: str(x or "").strip().removeprefix("./")  # noqa: E731
    enum = lambda v, allowed: v if v in allowed else None  # noqa: E731
    step = lambda s: s if s in nodes or s in edges or (":" in str(s) and str(s).rsplit(":", 1)[-1].isdigit()) else None  # noqa: E731
    lst = lambda k: [x for x in answer.get(k) or [] if isinstance(x, dict)]  # noqa: E731

    deps = []
    for d in lst("deps"):
        row = {"edge": d.get("edge") if d.get("edge") in edges else None, "node": d.get("node") if d.get("node") in nodes else None, "at": at(d.get("at")),
               "mode": enum(d.get("mode"), MODES)}
        for k in ("timeout", "retry", "trigger", "context"):
            if isinstance(d.get(k), dict):
                row[k] = dict(d[k])
        if "retry" in row:
            row["retry"]["exhausted"] = enum(row["retry"].get("exhausted"), EXHAUSTED)
        if "context" in row:
            row["context"]["kind"] = enum(row["context"].get("kind"), CONTEXT_KINDS)
        deps.append({**row, **{k: d[k] for k in ("request_path", "entry", "throttle") if k in d}})
    effects = [{**{k: e.get(k) for k in ("id", "kind", "idempotency_key")}, "at": at(e.get("at")), "node": e.get("node") if e.get("node") in nodes else None,
                "order": enum(e.get("order"), ORDERS), "retried_by": [str(x) for x in e.get("retried_by") or []], "findings": fids(e.get("findings"))}
               for e in lst("effects") if e.get("id")]
    state = [{**{k: s.get(k) for k in ("id", "what", "store", "isolation", "note")}, "invariant": str(s.get("invariant") or ""), "shared_across_process": bool(s.get("shared_across_process")),
              "writers": [{"node": w.get("node") if w.get("node") in nodes else None, "at": at(w.get("at")), "guard": w.get("guard") or "", "breaks": bool(w.get("breaks"))}
                          for w in s.get("writers") or [] if isinstance(w, dict)],
              "readers": [{"node": w.get("node") if w.get("node") in nodes else None, "at": at(w.get("at"))} for w in s.get("readers") or [] if isinstance(w, dict)]}
             for s in lst("state") if s.get("id")]
    races = [{**{k: r.get(k) for k in ("id", "shared", "pattern", "needs")}, "actors": [str(x) for x in r.get("actors") or []],
              "steps": [[str(x) for x in s][:3] for s in r.get("steps") or [] if isinstance(s, list) and len(s) >= 2][:6],
              "breaks_at": r.get("breaks_at") if isinstance(r.get("breaks_at"), int) else None, "findings": fids(r.get("findings")),
              "oncall": str(r.get("oncall") or ""), "possible_today": r.get("possible_today") if isinstance(r.get("possible_today"), bool) else None, "note": str(r.get("note") or "")}
             for r in lst("races") if r.get("id")]
    # A probe's id names a file, a branch and a write rule of its agent: only letters, digits, - and _ (1 to 40), the
    # same rule as threads.js PROBE_ID and probe.py ID. Another id is dropped, and not_checked says so.
    bad = [p for p in lst("probes") if p.get("claim") and not PROBE_ID.fullmatch(str(p.get("id") or ""))]
    probes = [{**{k: p.get(k) for k in ("id", "claim", "of")}, "kind": enum(p.get("kind"), PROBE_KINDS), "strength": enum(p.get("strength"), STRENGTHS), "status": "proposed"}
              for p in lst("probes") if p.get("claim") and PROBE_ID.fullmatch(str(p.get("id") or ""))]
    probe_ids = {p["id"] for p in probes}
    paths = []
    for k, p in enumerate(lst("paths"), 1):
        result = p.get("result") if p.get("result") in RESULTS else "not_assessed"
        found = fids(p.get("findings"))
        if result == "finding" and not found:
            result = "not_assessed"  # a finding result names its finding
        if result == "mitigated" and not at(p.get("limited_by")):
            result = "not_assessed"  # mitigated names what limits it
        paths.append({"id": f"p{k}", "kind": enum(p.get("kind"), PATH_KINDS) or "other", "trigger": str(p.get("trigger") or ""),
                      "steps": [s for s in (step(x) for x in p.get("steps") or []) if s], "end": str(p.get("end") or ""), "result": result,
                      "limited_by": at(p.get("limited_by")) or None, "failing": [x for x in dict.fromkeys(p.get("failing") or []) if x in FAILING],
                      # signal (what shows the failure) and seen_as; visible is kept for older readers: anything but none
                      **signal_of(p), "findings": found, "probe": p.get("probe") if p.get("probe") in probe_ids else None, "note": str(p.get("note") or ""),
                      "action": str(p.get("action") or ""), "possible_today": p.get("possible_today") if isinstance(p.get("possible_today"), bool) else None})
    # The base rule: a new finding is the PR's only when its lines are lines the diff adds; a flaw whose lines stand
    # unchanged in the base was there before (the one-day window in reminders.py on the demo's base); without the diff
    # it is unknown (None: "old or new unclear").
    for f in findings:
        line, end = int(f.get("line") or 0), int(f.get("end") or f.get("line") or 0)
        f["introduced_here"] = None if changed is None else bool(line and any(line <= n <= max(line, end) for n in changed.get(str(f.get("file") or "").removeprefix("./"), ())))
    additions = [{"what": str(a.get("what") or ""), "kind": str(a.get("kind") or ""), "at": at(a.get("at")), "solves": str(a.get("solves") or ""),
                  "likelihood": enum(a.get("likelihood"), LIKELIHOOD), "cost": {k: str((a.get("cost") or {}).get(k) or "") for k in ("mental", "ops", "money")},
                  "simpler": str(a.get("simpler") or ""), "result": enum(a.get("result"), ADD_RESULTS) or "questionable", "findings": fids(a.get("findings")),
                  "purpose": str(a.get("purpose") or ""), "next": str(a.get("next") or ""),
                  "works_today": a.get("works_today") if isinstance(a.get("works_today"), bool) else None, "broken_by": str(a.get("broken_by") or "")}
                 for a in lst("additions") if a.get("what")]
    retry_under_redelivery(deps, additions)
    return {"deps": deps, "effects": effects, "state": state, "races": races, "additions": additions,
            "db_calls": [{"entry": str(d.get("entry") or ""), "per_request": str(d.get("per_request") or ""),
                          "calls": [{"op": c.get("op"), "target": c.get("target"), "at": at(c.get("at")), "in_loop": bool(c.get("in_loop"))} for c in d.get("calls") or [] if isinstance(c, dict)]}
                         for d in lst("db_calls")],
            "caches": [{"key": c.get("key"), "at": at(c.get("at")), "invalidate": enum(c.get("invalidate"), INVALIDATE), "read_your_writes": c.get("read_your_writes"),
                        "headers": c.get("headers")} for c in lst("caches")],
            "clocks": [{"kind": c.get("kind"), "at": at(c.get("at")), "effect": c.get("effect"), "findings": fids(c.get("findings"))} for c in lst("clocks")],
            "blind_spots": [{"id": b.get("id"), "failure": b.get("failure"), "at": at(b.get("at")), "signal": enum(b.get("signal"), SIGNALS),
                             "alarm": enum(b.get("alarm"), ALARMS) or "unknown", "findings": fids(b.get("findings"))} for b in lst("blind_spots") if b.get("id")],
            "paths": paths,
            "checks": [{"check": str(c.get("check") or ""), "result": enum(c.get("result"), CHECK_RESULTS) or "not_checkable", "at": at(c.get("at")) or None,
                        "why": str(c.get("why") or ""), "findings": fids(c.get("findings"))} for c in lst("checks") if c.get("check")],
            "probes": probes, "not_checked": [str(x) for x in answer.get("not_checked") or []]
            + [f"A probe was dropped: its id {str(p.get('id') or '')[:40]!r} is not 1 to 40 letters, digits, - or _." for p in bad]}


def signal_of(p):
    """A path's signal, seen_as and visible (kept for older readers: anything but none). A failure that raises out of a
    function (raises, or what it breaks raises: a poison message, a batch over its timeout) is at least platform_only,
    whatever the run says: the platform counts the error. none stays for a swallowed error, a success answer despite
    the loss, a call that never happens. signal_said: the run's own word when the rule changed it."""
    said = p.get("signal") if p.get("signal") in SIGNALS else None
    raises = p.get("raises") is True or bool(RAISING & set(p.get("failing") or []))
    out = {"raises": raises, "signal": said, "seen_as": str(p.get("seen_as") or "")}
    if raises and said in (None, "none"):
        out.update(signal="platform_only", signal_said=said, seen_as="The function's error metric counts it; nothing else says what failed.")
    out["visible"] = out["signal"] not in (None, "none") if out["signal"] or not isinstance(p.get("visible"), bool) else p["visible"]
    return out


def retry_under_redelivery(deps, additions):
    """A retry layer under a queue's redelivery is unjustified: a call that retries inside a consumer whose queue
    delivers the whole message again (the mailer's three attempts under SQS). The run's word on such an addition is
    overruled; one the run left out is added (derived). Changes additions in place."""
    queues = {d["node"] for d in deps if d.get("trigger") and d.get("mode") == "async" and d.get("node")}
    for d in deps:
        r = d.get("retry") or {}
        if d.get("node") not in queues or not str(r.get("attempts") or "").isdigit() or int(r["attempts"]) < 2:
            continue
        where = str(r.get("at") or d["at"]); loop = where.split(":")[0]
        line = re.match(r"\d+", where.rpartition(":")[2]) if ":" in where else None
        a = next((a for a in additions if "retry" in a["kind"].lower() and a["at"].split(":")[0] in (loop, "")), None)
        if a is None:
            a = {"what": f"{r.get('layer') or 'client'} retry under the queue's redelivery", "kind": "retry layer", "at": f"{loop}:{line[0]}" if line else loop,
                 "solves": "", "likelihood": None, "cost": {"mental": "", "ops": "", "money": ""}, "simpler": "", "result": "unjustified", "findings": [],
                 "purpose": "Retries a failed call inside one delivery", "works_today": None, "broken_by": "", "next": "", "derived": True}
            additions.append(a)
        a["result"] = "unjustified"
        a["simpler"] = a["simpler"] or "Let the queue's redelivery retry the message"
        a["next"] = a["next"] or "Drop the retry on the queue path; the queue already delivers the message again"


def complexity_findings(additions, head=None):
    """An addition that solves nothing that can happen here (unjustified) and names no finding becomes a finding of its
    own: category complexity, impact maintainability (low; never a blocker), the suggestion to remove it. Returns the
    new findings (reviewer resilience) and links each to its addition."""
    import hashlib
    out = []
    for a in additions:
        if a["result"] != "unjustified" or a["findings"]:
            continue
        path, _, line = a["at"].rpartition(":")
        if not path or not line.isdigit():
            continue
        title = f"{a['what']} adds a part this PR does not need"
        fid = hashlib.sha1(f"resilience|{path}|{line}|{title}".encode()).hexdigest()[:12]
        detail = "\n\n".join(x for x in (f"It solves: {a['solves']}" if a["solves"] else "", "It costs: " + "; ".join(v for v in a["cost"].values() if v) if any(a["cost"].values()) else "",
                                           f"Simpler: {a['simpler']}" if a["simpler"] else "") if x)
        out.append({"id": fid, "reviewer": "resilience", "file": path, "line": int(line), "end": int(line), "severity": "low", "category": "complexity",
                    "impact": "maintainability", "title": title, "detail": detail, "suggestion": f"Remove it{': ' + a['simpler'] if a['simpler'] else ''}.", "code": "",
                    "introduced_here": True, **({"head": head} if head else {})})
        a["findings"] = [fid]
    return out
