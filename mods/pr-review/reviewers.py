#!/usr/bin/env python3
"""Automated reviewers for the review layout: Claude's /code-review, Claude's /security-review, `codex review`.

argv[1]: JSON {kind: "claude"|"security"|"codex", url, number, context ({id, env}: the PR's), model (a Claude
model or alias from models.py; haiku runs as sonnet, llm.code_model), codexModel (a Codex slug from models.py; none: Codex's default), worktree (a detached checkout of the PR head, worktree.py), base (the PR's base branch),
head (sha), level (code-review effort: low|medium|high), file (pr-data/findings/<url hash>.json)}.
Runs the reviewer read-only in the worktree (Claude: Read/Grep/Glob/Agent and read-only git/gh Bash only, no edits;
Codex: codex_args()), turns its answer into findings {id, reviewer, file, line, end, severity, title,
detail, suggestion, code, and when the reviewer gave them: category, impact, effect, preconditions, certainty (see
review.py: the severity follows from the impact by the fixed scale)} and merges them into `file` under that reviewer
(other reviewers' findings and every status stay). A review that comes back as text (Codex's, or a slash command that
answered in prose) goes through a cheap Haiku pass in the PR's context. Every call goes to the optional
ledger (llm.py). The slash-command reviewers need those commands in the Claude setup: when one is missing, the same
review runs as a plain prompt. Codex is optional (`codex` on PATH).
runs[kind] in `file` says how the run went: {state: "running", busy, started, pid, head}, then {state: "done", count, cost,
ms, model, at, head, scope, note?} or {state: "failed", error, at, head}; each also auto (why it started by itself) when
the request had it; no entry: never run. scope is the reviewer's own report
{read: [files], checked: [{area, result: finding|clean|not_checked, note}], skipped: [what it left out]}, or None when
it gave none. A run without an answer fails; it is never "0 findings". Prints the run; exit 1 with the reason on stderr.
The security run also draws the PR's security view over the newest analysis' architecture picture (picture()) and
writes it as `security` {head, at, picture, zones, access, crossing, threats} into `file` (security_view()); its
findings get reachable_from and reachability. The analysis draws none of it.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True  # a .pyc written into the mod's folder reloads the mod: the view waiting for this run is gone
import llm  # noqa: E402  (this folder)
import related  # noqa: E402  (the diff read as files and added lines)
import resilience  # noqa: E402  (the resilience run's schema, prompt and checks)
import review  # noqa: E402  (the severity scale and the areas of a run's self-report)

FEATURE = {"claude": "Claude code review", "security": "Security review", "codex": "Codex review", "resilience": "Resilience review"}
BUDGET = {"haiku": 0.5, "sonnet": 3.0, "opus": 8.0}
TIMEOUT = 1500
# What a reviewer may do: the analysis' rules (review.permissions: the checkout, read-only git, no network, no writes,
# whatever no rule allows refused), plus Agent for the slash commands that split their work.
def permissions(worktree):
    return review.permissions(worktree, "Read", "Grep", "Glob", "Agent")


def allowed(req):
    """What the run is allowed to do, as rules (runs[kind].allowed; the Security page shows it)."""
    if req["kind"] == "codex":
        return ["codex exec review: reads the checkout and its clone's .git only, no writes, no network for its commands, "
                "no MCP servers, hooks, plugins or apps, no Codex config of the user or the PR, approval_policy never"]
    return review.allowed_rules(permissions(req["worktree"]))
PLACE = {"file": review.S, "line": {"type": "integer"}, "end": {"type": "integer"}, **review.PROSE}
# A review turned from text: what its words give, nothing judged on top.
PLAIN_FINDINGS = {"type": "object", "required": ["findings"], "properties": {"findings": {"type": "array", "items": {
    "type": "object", "required": ["file", "line", "severity", "title", "detail"], "properties": {
        **PLACE, "severity": {"enum": review.LEVELS}, "category": {"enum": review.CATEGORIES}}}}}}
ASK_PLAIN = ("\n\nAnswer with the findings in the requested JSON: file (path in the repo), line (line number on the new "
             "side, as in the PR head), end (last line, optional), severity (high|medium|low), category (optional), title "
             "(one line), detail (why it is a problem), suggestion (the fix, optional). An empty list is fine.")
AREAS = {"claude": review.AREAS_CODE, "security": review.AREAS_SECURITY, "resilience": resilience.AREAS}
ASK = ("When you are done, answer with the requested JSON. findings: file (path in the repo), line (line number on the new "
       "side, as in the PR head), end (last line, optional), category (structure, security, data, scope, requirement, bug, "
       "test, availability), " + review.JUDGED_TEXT + ", title (one line, plain text), detail (why it is a problem; claim only what the "
       "certainty covers), suggestion (the fix, optional). " + review.TEXTS + " Only real problems; an empty list is fine. scope: your own report "
       "of the work: read (the files you read), checked (one row per area, each with " + review.CHECKED_TEXT + "), skipped "
       "(what you left out and why, short phrases about the PR, e.g. \"the diff: read the changed files whole instead\"; "
       "never a tool, a command or a permission).")
# ---- The security view: trust zones over the analysis' picture, who may do what on the PR's resources (access), from
# where each finding is reachable, and a threat model of the places the PR opens or changes across a trust boundary.
# From the most exposed inwards. operator: a person's workstation or a CI runner outside the system that acts on it
# with its own credentials (it is not public, and it is not a part of the system either).
TRUST = ["public", "operator", "authenticated", "internal", "data"]
RULES = 2  # the security view's rules, written into each view (pr.js secNote: an older one is offered a re-run)
AUTH_KINDS = ["none", "code", "gateway", "iam"]
REACH = ["public", "authenticated", "internal_only", "unknown"]
THREAT_RESULTS = ["finding", "mitigated", "not_assessed"]
OLD_RESULTS = {"checked_clean": "mitigated", "not_checked": "not_assessed"}  # a security view written before
CHECKS = ["none", "network", "token", "signature", "iam"]  # what a gate checks
PRINCIPAL_KINDS = ["internet", "operator", "ci", "role"]
CHANGES = ["added", "widened", "narrowed", "removed", "unchanged"]
STRIDE = ["S", "T", "R", "I", "D", "E"]
EFFECTS = ["allow", "deny"]  # deny: a rule that takes a right away or narrows it (a guard at the resource, no grant)
DATA_KINDS = ["credential", "secret", "personal", "content", "other"]  # what a sensitive field is (dataflow.js KINDS)
SINKS = ["log", "error", "queue", "store", "third_party", "response"]  # where it ends or stays (dataflow.js SINKS)
S = review.S
WHERE = {"type": "object", "properties": {"access": S, "from": S, "to": S}}
SECURITY = {
    "zones": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "name", "trust", "evidence", "nodes"], "properties": {
        "id": S, "name": S, "trust": {"enum": TRUST}, "evidence": S, "nodes": review.STRINGS}}},
    "access": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["id", "resource", "kind", "principal", "principal_kind", "change", "actions", "public",
                                                                                         "auth", "auth_kind", "at"], "properties": {
        "id": S, "resource": S, "kind": S, "principal": S, "principal_kind": {"enum": PRINCIPAL_KINDS}, "principal_node": S, "change": {"enum": CHANGES}, "actions": review.STRINGS,
        "public": {"type": "boolean"}, "auth": S, "auth_kind": {"enum": AUTH_KINDS}, "used": {"type": "boolean"}, "at": S, "node": S, "effect": {"enum": EFFECTS},
        "holds_against": S}}},
    "gates": {"type": "array", "items": {"type": "object", "required": ["where", "principal", "check", "at", "source", "holds_if", "carries"], "properties": {
        "where": WHERE, "principal": S, "check": {"enum": CHECKS}, "at": S, "source": {"enum": ["config", "code"]}, "holds_if": S, "carries": review.STRINGS}}},
    "threats": {"type": "array", "items": {"type": "object", "required": ["where", "boundary", "threat", "stride", "findings", "result", "goal"], "properties": {
        "where": WHERE, "boundary": S, "threat": S, "stride": {"enum": STRIDE}, "findings": review.STRINGS, "result": {"enum": THREAT_RESULTS}, "goal": S,
        "path": review.STRINGS, "evidence": S, "note": S}}},
    "data": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "name", "kind", "steps"], "properties": {
        "id": S, "name": S, "kind": {"enum": DATA_KINDS}, "steps": {"type": "array", "items": {"type": "object", "required": ["node"], "properties": {
            "node": S, "at": S, "sink": {"enum": SINKS}, "protected": S, "retention": S}}}}}}}
ASK_SECURITY = (
    " Each finding also has ref (f1, f2, … in order; threats name findings by it) and reachability (who can reach the flaw: "
    "public, authenticated, internal_only, or unknown when the code does not show it). In infrastructure code, a permission "
    "the diff grants that no code uses and an entry point (a route, a function URL, a public bucket) without an authorizer "
    "are findings at their lines. zones: the trust zones the code and the infrastructure code show, at most 8, none from "
    "guessing: id, name (e.g. \"Internet\", \"HTTP API\", \"Orders function\", \"Orders queue\"), trust (public: anyone "
    "reaches it without credentials; operator: a person's workstation or a CI runner outside the system, from where an "
    "admin script, a console or a deploy job acts with its own credentials, never public, and only that machine: the "
    "account or service such a script acts on is internal or data, in a zone of its own; authenticated: reached only after the caller was checked, at a gateway or in code; "
    "internal: reached only by the system's own parts, through IAM or the network; data: where state is kept, e.g. a queue, "
    "table, bucket or store), evidence (file:line), nodes (the ids of the picture's nodes in it, from the list in the prompt; "
    "a module takes the zone of the unit it runs in; a node in at most one zone). Whoever calls from outside stands in a zone of its own, apart from "
    "the system's parts it calls: a sender on the internet in a public one, an operator's workstation or a CI runner in an operator one. Another "
    "cloud account, organisation or provider is a zone of its own and its name says which one (e.g. \"Management account: "
    "Organizations\"); never parts of two accounts in one zone. access: who may do what on the resources "
    "that the PR's code and infrastructure code add or change (IAM policies and roles, resource policies, routes and their "
    "authorizers, public flags), one row per grant or entry point, at most 16: id (acc1, acc2, … in order), resource (its "
    "name in the template; \"*\" when the grant names every resource), kind (e.g. queue, function, route, bucket, table), principal (who gets it: a function, a role, "
    "\"anyone on the internet\"), principal_node (the id of the picture's node or group (frame) that is the principal, e.g. "
    "the group of the function whose role gets the grant; none when no node or group is it), principal_kind (internet: anyone from outside; operator: a person running a script, the "
    "console or a manual deploy; ci: a CI or deploy pipeline; role: a role or function of the system), change (added, "
    "widened, narrowed, removed or unchanged: what this PR does to the grant or entry), actions (e.g. sqs:SendMessage, "
    "\"call GET /items\"; a wildcard as the policy writes it, e.g. \"s3:*\" or \"*\"), public (true when it is reachable without credentials of the cloud account), auth (what checks "
    "the caller, e.g. \"bearer token checked in handler.py\"), auth_kind (none: nothing checks the caller; code: a check in "
    "the application's code; gateway: an authorizer or key at the gateway; iam: the cloud's IAM), used (false when nothing "
    "in the code uses the grant), at (file:line), node (the id of its picture node, if any), effect (deny for a rule "
    "that takes a right away or narrows it: a deny statement, a condition such as TLS only, a public access block, a "
    "guardrail policy; then principal is who is denied, actions what is denied without the word deny, auth the kind of "
    "rule, holds_against what the rule stops in one sentence (who is kept from doing what, e.g. \"another role of the "
    "account sends forged events to the queue\"), change what this PR does to the rule (added; widened: it now denies "
    "more; narrowed: it now denies less, e.g. a longer exception list or fewer actions; removed; unchanged), and the "
    "row is a guard at its resource, never a grant or a way in, and node is required: the picture node of the resource it protects; a guard the PR narrows or removes is a finding at "
    "its line unless the diff puts another check in its place; else allow or left out), holds_against (only for a guard). Ways of operators and CI that "
    "the PR adds or changes (admin scripts, workflows, deploy jobs, guardrails they switch) are rows of their own; empty "
    "when the PR touches no such place. A crossing is an access row, or a call between two picture nodes in zones of "
    "different trust: once you have the zones, go through the picture's edges and take every edge whose two ends lie in "
    "zones of different trust; the PR adds or changes it when the edge or one of its ends is new or changed. A call that "
    "stays in one process (in_process in the picture) is no crossing; when it reaches code written for another source "
    "of input (a queue consumer's handler called with an internet request), it bypasses the boundary and needs a threat "
    "like a crossing. A node that runs in another node's or group's process (runs_in) stands in that zone; one that runs in several stands in the most exposed of them. gates: the check at each crossing the PR adds or changes, where it really happens: where (access: "
    "the id of an access row; or from and to: the two picture nodes), principal (the identity the request goes on with), "
    "check (none, network, token, signature, iam), at (file:line of the check), source (config: a gateway, authorizer or "
    "policy checks before the code runs; code: the receiving function's own code checks), holds_if (what must be true for "
    "the check to hold, e.g. \"FRONT_DESK_TOKEN is set and not empty\"; empty when nothing), carries (the parts of the "
    "request an attacker controls past this point, e.g. \"body.id\", \"Authorization header\"; never empty for a crossing "
    "from public). threats: a threat model of the crossings this PR adds or changes, at least one entry for each of them, "
    "each one about what an attacker does, never a defect of the code (a call that never happens, a wrong value, a "
    "missing retry: that is a finding); for an access row that grants a principal a right into another zone (a role or "
    "function allowed to send to a queue, read a table, invoke another function), the threat to name first is the misuse "
    "of that right by an attacker who has taken over the principal, with goal what they then reach, also when the code "
    "uses the right correctly or not at all; that the attacker must first take over the principal is the premise, not a "
    "reason for not_assessed: it is mitigated when the grant names only the actions and resources the code uses "
    "(evidence: the line of the policy that limits it, note: what it is limited to) and a finding when it is wider; "
    "for a deny row the threat is what the rule stops, mitigated with the rule's line as evidence; "
    "for an operator's script or a workflow: what the widest thing is its credentials can do, in which account; "
    "for a way in checked by a shared secret or a signature (a webhook): also a replayed genuine request, and what a "
    "forged or replayed message sets off behind the place it is stored (each mitigated with evidence, a finding, or "
    "not_assessed with the reason); "
    "one entry per concrete threat, no two alike: where (as for gates), boundary (the boundary crossed, e.g. \"Internet → "
    "Front desk function\"), threat (one sentence about this code: who does what, through which line), stride (one letter: "
    "S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege), "
    "findings (the refs of only those findings that make this threat possible or worse: the check that is missing or fails, "
    "the grant that is wider than needed, the limit every caller shares; never a plain defect that merely sits at the "
    "same place, such as a call that is never made, a wrong value or lost work, which gives the attacker nothing: "
    "leave it out, and without such a finding the threat is mitigated or not_assessed), result (finding: a finding shows it; mitigated: the code holds "
    "against it, and evidence names the file:line that shows it; not_assessed: you did not check it), goal (what an "
    "attacker reaches in the end, one sentence), path (the ids of the nodes or groups from the principal to what the "
    "attacker reaches, also the steps that cross no boundary, e.g. [\"internet\", \"handler\", \"consumer\", \"mailer\"]), "
    "evidence (file:line, for mitigated), note (a few words; for not_assessed the reason). A finding's reachable_from "
    "and reachability name the same place as the threat that names it. data: the sensitive data the PR's code reads, "
    "passes on, writes or sends, at most 8, only what the code shows and none from guessing: id (d1, d2, … in order), "
    "name (as the code calls it, e.g. \"bearer token (Authorization header)\", \"member's mail address\"), kind "
    "(credential: what proves who someone is, e.g. a token, a password, a session, an API key; secret: a value the "
    "system keeps to itself, e.g. a signing key or a shared secret in configuration; personal: data about a person, "
    "e.g. a mail address, a name, an id document, payment data; content: what users wrote or uploaded; other), steps "
    "(its way in order, one step for each place where it starts, is passed on, is written or is sent: node (the id of "
    "the picture's node it is at), at (file:line), sink (only where it ends or stays: log: written to a log; error: "
    "put into an error message or an exception's text; queue; store: a table, bucket, file or cache; third_party: "
    "sent to a service outside the system; response: returned to the caller; left out where it only passes), "
    "protected (how it is protected at this step in a few words, e.g. \"TLS\", \"encrypted with the bucket's KMS "
    "key\", \"masked\", \"hashed\", \"compared in constant time, never stored\"; empty when the code does not "
    "say, never a guess), retention (for a log, a queue or a store: the rule that removes it, with its file:line; "
    "empty when the code names none)). Empty when the PR's code touches no such data.")
ASK_JSON = "\n\n" + ASK


def findings_schema(kind, worktree=None):
    """What a Claude reviewer answers with. The ask is also the schema's description: a slash command that runs as a
    fork takes no extra prompt text (it would read it as the review target), but it sees the schema; so the way to call
    git (review.git_hint) stands there too. The security reviewer also answers with its view (SECURITY)."""
    sec, res = kind == "security", kind == "resilience"
    extra = {"ref": S, "reachability": {"enum": REACH}} if sec else {"ref": S} if res else {}  # every Claude reviewer may name the way from outside (review.PATH)
    own = SECURITY if sec else resilience.SCHEMA if res else {}
    return {"type": "object", "description": review.git_hint(worktree) + ASK + (ASK_SECURITY if sec else resilience.ASK if res else ""),
            "required": ["findings", "scope", *own], "properties": {
        "findings": {"type": "array", "items": {"type": "object", "required": ["file", "line", "title", "detail", *review.JUDGED, *(["ref"] if sec or res else [])],
                                               "properties": {**PLACE, **review.JUDGED, **review.PATH, **extra}}},
        "scope": {"type": "object", "required": ["read", "checked", "skipped"], "properties": {
            "read": review.STRINGS, "checked": review.checked_schema(AREAS[kind]), "skipped": review.STRINGS}},
        **own}}


MISSING = re.compile(r"unknown (slash )?(command|skill)|no such (command|skill)|not a (known|valid) (command|skill)", re.I)
# The steps of a security review, taken over from what the /security-review template asks (it cannot run here: its
# template runs plain git), plus the places where a change to infrastructure goes wrong in practice: rights, retries.
SECURITY_STEPS = (
    " Work in three steps. 1. Context: read the diff and the code around it; list each way in (routes, handlers, queue "
    "and event consumers, scheduled jobs, scripts an operator runs), each infrastructure resource and grant the diff "
    "adds or changes, and what each way in reaches. 2. Check every changed place against each of these, following the "
    "data from the caller or the message to what it changes:\n"
    "- authentication and authorization: who can call it, what checks the caller and where, and whether the check fails "
    "open (an empty or default secret, a missing authorizer, a route that skips the check the others have);\n"
    "- permissions: take each grant, role or policy the diff adds one by one and find the call in the code that uses it "
    "(e.g. a send to the queue the policy names); a grant with no such call is a finding at the grant's line, also when "
    "another finding explains why the call is missing; and is it wider than the code needs (actions, resources, "
    "principals, public access);\n"
    "- a way in checked by a shared secret or a signature (a webhook, a callback): is the comparison constant-time; can a "
    "genuine request be replayed (a timestamp or delivery id that is checked); is the body size and the rate limited "
    "before the check, and does one caller's flood take the limit from the others; where is the secret kept, who can "
    "read or set it and how is it changed; what does a forged or replayed message set off downstream;\n"
    "- an operator's script or a workflow: which account and role it needs, and whether it can leave a guardrail off "
    "or data behind when it stops halfway;\n"
    "- input: each field a caller or a message controls, and what it reaches without a check (ids, paths, queries, "
    "commands, templates, deserialization, a state the record must be in);\n"
    "- secrets: hard-coded values, unsafe defaults, a secret the deployment never sets, secrets in errors or logs;\n"
    "- error and retry paths: what happens when a call, a message or a batch fails: is a side effect repeated on retry "
    "(a mail sent twice, a charge made twice), does one bad record fail or re-run a whole batch, is there a dead-letter "
    "queue, is a failure swallowed so the work is silently lost, does a failure leave data half written or fail open;\n"
    "- state across components: does a component rely on state that another process or function holds (its memory, a "
    "local file), so it reads nothing or something else in production;\n"
    "- personal data and logging: what reaches logs, errors or responses that must not;\n"
    "- dependencies: packages the diff adds or changes, and whether they are used.\n"
    "3. Report each problem the code shows, at the line where it happens, also one that is not an exploit but a failure "
    "a caller or a message can trigger (lost or repeated work). Leave out what you could not confirm in the code: no "
    "guesses, no best-practice advice without a concrete effect, nothing about tests or documentation; say in your scope "
    "report what you did not check.")
PLAIN = {"claude": "Review the changes of this checkout against origin/{base} (git diff origin/{base}...HEAD), which are "
                   "PR #{number}, for bugs and correctness problems: read the surrounding code before you report anything.",
         "security": "Do a security review of the changes of this checkout against origin/{base} (git diff "
                     "origin/{base}...HEAD), which are PR #{number}." + SECURITY_STEPS,
         "resilience": "Review the changes of this checkout against origin/{base} (git diff origin/{base}...HEAD), which are "
                       "PR #{number}, for resilience." + resilience.STEPS.replace("{", "{{").replace("}", "}}")}


def git(*args, cwd):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def normalize(raw, reviewer, worktree):
    """Reviewer findings with a stable id and the code line they point at (to notice when a push changes it)."""
    out = []
    for f in raw or []:
        f = review.judge(dict(f))
        path = str(f.get("file") or "").strip().removeprefix("./")
        if path.startswith(str(worktree)):
            path = path[len(str(worktree)):].lstrip("/")
        line = int(f.get("line") or 0)
        title = str(f.get("title") or "").strip()
        if not path or not title:
            continue
        text = review.read_checkout(worktree, path)  # the model's path: only a regular file inside the checkout
        lines = text.splitlines() if text else []
        code = lines[line - 1] if 0 < line <= len(lines) else ""
        fid = hashlib.sha1(f"{reviewer}|{path}|{line}|{title}".encode()).hexdigest()[:12]
        out.append({"id": fid, "reviewer": reviewer, "file": path, "line": line, "end": int(f.get("end") or line),
                    "severity": f["severity"], "title": title, "detail": str(f.get("detail") or ""), "suggestion": str(f.get("suggestion") or ""),
                    "code": code, **{k: f[k] for k in (*review.JUDGED, *review.PATH, "ref", "reachability") if f.get(k) not in (None, "", [])}})
    return out


def picture(file):
    """The newest analysis of this PR that has an architecture picture (pr-data/cache/rv-<the findings file's
    name>-….json next to pr-data/findings): its answer and when it was made; ({}, None) without one."""
    file = pathlib.Path(file)
    for f in sorted(file.parent.parent.joinpath("cache").glob(f"rv-{file.stem}-*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            doc = json.loads(f.read_text()) if "." not in f.name.removesuffix(".json") else {}
        except (OSError, ValueError):
            continue
        if ((doc.get("answer") or {}).get("architecture") or {}).get("nodes"):
            return doc["answer"], doc.get("generated")
    return {}, None


def picture_text(pic):
    """The analysis' picture for the security reviewer's prompt: the node ids it may name."""
    arch = pic.get("architecture") or {}
    if not arch.get("nodes"):
        return "\n\nThis PR has no architecture picture yet: zones name no nodes, and threats sit only at access rows."
    return ("\n\nThe architecture picture of this PR from its analysis. Groups (frames: id: label, kind):\n"
            + "\n".join(f"- {g.get('id')}: {g.get('label')}, {g.get('kind') or ''}" for g in arch.get("groups") or [])
            + "\nNodes (id: label, type, status, group, file:line, runs_in):\n"
            + "\n".join(f"- {n.get('id')}: {n.get('label')}, {n.get('type') or ''}, {n.get('status') or ''}, {n.get('group') or ''}, {n.get('at') or ''}"
                        + (f", runs in {', '.join(review.runs_in_of(n))}" if n.get("runs_in") else "") for n in arch["nodes"])
            + "\nEdges (id: caller -> callee: label, status; name an edge by this id):\n"
            + "\n".join(f"- e{k}: {e.get('from')} -> {e.get('to')}: {e.get('label') or ''}, {e.get('status') or ''}" + (", in_process" if e.get("in_process") else "")
                         for k, e in enumerate(arch.get("edges") or [])))


def spot(x):
    """(file, line) of an `at` such as "a.py:12"; line 0 when it names none."""
    path, _, line = str(x.get("at") or "").removeprefix("./").rpartition(":")
    m = re.match(r"\d+", line)
    return (path, int(m[0])) if m else (path or line, 0)


def reach(nodes, edges, components, rows, findings):
    """From where each finding's place can be reached: reachable_from, the ids of the access rows that sit in the
    finding's own lines; else of those at the finding's node (the nearest place of the picture above its line: a
    node's, component's or access row's `at` in the same file); else, when that node has none, at the nearest nodes
    that call it (edges backwards). reachability is the most exposed of them: public (a public row that nothing checks,
    or the finding is the broken check itself: impact unauthorized_access), authenticated (a public row behind a
    check), internal_only. Without any row the model's own reachability stays (reachable_from is then empty), else
    unknown. ponytail: one node per finding and breadth-first over call edges."""
    callers = {}
    for e in edges:
        callers.setdefault(e.get("to"), []).append(e.get("from"))
    at = lambda n: [r for r in rows if r.get("node") == n]  # noqa: E731
    anchors = [(*spot(x), x.get("id")) for x in nodes] + [(*spot(x), x.get("node")) for x in [*components, *rows]]
    for f in findings:
        file, line = str(f.get("file") or "").removeprefix("./"), int(f.get("line") or 0)
        here = sorted((n, node) for path, n, node in anchors if path == file and node)
        start = next((node for n, node in reversed(here) if n <= line), here[0][1] if here else None)
        found = [r for r in rows if spot(r)[0] == file and line and line <= spot(r)[1] <= int(f.get("end") or line)]
        layer, seen = [start] if start and not found else [], set()
        while layer and not found:
            seen.update(layer)
            found = [r for n in layer for r in at(n)]
            layer = [c for n in layer for c in callers.get(n, []) if c not in seen]
        level = lambda r: ("public" if r.get("auth_kind") == "none" or f.get("impact") == "unauthorized_access" else "authenticated") if r.get("public") else "internal_only"  # noqa: E731
        f["reachable_from"] = [r["id"] for r in found]
        if found:
            f["reachability"] = min((level(r) for r in found), key=REACH.index)
        elif f.get("reachability") not in REACH:
            f["reachability"] = "unknown"


def security_view(answer, findings, pic, changed, root=None):
    """The security reviewer's view checked against the analysis' picture (pic: its answer, {} without one) and the
    diff (changed: {path: line numbers the diff adds}, None when unknown). Sets each finding's reachable_from and
    reachability (reach) and drops its ref. Returns:
    zones [{id, name, trust, evidence, nodes}]; access [{id: acc1.., …, principal_kind, change, opened_by_pr (only with
    a known diff)}]; crossing [{from, to, edge: e<k> in the picture's edges}] (the calls between zones of different
    trust); gates [{where, principal, check, at, source, holds_if, carries}]; threats [{id: t1.., where, boundary,
    threat, stride, findings: finding ids, result, goal, evidence, note, derived?}]; effective_zones [{node, drawn,
    effective, where}]; bypasses [{from, to, edge}] (a call in one process between
    zones of different trust: no crossing, but it needs a threat like one); data [{id: d1.., name, kind, steps: [{node,
    at, sink?, protected, retention}]}] (the sensitive data the PR's code moves, each with its way over the picture's
    cards). where is {access} or {from, to, edge}.
    Also: a node without a zone of its own stands in the zone of what it runs_in; access[].principal_node only when the
    picture has that node or group (else None); threats[].path only ids the picture has (and "internet" first); a
    finding whose threat sits at another place than its reachable_from gets reach_conflict and the more exposed of the
    two (reach_conflict()); a gate whose holds_if names configuration, an environment variable or a secret gives an
    operator way in (operator_rows(); root: the checkout, to find where the value is set).
    Only what has its place stays: a zone's node must be on the picture; a gate sits at a crossing (an access row or a
    crossing call); a threat at a crossing this PR adds or changes (an access row whose change is not unchanged, or that
    sits in added lines; a call whose edge or one of its ends is new or changed). A threat with findings is a finding;
    mitigated needs its evidence, else not_assessed. Each such crossing without a threat gets one, derived and
    not_assessed, so an unchecked crossing is never silent. Derived, never asked: a card's effective zone, when the
    check at a crossing into it is none or in its own code (source code): then it stands in its caller's zone (an
    access row from public counts as public), and only the cards where that is more exposed than their drawn zone."""
    arch = pic.get("architecture") or {}
    nodes, edges = arch.get("nodes") or [], arch.get("edges") or []
    ids, frames = {n.get("id") for n in nodes}, {g.get("id") for g in arch.get("groups") or []}
    runs_in = {n.get("id"): review.runs_in_of(n) for n in nodes if n.get("runs_in")}
    zones, zone_of = [], {}
    # The cards an operator or a pipeline acts through (its scripts and workflows): a zone of only such cards is the
    # operator's, whatever the answer calls it (a laptop is not public).
    scripts = {r.get("node") for r in answer.get("access") or [] if isinstance(r, dict) and r.get("principal_kind") in ("operator", "ci") and r.get("node")}
    for z in answer.get("zones") or []:
        if isinstance(z, dict) and z.get("id") and z.get("trust") in TRUST and z["id"] not in [x["id"] for x in zones]:
            mine = [n for n in dict.fromkeys(z.get("nodes") or []) if n in ids and n not in zone_of]
            z = {**z, "trust": "operator"} if mine and set(mine) <= scripts else z
            zone_of.update((n, z) for n in mine)
            zones.append({"id": str(z["id"]), "name": str(z.get("name") or z["id"]), "trust": z["trust"], "evidence": str(z.get("evidence") or ""), "nodes": mine})
    for n in ids:  # code without a deployment of its own stands where it runs; in several, the most exposed zone
        if n in zone_of:
            continue
        found, seen, todo = [], {n}, list(runs_in.get(n, []))
        while todo:
            h = todo.pop(0)
            if h in seen:
                continue
            seen.add(h)
            if h in zone_of:
                found.append(zone_of[h])
            else:
                todo += runs_in.get(h, [])
        if found:
            zone_of[n] = min(found, key=lambda z: TRUST.index(z["trust"]))
    trust = lambda n: (zone_of.get(n) or {}).get("trust")  # noqa: E731
    # A call crosses a boundary between zones of different trust, and between two zones of one trust level when it
    # leaves a cloud account (a frame whose kind says account, subscription, tenant or organisation).
    group_of = {n.get("id"): n.get("group") for n in nodes}
    accounts = {g.get("id") for g in arch.get("groups") or [] if ACCOUNT.search(str(g.get("kind") or ""))}

    def differ(e):
        a, b = zone_of.get(e.get("from")), zone_of.get(e.get("to"))
        if not a or not b or a["id"] == b["id"]:
            return False
        ga, gb = group_of.get(e["from"]), group_of.get(e["to"])
        return a["trust"] != b["trust"] or (ga != gb and bool({ga, gb} & accounts))
    crossing = [{"from": e["from"], "to": e["to"], "edge": f"e{k}"} for k, e in enumerate(edges) if differ(e) and not e.get("in_process")]
    # A call in one process bypasses a boundary when it reaches code written for another source of input: a callee with
    # a way in of its own (a crossing into it, or an access row at it), as a queue consumer's handler. A library called
    # in one process (no way in of its own) runs in its caller's zone: no bypass.
    entries = {c["to"] for c in crossing} | {r.get("node") for r in answer.get("access") or [] if isinstance(r, dict)}
    bypasses = [{"from": e["from"], "to": e["to"], "edge": f"e{k}"} for k, e in enumerate(edges) if differ(e) and e.get("in_process") and e["to"] in entries]
    rows, named = [], {}
    for r in answer.get("access") or []:
        if not isinstance(r, dict) or not r.get("resource"):
            continue
        row = {**{k: v for k, v in r.items() if (k != "node" or v in ids) and (k != "principal_kind" or v in PRINCIPAL_KINDS) and (k != "change" or v in CHANGES)},
               "id": f"acc{len(rows) + 1}", "principal_node": r.get("principal_node") if r.get("principal_node") in ids | frames else None}
        row.pop("effect", None)
        if is_guard(r):  # a rule that takes a right away: a guard at its resource, no grant and no crossing
            row["effect"] = "deny"
            if not row.get("node"):  # the answer left its card out: the card its resource names, else the one card of its kind
                row["node"] = guard_node(r, nodes, answer.get("access") or [])
                if not row["node"]:
                    del row["node"]
        named.setdefault(str(r.get("id") or row["id"]), row["id"])
        if changed is not None:
            path, line = spot(row)
            row["opened_by_pr"] = line in changed.get(path, ())
        rows.append(row)
    reach(nodes, edges, pic.get("components") or [], rows, findings)
    # A flaw reachable through a way in that this PR opens or widens is this PR's, also in old lines (an old token
    # check that the PR's new public route now exposes).
    opens = {r["id"] for r in rows if r.get("change") in ("added", "widened") or (r.get("change") is None and r.get("opened_by_pr"))}
    for f in findings:
        if opens & set(f.get("reachable_from") or []):
            f["introduced_here"] = True
    refs = {f.pop("ref"): f["id"] for f in findings if f.get("ref")}
    status = {n.get("id"): n.get("status") for n in nodes}

    def place(w):  # a model's where as (where, the access row or None, new or changed by this PR), or None
        w = w if isinstance(w, dict) else {}
        row = next((r for r in rows if r["id"] == named.get(str(w.get("access")))), None)
        if row is not None:
            new = row.get("change") in CHANGES[:4] or (row.get("change") is None and row.get("opened_by_pr") is not False)
            return {"access": row["id"]}, row, new
        cross = next((c for c in crossing + bypasses if (c["from"], c["to"]) == (w.get("from"), w.get("to"))), None)
        if cross:
            return dict(cross), None, bool({edges[int(cross["edge"][1:])].get("status"), status.get(cross["from"]), status.get(cross["to"])} & {"new", "changed"})
        return None
    gates = []
    for g in answer.get("gates") or []:
        at = place((g or {}).get("where"))
        if at and g.get("check") in CHECKS:
            gates.append({"where": at[0], "principal": str(g.get("principal") or ""), "check": g["check"], "at": str(g.get("at") or ""),
                          "source": g.get("source") if g.get("source") in ("config", "code") else "code", "holds_if": str(g.get("holds_if") or ""),
                          "carries": [str(x) for x in g.get("carries") or []]})
    threats = []
    for t in answer.get("threats") or []:
        at, text = place((t or {}).get("where")), str((t or {}).get("threat") or "").strip()
        if not at or not at[2] or not text:
            continue
        found = [refs[x] for x in dict.fromkeys(t.get("findings") or []) if x in refs]
        said = OLD_RESULTS.get(t.get("result"), t.get("result"))
        result = "finding" if found else "mitigated" if said == "mitigated" and str(t.get("evidence") or "").strip() else "not_assessed"
        threats.append({"id": f"t{len(threats) + 1}", "where": at[0], "boundary": str(t.get("boundary") or ""), "threat": text,
                        "stride": t.get("stride") if t.get("stride") in STRIDE else "", "findings": found, "result": result, "goal": str(t.get("goal") or ""),
                        "path": [str(x) for k, x in enumerate(t.get("path") or []) if x in ids | frames or (k == 0 and x == "internet")],
                        "evidence": str(t.get("evidence") or ""), "note": str(t.get("note") or "")})
    # A finding a named threat stands on is a security finding, whatever its effect is called (pr.js isSecurity reads
    # `threats`): a flood at a public way in is about availability and still an attack.
    by_id = {f["id"]: f for f in findings}
    for t in threats:
        if t["result"] == "finding" and not DEFECT.search(f"{t['goal']} {t['note']}"):
            for fid in t["findings"]:
                by_id[fid].setdefault("threats", []).append(t["id"])
    name = lambda n: (zone_of.get(n) or {}).get("name") or n  # noqa: E731
    # A row is a crossing to assess unless it is a guard (it protects; one the PR narrows or removes is to assess: what
    # it no longer stops), or a right of a known principal on something the picture does not show (a role's own log
    # group): that one stays in the list of rights.
    off_map = lambda r: bool(r.get("principal_node")) and not r.get("node") and not r.get("public") and r.get("principal_kind") not in ("operator", "ci")  # noqa: E731
    open_ = [({"access": r["id"]}, f"{r.get('principal') or 'caller'} → {r['resource']}") for r in rows
             if place({"access": r["id"]})[2] and (r.get("change") in LOOSENED if r.get("effect") == "deny" else not off_map(r))] + \
            [(dict(c), f"{name(c['from'])} → {name(c['to'])}") for c in crossing + bypasses if place(c)[2]]

    # A call and an access row are one place: a call from a public card into a card with a public row (that row's way
    # in); a right whose principal (a card, or its frame) makes the call to the row's card; a row at the calling card
    # itself (an operator's script) whose threat walks the call in its path.
    def same(w):
        if not w.get("edge"):
            return []
        walks = lambda t: any((a, b) == (w["from"], w["to"]) for a, b in zip(t["path"], t["path"][1:]))  # noqa: E731
        return [{"access": r["id"]} for r in rows if r.get("effect") != "deny" and (
            (r.get("public") and r.get("node") == w["to"] and trust(w["from"]) == "public")
            or (r.get("node") == w["to"] and r.get("principal_node") in (w["from"], group_of.get(w["from"])) and r.get("principal_node"))  # also an operator's row at what its script reaches
            # an operator's or pipeline's row names its script as its card or as its principal: the script's one call
            # over a boundary, or of several the one a threat at the row walks
            or (r.get("principal_kind") in ("operator", "ci") and w["from"] in (r.get("node"), r.get("principal_node")) and w in crossing
                and (sum(c["from"] == w["from"] for c in crossing) == 1 or any(t["where"] == {"access": r["id"]} and walks(t) for t in threats))))]
    # ... and the other way round: a row is named when a threat sits at the call that is the same place.
    calls_of = lambda w: [dict(c) for c in crossing + bypasses if w in same(c)] if w.get("access") else []  # noqa: E731
    for where, boundary in open_:
        if not any(t["where"] in (where, *same(where), *calls_of(where)) for t in threats):
            threats.append({"id": f"t{len(threats) + 1}", "where": where, "boundary": boundary, "threat": "No threat was named for this crossing.", "stride": "",
                            "findings": [], "result": "not_assessed", "goal": "", "path": [], "evidence": "", "note": "No threat was named for this crossing.", "derived": True})
    effective = {}
    for g in gates:
        if g["check"] != "none" and g["source"] != "code":
            continue
        w = g["where"]
        row = next((r for r in rows if r["id"] == w.get("access")), None)
        node, caller = (row.get("node"), "public" if row.get("public") else None) if row else (w.get("to"), trust(w.get("from")))
        drawn = trust(node)
        if caller and drawn and TRUST.index(caller) < TRUST.index(drawn) and (node not in effective or TRUST.index(caller) < TRUST.index(effective[node]["effective"])):
            effective[node] = {"node": node, "drawn": drawn, "effective": caller, "where": w}
    reach_conflict(findings, threats, rows, trust)
    rows += operator_rows(gates, rows, nodes, root)
    # The sensitive data the answer names, each with its way (dataflow.js): only the steps at a card of the picture; a
    # kind outside the list is "other", a sink outside it none; an entry without a step on the picture drops out.
    # Empty texts stay empty: "not stated" is what the page says then, never a guess here.
    data = []
    for d in answer.get("data") or []:
        if not isinstance(d, dict) or not str(d.get("name") or "").strip():
            continue
        steps = [{"node": s["node"], "at": str(s.get("at") or ""), **({"sink": s["sink"]} if s.get("sink") in SINKS else {}),
                  "protected": str(s.get("protected") or "").strip(), "retention": str(s.get("retention") or "").strip()}
                 for s in d.get("steps") or [] if isinstance(s, dict) and s.get("node") in ids]
        if steps and len(data) < 8:
            data.append({"id": f"d{len(data) + 1}", "name": str(d["name"]).strip(), "kind": d.get("kind") if d.get("kind") in DATA_KINDS else "other", "steps": steps})
    return {"zones": zones, "access": rows, "crossing": crossing, "bypasses": bypasses, "gates": gates, "threats": threats, "effective_zones": list(effective.values()), "data": data}


# How exposed a place is: an access row by its own words (public and nothing checks: public; public behind a check:
# authenticated; else internal_only), a call by the trust of its caller's zone.
LEVEL_OF_TRUST = {"public": "public", "operator": "internal_only", "authenticated": "authenticated", "internal": "internal_only", "data": "internal_only"}


def reach_conflict(findings, threats, rows, trust):
    """A finding and the threat that names it must say the same place. When the threat sits at an access row the
    finding's reachable_from does not name, or at a more exposed place than its reachability: reach_conflict
    {finding: {reachable_from, reachability}, threat: {id, where, reachability}}, and the more exposed side wins
    (reachability; reachable_from starts with the threat's row). Nothing is taken silently."""
    by = {f["id"]: f for f in findings}
    for t in threats:
        w, row = t["where"], next((r for r in rows if r["id"] == t["where"].get("access")), None)
        for fid in t["findings"]:
            f = by.get(fid)
            if not f or "reach_conflict" in f:
                continue
            # as reach(): a public row that nothing checks, or the finding is the broken check itself, is public
            level = (("public" if row.get("auth_kind") == "none" or f.get("impact") == "unauthorized_access" else "authenticated") if row.get("public") else "internal_only") \
                if row else LEVEL_OF_TRUST.get(trust(w.get("from")))
            here = f.get("reachability") if f.get("reachability") in REACH else "unknown"
            off_row = row is not None and row["id"] not in (f.get("reachable_from") or [])
            wider = level in REACH and REACH.index(level) < REACH.index(here)
            if off_row or wider:
                f["reach_conflict"] = {"finding": {"reachable_from": list(f.get("reachable_from") or []), "reachability": here},
                                       "threat": {"id": t["id"], "where": dict(w), "reachability": level}}
                if wider:
                    f["reachability"] = level
                if row is not None:
                    f["reachable_from"] = [row["id"], *[x for x in f.get("reachable_from") or [] if x != row["id"]]]


SETTING = re.compile(r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b")  # FRONT_DESK_TOKEN
SUBJECT = re.compile(r"^\s*(?:the |a |an )?(.{3,60}?)\s+(?:is|are|was|has|have|must|stays?|exists?)\b", re.I)  # "the webhook secret is set …"
ACCOUNT = re.compile(r"account|subscription|tenant|organi[sz]ation", re.I)  # a frame that is a cloud account
DENIES = re.compile(r"^\s*(deny|denies|block|blocks)\b", re.I)
LOOSENED = ("narrowed", "removed")  # what a PR does to a guard that makes it a finding candidate
DEFECT = re.compile(r"not an attacker('s)? goal|no attacker|not exploitable|no abuse path|no abuse", re.I)  # as pr.js isDefect: a defect named as a threat


def guard_node(row, nodes, access):
    """The picture node a guard without one protects: the node whose name (its label before a bracket, or its id) the
    guard's resource contains ("LoanEventsPolicy" protects "LoanEvents (SQS)"), else the one node the grants of the
    same kind sit at (the queue every "queue" row names). None when neither says."""
    key = lambda s: re.sub(r"[^a-z0-9]+", "", str(s or "").split("(")[0].lower())  # noqa: E731
    res = key(row.get("resource"))
    named = [n.get("id") for n in nodes if len(key(n.get("label") or n.get("id"))) >= 4 and key(n.get("label") or n.get("id")) in res]
    if len(named) == 1:
        return named[0]
    ids = {n.get("id") for n in nodes}
    same = {r.get("node") for r in access if isinstance(r, dict) and r is not row and not is_guard(r) and r.get("kind") and r.get("kind") == row.get("kind") and r.get("node") in ids}
    return same.pop() if len(same) == 1 else None


def is_guard(row):
    """A rule that takes a right away or narrows it (effect deny; a run from before the field wrote "deny …" as its
    actions): a guard at its resource, not a grant."""
    actions = [str(a) for a in row.get("actions") or []]
    return row.get("effect") == "deny" or (bool(actions) and all(DENIES.match(a) for a in actions))
CONFIGISH = re.compile(r"environment|env var|config|secret|parameter|setting|deploy", re.I)
CONFIG_FILES = re.compile(r"\.(ya?ml|json|toml|tf|tfvars|env|ini|cfg|conf)$|(^|/)\.env[^/]*$|Dockerfile", re.I)


def value_from(root, name):
    """Where the checkout's configuration sets `name` (file:line of the first config file that names it), or None.
    Only files git tracks as regular files (`ls-files -s`: no symlink, mode 120000, no submodule), each read through
    review.read_checkout (inside the checkout, at most READ_CAP bytes): a PR can check in `config.yaml -> ~/.ssh/...`."""
    if not root or not pathlib.Path(root).is_dir():
        return None
    try:
        listed = git("ls-files", "-s", "-z", cwd=root)
    except (RuntimeError, OSError, subprocess.SubprocessError):
        return None
    for entry in listed.split("\0"):
        meta, _, rel = entry.partition("\t")
        if not rel or not meta.startswith("100") or not CONFIG_FILES.search(rel):  # 100644/100755: regular files only
            continue
        for k, line in enumerate((review.read_checkout(root, rel) or "").splitlines(), 1):
            if name in line:
                return f"{rel}:{k}"
    return None


def operator_rows(gates, rows, nodes, root):
    """An operator way in for each gate whose holds_if names configuration, an environment variable or a secret: who
    deploys sets the value the check depends on (derived, from_gate, value_from: where the repository sets it, None
    when nowhere)."""
    out, label = [], {n.get("id"): n.get("label") or n.get("id") for n in nodes}
    for k, g in enumerate(gates):
        text = g.get("holds_if") or ""
        names = list(dict.fromkeys(SETTING.findall(text)))
        if not names and not CONFIGISH.search(text):
            continue
        w = g["where"]
        node = next((r.get("node") for r in rows if r["id"] == w.get("access")), None) if w.get("access") else w.get("to")
        # Without a NAME_LIKE_THIS the condition's own subject names it ("the webhook secret is set and not empty").
        subject = SUBJECT.match(text)
        for name in names or [subject[1].strip() if subject else "configuration"]:
            src = value_from(root, name) if names else None
            same = next((o for o in out if o.get("node") == node and not names and o["value_from"] is None and not SETTING.search(o["resource"])), None)
            if same:  # two checks of one card that hold on unnamed settings: one operator way, both named
                if name not in same["resource"].split("; "):
                    same["resource"] += f"; {name}"
                    same["actions"].append(f"set {name}")
                same["from_gates"].append(k)
                continue
            out.append({"id": f"acc{len(rows) + len(out) + 1}", "resource": name, "kind": "configuration", "principal": f"operator who deploys {label.get(node, node or 'it')}",
                        "principal_kind": "operator", "principal_node": None, "change": "unchanged", "actions": [f"set {name}"], "public": False, "auth": "deploy access",
                        "auth_kind": "iam", "at": src or g.get("at") or "", **({"node": node} if node else {}), "derived": True, "from_gate": k, "from_gates": [k], "value_from": src})
    return out


def scope(raw, kind):
    """The reviewer's own report of its work: {read, checked (every area of this reviewer; left out: not_checked),
    skipped}. None when it gave none (Codex, a review turned from text)."""
    if not isinstance(raw, dict) or kind not in AREAS:
        return None
    return {"read": [str(x).removeprefix("./") for x in raw.get("read") or []], "checked": review.checked(raw.get("checked"), AREAS[kind]),
            "skipped": [str(x) for x in raw.get("skipped") or []]}


def from_text(text, req, meta):
    """A review written as text turned into findings by a cheap Haiku pass in the PR's context; its cost joins meta."""
    m = {}
    answer = llm.claude(FEATURE[req["kind"]], "Turn this code review into findings. Keep its wording; do not add findings.\n\n"
                        + text[-60000:] + ASK_PLAIN, context=req.get("context"), model="haiku", schema=PLAIN_FINDINGS, budget=0.3,
                        timeout=300, meta=m)
    if answer is None:
        raise RuntimeError(f"{FEATURE[req['kind']]}: the review could not be turned into findings")
    meta.update(cost=(meta.get("cost") or 0) + (m.get("cost") or 0), ms=(meta.get("ms") or 0) + (m.get("ms") or 0),
                model_id=meta.get("model_id") or m.get("model_id"))
    return answer


def merge(file, reviewer, head, findings, run, security=None, blocks=None):
    """Replace this reviewer's findings (None: keep them, only the run changes) and, given one, the security view (and
    other blocks by name, e.g. {"resilience": …}) in the PR's file, under a lock; statuses (set by the panel) stay. ponytail: the panel writes statuses without this lock (compare-and-swap on the
    whole file), so a status set in the very moment a reviewer finishes can be lost."""
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = json.loads(file.read_text()) if file.exists() else {}
        if findings is not None:
            doc["findings"] = [f for f in doc.get("findings", []) if f["reviewer"] != reviewer] + [{**f, "head": head} for f in findings]
        doc.setdefault("runs", {})[reviewer] = run
        if security is not None:
            doc["security"] = security
        doc.update(blocks or {})
        tmp = file.with_name(f".{file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        tmp.replace(file)


def missing_command(text):
    return bool(MISSING.search(str(text or "")))


def code_review_command(req):
    """The /code-review call: the level, then the PR's own range as the target. Nothing after it: the command takes
    every word after the level as the target. Not the PR number: for a PR stacked on another one the command then
    reviews against the default branch, the PR below it included."""
    return f"/code-review {req.get('level') or 'medium'} origin/{req['base']}...HEAD"


def claude_review(req, command=None):
    """The review as a plain prompt (command None), or a slash command; when the Claude setup doesn't have it, the
    plain prompt. Returns the answer {findings, scope?}. A command that answered in text only: that text through
    from_text. No answer at all is an error, not an empty review. ponytail: main() always runs the plain prompt now
    (the slash commands' templates run plain git, which a run may not); the command path stays for a setup that
    allows them."""
    def ask(text, skills):
        meta = {}
        answer = llm.claude(FEATURE[req["kind"]], text, context=req.get("context"), model=req["model"],
                            schema=findings_schema(req["kind"], req["worktree"]), budget=BUDGET[llm.tier(req["model"])], timeout=TIMEOUT, tools="Read,Grep,Glob,Agent,Bash",
                            cwd=req["worktree"], skills=skills, meta=meta,
                            extra=(*(("--effort", "high") if req["kind"] == "resilience" else ()), *permissions(req["worktree"])))  # resilience: many paths to follow
        return answer, meta
    try:
        if command is None:
            raise RuntimeError("Unknown command: plain prompt")
        answer, meta = ask(command, True)
        if answer is None and missing_command(meta.get("result")):
            raise RuntimeError(meta.get("result"))
    except RuntimeError as e:
        if not missing_command(e):
            raise
        answer, meta = ask(review.git_hint(req["worktree"]) + PLAIN[req["kind"]].format(base=req["base"], number=req["number"]) + req.get("more", "") + ASK_JSON
                           + (ASK_SECURITY if req["kind"] == "security" else resilience.ASK if req["kind"] == "resilience" else ""), False)
        meta["fallback"] = command is not None
    # Prose from a fork, else the main answer's own prose (a slash command that wrote its review instead of calling the
    # answer tool; a bare "Command completed" is no review).
    prose = (meta.get("text") or "").strip() or (str(meta.get("result") or "").strip() if len(str(meta.get("result") or "").strip()) > 80 else "")
    if answer is None and prose:
        answer = from_text(prose, req, meta)
        meta["converted"] = True
    if not isinstance(answer, dict) or not isinstance(answer.get("findings"), list):
        raise RuntimeError(f"{FEATURE[req['kind']]}: the reviewer ran but gave no findings answer ({str(meta.get('result') or '')[:120]})")
    return answer, meta


# ---- Codex: what its run may do. Codex's own "read-only" sandbox blocks writes and the network but reads the whole
# disk (the home folder, Codex's login file), and a session loads the user's MCP servers and hooks and, in a trusted
# clone, the PR's own .codex/config.toml (an MCP server from it is a command that runs outside every sandbox). So:
# - a permission profile instead of sandbox_mode: the system's own files (Codex's `:minimal`), the tools' folders,
#   the checkout and its clone's .git; nothing else is readable, nothing is writable, commands have no network;
# - --ignore-user-config: no MCP servers and, since the trust of a folder lives there, no config from the PR;
#   --ignore-rules, hooks, plugins and apps (the account's connectors) off, no web search;
# - the model's commands get a core environment (no key or token of Codex's own) and git without the user's config;
# - --strict-config: a Codex that does not know one of these settings fails instead of running without it.
# Checked against Codex 0.164 without a model run: `codex sandbox` with this profile, and a session start against a
# provider that does not answer (test_reviewers.py runs the first). The npm layout was only modelled, not installed.
# ponytail: a Codex set up in config.toml (another provider, the login in the keyring) or installed in a layout not
# known here fails with Codex's own error; pass those settings as -c overrides when someone needs that.
CODEX_TOOLS = ("/opt/homebrew", "/usr/local")  # git and rg outside the system folders
CODEX_SHELL_ENV = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_COUNT": "1",
                   "GIT_CONFIG_KEY_0": "core.attributesFile", "GIT_CONFIG_VALUE_0": "/dev/null"}


def toml(d):
    """A dict of strings and dicts as a TOML inline table (a JSON string is a TOML string)."""
    return "{" + ",".join(f"{json.dumps(k)}={json.dumps(v) if isinstance(v, str) else toml(v)}" for k, v in d.items()) + "}"


def codex_reads(worktree, codex):
    """What a Codex run may read besides the system's own files: the checkout, its clone's .git (a worktree keeps its
    history there), the tools' folders, the codex program itself (installed with npm: its packages' folder) and, on
    macOS, the cache that tells /usr/bin/git where the real git is (without it every git call takes seconds). Real
    paths, only those that exist."""
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=worktree, capture_output=True, text=True).stdout.strip()
    xcrun = os.path.join(os.confstr(65537), "xcrun_db") if sys.platform == "darwin" else ""  # 65537: _CS_DARWIN_USER_TEMP_DIR
    parts = pathlib.Path(os.path.realpath(codex)).parts  # installed with npm: the launcher starts a binary of a package beside it
    npm = str(pathlib.Path(*parts[:parts.index("node_modules") + 2])) if "node_modules" in parts[:-2] else ""
    return [os.path.realpath(p) for p in (worktree, common, *CODEX_TOOLS, codex, npm, xcrun) if p and os.path.exists(p)]


def codex_args(req, codex):
    """The argv of the Codex run. codex by its real path: its sandbox starts the same program again and could not
    read a link in the home folder."""
    codex = os.path.realpath(codex)
    files = {":minimal": "read", ":slash_tmp": "none", **{p: "read" for p in codex_reads(req["worktree"], codex)}}
    pick = ["-c", f"model={json.dumps(req['codexModel'])}"] if req.get("codexModel") else []  # else Codex's own default
    return [codex, "exec", "review", "--base", f"origin/{req['base']}", "--ignore-user-config", "--ignore-rules", "--strict-config",
            "--disable", "hooks", "--disable", "plugins", "--disable", "apps", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
            "-c", 'default_permissions="review"', "-c", f"permissions.review.filesystem={toml(files)}",
            "-c", f"shell_environment_policy={toml({'inherit': 'core', 'set': CODEX_SHELL_ENV})}", *pick]


def codex_review(req):
    started = time.monotonic()
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("codex is not installed (optional): see Setup")
    r = subprocess.run(codex_args(req, codex), cwd=req["worktree"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=TIMEOUT,
                       env=llm.env_for(None, llm.CODEX_LOGIN))
    ms = int((time.monotonic() - started) * 1000)
    text = (r.stdout or "") + ("\n" + r.stderr if r.returncode != 0 else "")
    used = re.search(r"tokens used[:\s]*([\d,.]+)", text, re.I)
    tokens = int(re.sub(r"[^\d]", "", used[1])) if used else 0
    llm.log(FEATURE["codex"], (req.get("context") or {}).get("id") or "default", "codex", 0, tokens, ms, r.returncode == 0, tool="codex")  # Codex reports no price
    if r.returncode != 0:
        raise RuntimeError(f"codex review: {(r.stderr or r.stdout).strip()[-300:]}")
    meta = {"ms": ms, "tokens": tokens, "model_id": req.get("codexModel") or "codex", "converted": True}  # from_text keeps a model already named
    return from_text(text, req, meta), meta


def main(arg):
    req = json.loads(arg)
    req["model"] = llm.code_model(req.get("model"))  # a reviewer judges code: never haiku (the prose pass stays haiku)
    wt = req["worktree"]
    git("fetch", "--quiet", "origin", req["base"], cwd=wt)  # the base for "what changed"
    started = time.monotonic()
    # Plain prompts, not /code-review or /security-review: their templates run plain git before the model starts,
    # and a run may call git only through safegit.py.
    if req["kind"] == "claude":
        answer, meta = claude_review(req)
    elif req["kind"] == "security":
        pic, made = picture(req["file"])
        req = {**req, "more": picture_text(pic)}
        answer, meta = claude_review(req)
    elif req["kind"] == "resilience":  # the picture, the security view and the findings so far as hints
        pic, made = picture(req["file"])
        try:
            doc = json.loads(pathlib.Path(req["file"]).read_text())
        except (OSError, ValueError):
            doc = {}
        known = [f for f in doc.get("findings") or [] if f.get("reviewer") != "resilience"] + \
                [{**f, "reviewer": "analysis"} for st in pic.get("steps") or [] for f in st.get("findings") or [] if f.get("id")]
        req = {**req, "more": picture_text(pic) + resilience.hints(pic, doc.get("security"), known)}
        answer, meta = claude_review(req)
    else:
        answer, meta = codex_review(req)
    findings = normalize(answer.get("findings"), req["kind"], wt)
    try:  # the lines the PR adds: a finding in them is the PR's (introduced_here), an access row there opened by it
        diff = related.diff_files(git("diff", "--no-color", "--no-ext-diff", "-U0", f"origin/{req['base']}...HEAD", cwd=wt))
        changed = {f["path"]: {n for n, _ in f["added"]} for f in diff}
    except (RuntimeError, OSError, subprocess.SubprocessError):
        changed = None
    for f in findings:
        review.introduced(f, changed)
    security, blocks = None, {}
    if req["kind"] == "resilience":
        # edge_ids: the prompt listed the picture's edges with their ids (before, runs counted them, mostly from 1)
        blocks["resilience"] = {"head": req["head"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "model": meta.get("model_id"), "picture": made, "edge_ids": True,
                                "hints_used": {"architecture": bool((pic.get("architecture") or {}).get("nodes")), "security": bool(doc.get("security")), "findings": bool(known)},
                                **resilience.view(answer, findings, pic, [f["id"] for f in known], changed)}
        findings += resilience.complexity_findings(blocks["resilience"]["additions"])  # an unjustified part becomes a finding, never a blocker
    if req["kind"] == "security":
        security = {"head": req["head"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "picture": made, "rules": RULES, **security_view(answer, findings, pic, changed, wt)}
    for f in findings:
        f.pop("ref", None)
    notes = [f"/{'code-review' if req['kind'] == 'claude' else 'security-review'} not available: ran as a plain prompt"] if meta.get("fallback") else []
    notes += ["The reviewer answered in text: a Haiku pass turned it into findings"] if meta.get("converted") else []
    notes += ["Codex reports no scope of its own"] if req["kind"] == "codex" else []
    run = {"state": "done", "cost": meta.get("cost"), "ms": int((time.monotonic() - started) * 1000), "model": meta.get("model_id"),
           "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "count": len(findings), "head": req["head"], "scope": scope(answer.get("scope"), req["kind"]),
           **({"note": ". ".join(notes)} if notes else {}), **({"auto": req["auto"]} if req.get("auto") else {}), "allowed": allowed(req)}
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], findings, run, security, blocks)
    print(json.dumps(run))


if __name__ == "__main__":
    # The panel starts this detached and follows the file: runs[kind] says busy, done or the error.
    req = json.loads(sys.argv[1])
    auto = {"auto": req["auto"]} if req.get("auto") else {}  # why it started by itself (the panel's security trigger)
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "running", "busy": True, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": os.getpid(), "head": req["head"],
                                                                     "allowed": allowed(req), **auto})
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "failed", **llm.failed(e, 400), "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "head": req["head"], "allowed": allowed(req), **auto})
        print(str(e), file=sys.stderr)
        sys.exit(1)
