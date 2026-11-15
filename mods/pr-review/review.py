#!/usr/bin/env python3
"""The AI analysis of one PR (or branch diff) for the review layout's "AI" tab and the panel's walkthrough.

argv[1]: JSON {out, latest, status, model (sonnet|opus; a passed haiku runs as sonnet, llm.code_model), context ({id, env, tickets}), pr (url or
null), source, worktree (the PR head checked out, or the repo root; null: diff only), hunks: [{alias, id, path,
lines}], cut: [aliases left out for size]; incremental runs add previous (the shown analysis' file), since
({base, head}) and full (today's whole-diff hunks [{alias, id, path, head}]) and send only the new hunks (n1..)}.
One thorough run (--effort high; read-only tools in the worktree so it can check callers and types) for: a summary,
the check against the task (PR title/body + the Jira ticket a key names, via acli when installed), and steps with risk,
why it matters, an explanation, reading order, check questions, suggestions on lines, architecture-review findings and flows (example payloads in
and out of changed functions, with a trace of values per line). Also behavior, merge risk, review effort, repo rule checks (rules
from the checkout's CLAUDE.md/AGENTS.md/CONTRIBUTING.md/.github instructions/ADRs plus the configured global rules), an
architecture picture, the blast radius (upstream candidates from git grep), an optional picture per layer, the inventory of
what the PR adds (components, with owners from CODEOWNERS). Security: the findings it sees; zones, access and the threat
model are the security reviewer's (reviewers.py). finish() links
requirements, findings and the picture and sets each finding's severity from the fixed scale. Writes {source, model, model_id, hunks, answer, cut,
cost, usage ({input, output, cache_read, cache_write} tokens of all passes), ms, budget, task, head (the request's: the PR head
the diff is of, or null), generated} to `out` and `latest`; `status` holds {busy, pid, started} while it runs, then
{done} or {error}. Every call goes to the optional usage ledger (llm.py). Texts are in the configured language. Exit 1 with the reason on stderr.
"""
import datetime as dt
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True  # a .pyc written into the mod's folder reloads the mod: the view waiting for this run is gone
import llm  # noqa: E402  (this folder)

FEATURE = "Review analysis"
FEATURE_INC = "Review analysis (since last review)"
FEATURE_DIAGRAMS = "Review diagrams"
BUDGET_DIAGRAMS = {"haiku": 0.5, "sonnet": 1.5, "opus": 5.0}
BUDGET = {"haiku": 1.0, "sonnet": 3.0, "opus": 10.0}  # --max-budget-usd per run
TIMEOUT = 15 * 60
KEY = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])")
NOT_JIRA = {"PR", "ADR", "PEP", "CWE", "UTF", "SHA", "ISO", "RFC", "CVE", "GH", "HTTP", "TLS", "X86", "ARM", "MD5", "BASE64"}
LEVELS = ["high", "medium", "low"]
# What a model run that reads a PR may do (this analysis, and the reviewers in reviewers.py): it reads someone else's
# code and text, which may carry instructions to it. --restricted confines the file tools to the checkout (and
# --add-dir) and ignores the checkout's own .claude settings; dontAsk refuses whatever no rule allows. Allowed: the
# file tools and read-only git through safegit.py, fixed to this checkout (git diff with a path outside the repository
# silently turns into --no-index and reads any file; safegit refuses such paths and the options that write a file,
# run a program or read one, also abbreviated). git itself is denied; no network, no writes.
SAFEGIT = pathlib.Path(__file__).resolve().with_name("safegit.py")  # as llm.py lets it through


def git_call(root):
    """The one way a run may call git: `python3 <safegit.py> <checkout>`, as the allow rule and the prompt say it."""
    return f"python3 {shlex.quote(str(SAFEGIT))} {shlex.quote(str(root))}"


def git_hint(root):
    """The prompt's line on how to call git (empty without a checkout)."""
    return (f"Call git only as `{git_call(root)} <command> <args>`, with diff, log, show, status, blame, merge-base, rev-parse "
            "or ls-files and paths relative to the checkout; plain git is refused.\n\n") if root else ""


def permissions(root, *tools):
    """The CLI flags for a run with these tools plus read-only git in root (None: no git): git only through safegit.py
    (an allowlist); git itself is denied, also the calls Claude Code would let through as read-only by itself."""
    denied = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash(git *)"]
    return ("--restricted", "--permission-mode", "dontAsk", "--allowedTools", *tools, *([f"Bash({git_call(root)} *)"] if root else []),
            "--disallowedTools", *denied)


def allowed_rules(flags):
    """The allow rules of permissions(): what a run was allowed to do, for its record."""
    flags = list(flags)
    return flags[flags.index("--allowedTools") + 1:flags.index("--disallowedTools")] if "--allowedTools" in flags else []
SYSTEM = ("You are a thorough, experienced code reviewer and guide a person through the review of a pull request in {lang}: "
          "ordered by risk, with concrete check points and only real suspicious spots verified in the code, no style "
          "criticism. Take your time: read callers, types and surrounding code before you claim anything. "
          "At the end, answer only in the requested JSON.")
S, STRINGS = {"type": "string"}, {"type": "array", "items": {"type": "string"}}
FLOW = {"type": "object", "required": ["function", "at", "inputs", "output"], "properties": {
    "function": S, "at": S,
    "inputs": {"type": "array", "items": {"type": "object", "required": ["name", "type", "example"], "properties": {"name": S, "type": S, "example": S}}},
    "output": {"type": "object", "required": ["type", "example"], "properties": {"type": S, "example": S}},
    "side_effects": STRINGS, "calls": STRINGS,
    "trace": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["path", "line", "values"], "properties": {
        "path": S, "line": {"type": "integer"}, "values": S}}}}}
# A picture of one layer (or of the whole PR); the model picks the kinds that explain it best (or leaves them out).
# state_machine: nodes may carry a type (Step Functions state types), parent/branch (inside a Parallel or Map state);
# transitions carry event [guard] / action, and error ("catch" | "retry") for error paths.
# Where an element comes from: implemented (in this PR's diff; evidence file:line), existing (already in the codebase,
# unchanged), spec (only in the PR description, ticket, ADRs or spec docs, not found in the diff).
SOURCE = {"enum": ["implemented", "existing", "spec"]}
STATEMENT = {"type": "object", "required": ["text", "source"], "properties": {"text": S, "source": SOURCE, "evidence": S}}
STATE_TYPES = ["task", "choice", "parallel", "map", "wait", "pass", "fail", "succeed", "state"]
TRANSITION = {"type": "object", "required": ["from", "to"], "properties": {
    "from": S, "to": S, "label": S, "event": S, "guard": S, "action": S, "changed": {"type": "boolean"}, "error": {"enum": ["catch", "retry"]},
    "source": SOURCE, "evidence": S}}
VISUAL = {"type": "object", "required": ["kind", "title", "nodes", "edges"], "properties": {
    "kind": {"enum": ["architecture", "flow", "sequence", "state_machine", "steps"]}, "title": S,
    "nodes": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["id", "label"], "properties": {
        "id": S, "label": S, "changed": {"type": "boolean"}, "note": S, "at": S, "type": {"enum": STATE_TYPES}, "parent": S, "branch": {"type": "integer"},
        "source": SOURCE, "evidence": S}}},
    "edges": {"type": "array", "maxItems": 16, "items": TRANSITION},
    "transitions": {"type": "array", "maxItems": 16, "items": TRANSITION}}}
VISUALS = {"type": "array", "maxItems": 3, "items": VISUAL}
STATUS = {"enum": ["new", "changed", "unchanged", "removed"]}
# Trust zones, who may do what (access) and from where a finding is reachable are the security reviewer's
# (reviewers.py), drawn over this picture; an analysis cached before that has them here and still loads.
ARCHITECTURE = {"type": "object", "required": ["groups", "nodes", "edges"], "properties": {
    "groups": {"type": "array", "maxItems": 5, "items": {"type": "object", "required": ["id", "label", "kind"], "properties": {"id": S, "label": S, "kind": S}}},
    "nodes": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["id", "group", "label", "description", "type", "status"], "properties": {
        "id": S, "group": S, "label": S, "description": S, "details": S, "type": S, "status": STATUS, "at": S, "source": SOURCE, "evidence": S, "runs_in": STRINGS,
        "states": {"type": "array", "maxItems": 10, "items": {"type": "object", "required": ["name", "type"], "properties": {
            "name": S, "type": {"enum": STATE_TYPES}, "calls": S, "status": STATUS, "source": SOURCE, "evidence": S}}}}}},
    "edges": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["from", "to", "label"], "properties": {
        "from": S, "to": S, "label": S, "status": STATUS, "source": SOURCE, "evidence": S, "in_process": {"type": "boolean"}}}}}}
BLAST = {"type": "object", "required": ["units", "context"], "properties": {
    "units": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "label", "type", "status", "files", "spots"], "properties": {
        "id": S, "label": S, "type": S, "status": {"enum": ["added", "changed", "removed"]}, "files": STRINGS, "spots": {"type": "integer"}}}},
    "context": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "file", "direction", "relation", "links_to"], "properties": {
        "id": S, "file": S, "direction": {"enum": ["upstream", "downstream"]}, "relation": S, "links_to": S}}}}}
CATEGORIES = ["structure", "security", "data", "scope", "requirement", "bug", "test", "availability", "consistency", "observability", "performance", "complexity"]
# The fixed severity scale: a finding names its impact (the gravest that applies) and the severity follows from it
# (judge), so "high" means the same in every run. {impact: (severity, what it means)}.
IMPACTS = {
    "breaks_requirement": ("high", "breaks an acceptance criterion or a requirement of the task"),
    "dead_path": ("high", "a new or changed path cannot work in production: it always raises, never runs or does nothing"),
    "unauthorized_access": ("high", "someone can read or do something without the permission for it"),
    "data_exposure": ("high", "personal data or secrets reach someone who must not have them"),
    "data_loss": ("high", "data is lost or corrupted"),
    "edge_case": ("medium", "a wrong result or a crash outside the normal path: bad input, a retry, a race"),
    "degraded_operation": ("medium", "it works, but a failure is not contained or not seen"),
    "fragile_structure": ("medium", "coupling or a broken boundary the next change will trip over"),
    "untested": ("medium", "no test would fail when this behavior breaks"),
    "maintainability": ("low", "harder to read or change, the behavior is right"),
    "unrequested": ("low", "a change the task does not ask for, with no other impact")}
SCALE = {k: v[0] for k, v in IMPACTS.items()}
SCALE_TEXT = "; ".join(f"{level}: " + ", ".join(f"{k} ({v[1]})" for k, v in IMPACTS.items() if v[0] == level) for level in LEVELS)
# How sure a finding is: confirmed (something that ran shows it), derived (it follows from the code that was read),
# assumed (it needs something that could not be checked; the preconditions name it).
CERTAINTY = ["confirmed", "derived", "assumed"]
EFFORT = ["quick", "moderate", "heavy"]  # what the fix takes
JUDGED = {"category": {"enum": CATEGORIES}, "impact": {"enum": list(SCALE)}, "effect": S, "preconditions": STRINGS, "certainty": {"enum": CERTAINTY},
          "effort": {"enum": EFFORT}, "introduced_here": {"type": "boolean"}}
# A security finding says two things apart: certainty is about the flaw in the code, path_certainty about the way from
# outside to it (path_why: what that way depends on). Optional: only security findings have them.
PATH = {"path_certainty": {"enum": CERTAINTY}, "path_why": S}
JUDGED_TEXT = ("impact (the gravest that applies; it sets the severity. " + SCALE_TEXT + "), effect (one sentence: what happens to "
               "whom when it occurs), preconditions (what must hold for it to occur, each one checkable, e.g. \"API_TOKEN is "
               "unset in the deployment\"; empty when it always occurs), certainty (confirmed: something that ran shows it, e.g. a "
               "test in the repo or a command's output; derived: it follows from the code you read, every step is in the files; "
               "assumed: it needs something you could not check, such as deployment settings or how a gateway or library "
               "behaves, and preconditions names it), effort (what the fix takes: quick: a few lines in one place; moderate: "
               "several places or a new test; heavy: a design change, a migration or a change other teams must agree to), "
               "introduced_here (true when the flaw is in lines this PR adds or changes, or exists only because of what this PR "
               "adds: a rule it introduces that old code breaks, a way in it opens to old code; false when the flaw sits in code "
               "this PR does not change and would be the same without the PR, also when the PR's new code calls that code, e.g. a "
               "helper that already swallowed errors before). A security finding also has "
               "path_certainty (confirmed, derived or assumed, as for certainty, but for the way from outside to the flaw: who can "
               "send what to reach it; assumed whenever that way depends on something the code does not show, such as a "
               "gateway, a proxy, a client or deployment settings) and path_why (one sentence: what the way depends on, e.g. "
               "\"assumed: depends on the gateway passing an empty bearer token through\"). certainty stays about the code "
               "alone: a check that the code shows to fail is derived even when the way to it is assumed")
# How the texts a person reads are written: markdown where it shortens the reading, never longer than prose. The UI
# renders it in findings and comments; a title stands in one-line lists and stays plain.
TEXTS = ("Texts: detail, suggestion, effect, why and a suggestion's text are markdown. Identifiers, paths and calls are "
         "always `inline code`. Three or more parallel items (cases, the steps of a failure, the rules something breaks) are "
         "a short bullet list, numbered when the order matters, after one introducing line, not one long sentence. A text "
         "of more than three sentences is split into short paragraphs with a blank line between them, one thought each, e.g. "
         "what the code does, then what follows from it. A finding's suggestion says in one sentence what to change; when "
         "the change is a few lines of code (up to about six), it shows them after that sentence in a fenced code block "
         "with its language. No code blocks anywhere else. effect, why and a suggestion's text stay one or two sentences, "
         "with inline code only. title stays one line of plain text without any markdown. No headings, tables, images or "
         "HTML. Structure replaces words, it adds none: apart from a code block, no text gets longer than the plain "
         "sentences would be.")
# The same rules at the fields themselves: a reviewer that runs as a fork sees only the schema, and a rule next to
# its field is followed more often than one in a long prompt.
PROSE = {"title": {**S, "description": "One line of plain text, no markdown."},
         "detail": {**S, "description": "Markdown. Identifiers, paths and calls as `inline code`. More than three sentences: short paragraphs, a "
                                        "blank line between them. Three or more parallel cases or steps: a bullet list after one introducing line."},
         "suggestion": {**S, "description": "Markdown. One sentence on what to change; a change of a few lines of code follows in a fenced code "
                                            "block with its language."}}
# What a run reports about its own work (the model's self-report, not a measurement): one row per area.
AREAS_SECURITY = ["authentication", "authorization", "input_validation", "secrets", "permissions", "personal_data", "dependencies"]
AREAS_CODE = ["correctness", "error_handling", "concurrency", "state", "contracts", "tests"]
RESULTS = ["finding", "clean", "not_checked"]
CHECKED_TEXT = ("result (finding: you report a finding there; clean: you looked and found nothing; not_checked: you did not "
                "look, or the change has none of it) and note (optional, a few words)")


def checked_schema(areas):
    return {"type": "array", "items": {"type": "object", "required": ["area", "result"], "properties": {
        "area": {"enum": areas}, "result": {"enum": RESULTS}, "note": S}}}


# An architecture-review finding of one layer: a problem across lines or files, confirmed in the code. It lives in its
# layer (no findings file); finish() gives it the id the UI uses and its severity; reviewer "analysis".
FINDING = {"type": "object", "required": ["file", "line", "title", "detail", "suggestion", *JUDGED, "criteria"], "properties": {
    "file": S, "line": {"type": "integer"}, "end": {"type": "integer"}, **PROSE, **JUDGED,
    "criteria": STRINGS, "breaks": {"type": "object", "properties": {"node": S, "from": S, "to": S}}, **PATH}}
ASK_STATES = ["met", "partly", "broken", "not_done", "extra"]
SCHEMA = {"type": "object", "required": ["title", "summary", "behavior", "merge_risk", "effort", "rule_checks", "architecture", "blast_radius", "steps", "asks",
                                        "components", "checked", "what_changed", "read"], "properties": {
    "title": S, "summary": S, "behavior": S,
    "what_changed": {"type": "object", "required": ["adds", "changes", "runtime"], "properties": {
        **{k: {"type": "array", "maxItems": 3, "items": {**S, "description": "One thought, at most twelve words."}} for k in ("adds", "changes", "runtime")}}},
    "read": STRINGS,
    "merge_risk": {"type": "object", "required": ["level", "why"], "properties": {"level": {"enum": ["minimal", "low", "medium", "high", "critical"]}, "why": S}},
    "effort": {"type": "object", "required": ["score", "why"], "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 5}, "why": S}},
    "rule_checks": {"type": "array", "maxItems": 20, "items": {"type": "object", "required": ["rule", "source", "status", "why"], "properties": {
        "rule": S, "source": S, "status": {"enum": ["pass", "fail", "n/a"]}, "where": S, "why": S}}},
    "architecture": ARCHITECTURE, "blast_radius": BLAST, "visuals": VISUALS,
    "intent": {"type": "array", "maxItems": 6, "items": STATEMENT}, "behavior_points": {"type": "array", "maxItems": 6, "items": STATEMENT},
    "asks": {"type": "array", "items": {"type": "object", "required": ["id", "text", "short", "acceptance", "state", "why", "hunks"], "properties": {
        "id": S, "text": S, "short": S, "acceptance": {"type": "boolean"}, "state": {"enum": ASK_STATES}, "why": {**S, "description": "One sentence, at most 20 words."}, "hunks": STRINGS, "elements": STRINGS}}},
    "components": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["name", "kind", "status", "at", "operate"], "properties": {
        "name": S, "kind": S, "status": {"enum": ["new", "changed"]}, "at": S, "node": S, "operate": STRINGS}}},
    "checked": checked_schema(AREAS_CODE),
    "steps": {"type": "array", "items": {"type": "object", "required": ["title", "risk", "why_it_matters", "explanation", "reading_order", "hunks", "check_questions", "question_files", "depends_on"], "properties": {
        "title": S, "depends_on": STRINGS, "risk": {"enum": LEVELS + ["skim"]}, "why_it_matters": S, "explanation": S, "reading_order": {"type": "integer"},
        "hunks": STRINGS, "check_questions": {**STRINGS, "maxItems": 3}, "question_files": {**STRINGS, "maxItems": 3},
        "suggestions": {"type": "array", "items": {"type": "object", "required": ["hunk", "line", "side", "severity", "category", "text"], "properties": {
            "hunk": S, "line": {"type": "integer"}, "side": {"enum": ["new", "old"]}, "severity": {"enum": LEVELS}, "category": {"enum": CATEGORIES}, "text": S}}},
        "findings": {"type": "array", "items": FINDING},
        "flows": {"type": "array", "maxItems": 3, "items": FLOW}, "visuals": VISUALS, "skimmed": {"type": "boolean"}}}}}}


def jira_key(title, branch, body):
    """The first ticket key: in title and body only written in capitals (SHELF-12), in the branch in any case (shelf-12-x)."""
    for text, any_case in ((title, False), (branch, True), (body, False)):
        for m in KEY.finditer(text or ""):
            project = m[1].upper()
            if (any_case or m[1].isupper()) and project not in NOT_JIRA and not project.isdigit():
                return f"{project}-{m[2]}"
    return None


def adf_text(node):
    """Plain text of a Jira description (Atlassian Document Format, or already a string)."""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    text = node.get("text", "") + adf_text(node.get("content", []))
    return text + "\n" if node.get("type") in ("paragraph", "heading", "listItem", "codeBlock") else text


def jira(key):
    r = subprocess.run(["acli", "jira", "workitem", "view", key, "--json", "--fields", "summary,description"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[:200])
    fields = json.loads(r.stdout).get("fields") or {}
    return f"{key}: {fields.get('summary') or ''}\n\n{adf_text(fields.get('description')).strip()}".strip()


def task(pr, tickets=True):
    """The PR's title and body, and its Jira ticket when there is one (read with `acli` when it is on PATH and the
    context allows tickets); a note says what was skipped. None: no PR."""
    if not (pr or "").startswith("https://"):
        return None
    r = subprocess.run(["gh", "pr", "view", pr, "--json", "title,body,headRefName"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"gh pr view: {r.stderr.strip()[:200]}")
    d = json.loads(r.stdout)
    out = {"title": d["title"], "text": f"PR: {d['title']}\n\n{d.get('body') or ''}".strip(), "jira": None, "note": None}
    key = jira_key(d["title"], d.get("headRefName"), d.get("body"))
    if key and not tickets:
        out["note"] = f"{key}: tickets are off for this context, skipped"
    elif key and not shutil.which("acli"):
        out["note"] = f"{key}: acli not installed, ticket skipped"
    elif key:
        try:
            out["text"] += "\n\nJira ticket " + jira(key)[:6000]
            out["jira"] = key
        except Exception as e:  # noqa: BLE001 - the review goes on without the ticket
            out["note"] = f"{key}: Jira not readable ({e})"
    return out


def numbered(lines):
    """Hunk lines with their line number (new side; removed lines: old side) so the model can name lines."""
    out, old, new = [], 0, 0
    for line in lines:
        m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)", line)
        if m:
            old, new = int(m[1]), int(m[2])
            out.append(line)
        elif line[:1] == "-":
            out.append(f"-{old:>5} {line[1:]}")
            old += 1
        elif line[:1] == "+":
            out.append(f"+{new:>5} {line[1:]}")
            new += 1
        elif line[:1] == " ":
            out.append(f" {new:>5} {line[1:]}")
            old, new = old + 1, new + 1
        else:
            out.append(line)
    return out


RULE_FILES = ("CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md")
RULE_BUDGET, FILE_BUDGET = 12000, 4000
def global_rules():
    """Conventions every PR is checked against (settings: globalRules), besides the repo's own rules files."""
    return str(llm.config().get("globalRules") or "").strip()


def adr_digest(text):
    """An ADR's title and its status and decision sections only."""
    lines, out, keep = text.splitlines(), [], False
    for line in lines:
        if line.startswith("#"):
            keep = not out or bool(re.search(r"status|decision|entscheidung|beschluss", line, re.I))  # ADR headings, also German
            if not out:
                out.append(line)
                continue
        if keep:
            out.append(line)
    return "\n".join(out).strip()[:800]


READ_CAP = 256_000  # bytes read from one file of a checkout at most


def checkout_file(root, rel):
    """rel as a regular file inside the checkout root, or None. A PR is someone else's code: no absolute path, ~ or ..,
    no symlink anywhere on the way (a PR can check in `config.yaml -> ~/.ssh/id_rsa`), and the resolved file must lie
    inside root. Paths come from the checkout's own listing or from a model's answer."""
    if not root or not rel:
        return None
    text = str(rel).strip().replace("\\", "/").removeprefix("./")
    if not text or text.startswith(("/", "~")) or ".." in text.split("/"):
        return None
    base, cur = pathlib.Path(root).resolve(), pathlib.Path(root)
    for part in pathlib.PurePosixPath(text).parts:
        cur = cur / part
        if cur.is_symlink():
            return None
    try:
        real = cur.resolve()
    except OSError:
        return None
    return cur if real.is_relative_to(base) and cur.is_file() else None


def read_checkout(root, rel, cap=READ_CAP):
    """The text of a file of the checkout (checkout_file), at most cap bytes; None when it is not one."""
    f = checkout_file(root, rel)
    if f is None:
        return None
    try:
        with open(f, "rb") as fh:
            return fh.read(cap).decode("utf-8", errors="replace")
    except OSError:
        return None


def repo_rules(root, budget=RULE_BUDGET):
    """The repo's own rules from the checkout: CLAUDE.md, AGENTS.md, CONTRIBUTING.md, .github instructions (each
    capped), then ADR titles and status/decision sections (docs/adr, adr), all within `budget` characters, plus the
    global conventions from the settings. Text for the prompt; '' parts are skipped."""
    root = pathlib.Path(root) if root else None
    parts = []
    if root and root.is_dir():
        # Only regular files inside the checkout (read_checkout): a rules file that is a symlink is skipped.
        files = [*RULE_FILES, *sorted(f.relative_to(root).as_posix() for f in (root / ".github").glob("**/*instructions*.md"))]
        for rel in files:
            text = read_checkout(root, rel)
            if text is not None:
                parts.append(f"### {rel}\n{text.strip()[:FILE_BUDGET]}")
        for d in ("docs/adr", "adr", "docs/decisions"):
            for f in sorted((root / d).glob("*.md"))[-30:]:  # ponytail: the 30 newest by name; ADRs are numbered
                text = read_checkout(root, f.relative_to(root).as_posix())
                if text is not None:
                    parts.append(f"### {f.relative_to(root)}\n{adr_digest(text)}")
    g = global_rules()
    out = [f"### Global conventions\n{g}"] if g else []
    used = len(g)
    for p in parts:
        if used + len(p) > budget:
            out.append(f"(… {len(parts) - len(out) + (1 if g else 0)} more rule files cut)")
            break
        out.append(p)
        used += len(p)
    return "\n\n".join(out)


GENERIC = {"index", "main", "utils", "util", "__init__", "mod", "lib", "types", "test", "tests", "config", "readme", "package", "app", "base", "common"}


def blast_candidates(root, paths, limit=15):
    """Files that name a changed file's module (git grep on its stem), outside the diff: real upstream candidates for
    the blast radius, so the model need not guess. [(file, stem)]."""
    if not root or not pathlib.Path(root).is_dir():
        return []
    changed, out = set(paths), []
    for path in paths:
        stem = pathlib.PurePath(path).stem
        if len(stem) < 4 or stem.lower() in GENERIC:
            continue
        r = subprocess.run(["git", "grep", "-l", "-F", "-w", stem], cwd=root, capture_output=True, text=True, timeout=30)
        for f in [x for x in r.stdout.splitlines() if x not in changed][:5]:
            if (f, stem) not in out:
                out.append((f, stem))
        if len(out) >= limit:
            break
    return out[:limit]


def previous_digest(prev):
    """The analysis shown so far, compact: title, summary, each step's title and why."""
    a = prev.get("answer") or {}
    return "\n".join([f"Title: {a.get('title', '')}", f"Summary: {a.get('summary', '')}",
                      *(f"- {s.get('title', '')}: {s.get('why_it_matters', '')}" for s in a.get("steps") or []),
                      "Requirements (for criteria): " + "; ".join(f"{x.get('id', '')}: {x.get('text', '')}" for x in a.get("asks") or [] if x.get("id")),
                      "Architecture node ids (for breaks): " + ", ".join(str(n.get("id")) for n in (a.get("architecture") or {}).get("nodes") or [])])[:6000]


# The whole-PR parts next to the pictures (also in the merge pass of a big PR).
INVENTORY_TEXT = (
    "components: the inventory of what the team owns after this PR, one row for each thing the PR adds or changes that "
    "someone has to run or maintain, at most 16: name (as in the code or template), kind (e.g. module, function, endpoint, "
    "queue, lambda, job, table, config), status (new or changed), at (file:line), node (the id of its architecture node, when it "
    "is on the picture), operate (what running it needs that this PR does not bring, each a short phrase, e.g. \"no "
    "dead-letter queue\"; empty when nothing). checked: your own report of what you looked at, one row for each of these areas: "
    + ", ".join(AREAS_CODE) + "; each with " + CHECKED_TEXT + ".")


def prompt(hunks, cut, task_text, tools, rules="", candidates=(), previous=None, lang="English", index=None, patches=None):
    text = ("Analyze the diff below thoroughly." + (" You are in a checkout of the PR head and may read (Read, Grep, Glob, "
            "git log/show/blame/diff): check callers, types and surrounding code before you name a suspicious spot, and "
            "name only what you confirmed in the code." if tools else "") +
            f" Write every text field in {lang}." +
            "\n\nsteps: Put all hunks into steps (each hunk in exactly one, related ones together, rather few). Per step: "
            "title (short); risk (high: security, data loss/migrations, auth, concurrency; medium: core logic, API/contract changes; "
            "low: configuration, small things; skim: renames, formatting, generated code, docs; tests are a layer of their own, titled "
            "\"Tests\", never skim and never part of \"Skimmed (low value)\": read what they cover and give the layer the risk of "
            "what they leave untested); why_it_matters (one sentence); "
            "explanation (2-4 sentences: what changes and why); depends_on (the titles of the other layers whose code this "
            "layer calls or whose types it uses, empty when none); reading_order (1, 2, …: the order in which the PR is best "
            "understood); hunks (aliases like h1); check_questions (1-3 concrete questions on what to check in exactly these lines; "
            "at most one for skim); question_files (one entry per check question, in the same order: the path of the file the "
            "question is about when that is exactly one file, else \"\"); suggestions (concrete suspicious lines in these hunks: "
            "hunk, line (the number before the line), side (new for + and context, old for removed lines), severity "
            "(high|medium|low, by the scale of a finding's impact), category (as for findings), text (one sentence that works as a "
            "review comment, see Texts); empty when nothing is confirmed); findings (an architecture review of this layer: problems confirmed in "
            "the code at the level of structure and across files, kept apart from suggestions (single suspicious lines): file, line "
            "(new side), end (optional), category (structure: coupling, boundaries, encapsulation, "
            "responsibilities; security: exposure, auth, secrets, permissions; data: storage, retention, personal data, migrations; "
            "scope: a change unrelated to the intent or requirements of the PR; requirement: something the PR description or "
            "ticket asks for that the code doesn't do; bug; test: changed behavior or a requirement that no test would catch when "
            "it breaks, or a test that passes while the behavior is wrong, in the layer of the tests at the place where the test "
            "belongs, with impact untested and as criteria the requirements it leaves unguarded; availability: a failure that is not contained or not seen, e.g. no retry, timeout, dead-letter queue or alarm, "
            "or one bad input failing a whole batch), " + JUDGED_TEXT + ", title (one line, plain text), detail (2-3 sentences that claim "
            "only what the certainty covers: write an assumed step as an assumption, not as a fact; see Texts), suggestion "
            "(one sentence, a code block may follow; see Texts), "
            "criteria (the ids of the requirements in asks that this finding breaks; empty when it breaks none), breaks "
            "(where it breaks the flow on the architecture picture: node (the id of the node whose code is wrong), or from and to "
            "(the ends of the edge, when the call, event or data between two nodes is what fails or is missing); name it for every "
            "finding whose code is a node or an edge of the picture, leave it out only when the picture has no such place); "
            "one finding per defect: report it once, in the layer and at the line of its cause, and say in detail where else "
            "it shows; two different defects are two findings, also when they sit in the same lines; a line that a finding "
            "already covers is not also a suggestion; "
            "each in the layer whose code it is about; scope and requirement findings point at the line of the unrelated change "
            "or of the gap (where the missing part belongs); no style nits; empty when nothing is confirmed); flows (at most 3, only where it helps: changed or new functions with "
            "function, at (file:line in the new version), inputs (name, type, example), output (type, example), side_effects, calls; "
            "examples concrete and realistic, derived from the code (types, structs, JSON bodies, DTOs, SQL rows, events), at most "
            "12 lines, invent nothing; trace: ONE example input followed through the function like in a debugger: per line path, "
            "line (new side, only lines in the diff), values (\"name = value, name2 = value2\": what parameters, locals and the "
            "return value hold there for the example), at most 12 lines); visuals (pictures of this layer; optional, except for the state "
            "diagram described below, and only when pictures explain more than "
            "text: pick every view that explains something the others don't, usually 1-3, never the same kind twice for the same "
            "thing: kind architecture (components and what changes between them), flow (data/control flow, edges with payload), "
            "sequence (who calls whom in which order; edges in order), state_machine or steps (an ordered procedure); at most 12 "
            "nodes (id, label, changed, note: what changes at this node, at: file:line in the new version), edges (from, to, label, "
            "changed)). state_machine is drawn top to bottom and covers two cases. A state diagram: pick it when the PR changes "
            "how an entity's status or state field evolves (enum statuses, status columns, workflow states); title names the "
            "entity (e.g. \"Loan\"); nodes are its states, transitions (from, to, event, guard, action, changed) are what moves it "
            "between them, back edges and self-transitions allowed; mark the transitions the PR adds or changes. This one is not "
            "optional: a layer whose diff adds or changes a status enum, a table of allowed moves or the function that applies them "
            "gets a state diagram with every state and every allowed move, and also each move the changed code attempts although "
            "the table forbids it (changed, action: what happens then, e.g. \"raises ValueError\"). An orchestration: "
            "pick it for a Step Functions or workflow definition; nodes are its states with type (task, choice, parallel, map, "
            "wait, pass, fail, succeed), states inside a Parallel or Map state have parent (its id) and branch (0, 1, …); "
            "transitions in execution order, a choice's ways labelled with their condition, Catch and Retry as transitions with "
            "error catch or retry (label e.g. \"Retry ×3\"). The steps are layers: group by intent "
            "(e.g. data model, API, emails, UI), reading_order with the foundation first.\n\n" + TEXTS + "\n\nSources: every node, edge, "
            "state and transition in architecture and visuals, and every intent and behavior statement, gets a source: "
            "implemented (in this PR's diff; evidence: file:line in the new version, required), existing (already in the "
            "codebase and unchanged; evidence where known), spec (only described in the PR description, the linked ticket, "
            "ADRs or spec docs, and NOT found in the diff: planned or missing). Never present a spec-only item as implemented: "
            "when you can't point at the diff, use spec.\n\ntitle/summary: the PR in one line and "
            "in 2-3 sentences. what_changed: the change as three short lists of at most three entries each, empty when none; "
            "each entry is one thought in at most twelve words, no list inside it, e.g. \"`consumer.py`: a Lambda that mails from the "
            "queue\": adds (what is new: a module, an endpoint, a queue), changes (what existing code now does differently), runtime "
            "(what changes when it runs: a new call between services, a new permission, a new schedule). read: the paths of the "
            "files outside the diff that you read to check the change. behavior: 2-3 sentences on how the application's behavior changes, also for users (no code). "
            "intent and behavior_points: the PR's intent and its behavior change as single statements (at most 6 each), each "
            "with source and evidence (see Sources). "
            "merge_risk: level (minimal, low, medium, high, critical) and why (one sentence). effort: score 1-5 (1: minutes, 5: hours "
            "of focused work) and why. architecture: the picture of the whole PR: groups (systems, e.g. label \"Web application\", "
            "kind \"Client\"), nodes (id, group, label: its name in the code (the type, module or file, e.g. \"Document (document.rs)\"), never a "
            "paraphrase a reader can't find; description in 1-2 lines, details (markdown, for a reviewer who clicks "
            "the card): one sentence on what the component does in the system as a whole, then 2-4 bullets on what this PR's code "
            "changes in it and how, **bold** for the change, `code` for the file and the new or changed functions and types (an "
            "unchanged node: only the sentence), type such as component, api·service, data, "
            "service, orchestration, status new/changed/unchanged/removed, at: file:line; an orchestrator such as a Step Functions "
            "state machine may list its states in order (name, type task/choice/parallel/map/wait/pass/fail/succeed, calls: the id "
            "of the node a task state invokes, status), each call is then drawn from that state's row), runs_in (for code "
            "without a deployment of its own, a module or library: the ids of the groups or nodes whose processes run it, several "
            "when it runs in several, e.g. a library two functions import; none for a deployed unit), edges (from, to, label: "
            "what happens, e.g. \"Creates invitation\"; draw them in call direction, caller to callee; in_process: true when the "
            "call stays in one process, a plain function call, no network, queue or event between); "
            "when the code or the template opens a way in from outside (a route, a function URL, a public bucket), the caller "
            "and the entry are nodes too (type external and gateway), so the way in is on the picture; at most 12 nodes, empty "
            "lists when the PR touches no architecture. visuals (optional, at most 3): pictures of the whole PR the architecture "
            "doesn't show, same form as a layer's (e.g. a sequence across several layers; a state diagram goes into the layer "
            "that changes the state machine, not here). blast_radius: units (the changed "
            "units: id, label, type, status added/changed/removed, files, spots = number of changed places) and context (unchanged "
            "files that call the change (upstream) or are called by it (downstream): file as an existing path, relation one "
            "sentence, links_to the unit's id); only checked paths, at most 8. " + INVENTORY_TEXT)
    if candidates:
        text += ("\n\nUpstream candidates (found by git grep, they name the module; check them):\n"
                 + "\n".join(f"- {f} (names {stem})" for f, stem in candidates))
    text += ("\n\nrule_checks: Check the PR against the rules below (the ones relevant to this change, at most 20): rule (short), "
             "source (file), status (pass, fail, n/a), where (file:line in the new version, for fail when possible), why (one "
             "sentence). The PR title is in the task.\n\nRules:\n" + (rules or "(none)"))
    if previous:
        text += ("\n\nThis is a FOLLOW-UP ANALYSIS: the diff below holds only the changes since the last review (aliases n1, n2, …). "
                 "steps only for these new changes; summary: what changed since the last review; asks, components: empty lists. "
                 "The analysis so far:\n" + previous)
    if task_text and not previous:
        text += ("\n\nasks: Break the task below into its requirements. Per requirement: id (c1, c2, …), text (short), "
                 "short (its name in at most eight words, e.g. \"one reminder mail per loan\"), "
                 "acceptance (true: the task lists it as an acceptance criterion or in a checklist of requirements; false: you "
                 "derived it from the prose), state (met: the diff does it and no finding breaks it; partly: the diff does some "
                 "of it, or it holds only in some cases; broken: the code for it is in the diff and breaks the rule; not_done: "
                 "nothing in the diff does it), why (one sentence of at most 20 words: the reason for the state, naming the code), hunks, elements "
                 "(ids of the architecture or visual nodes with source spec that this requirement describes, if any). Plus one "
                 "entry with state extra for each change the task doesn't ask for (text: what, why: what it adds, hunks: where, "
                 "acceptance false). Every finding that breaks a requirement names it in criteria, and every requirement with "
                 "state partly, broken or not_done, also one you derived from the prose, is named by at least one finding "
                 "(partly: the finding for the part that "
                 "is missing or wrong; not_done: a requirement finding at the place where the missing part belongs).\n\nTask:\n" + task_text[:8000])
    else:
        text += "\n\nasks: empty list."
    if cut:
        text += f"\n\nCut: {len(cut)} more hunks ({', '.join(cut[:40])}) were too large and are missing here."
    if index:
        inl = {h["alias"] for h in hunks}
        text += ("\n\nScope: the index below lists EVERY hunk of this PR (alias, path, +added/-removed, low = low value). The hunks "
                 "printed in the diff section are inlined; each other one is in " + str(patches) + "/<alias>.patch: read the ones "
                 "that matter with Read and decide how much detail each deserves. Don't read low-value ones (lockfiles, snapshots, "
                 "generated code): put them into one step with skimmed true, title \"Skimmed (low value)\", risk skim, and as "
                 "why_it_matters a one-line summary from the index (e.g. \"lockfile: 214 version bumps\"). Every alias must end up "
                 "in exactly one step.\n\nIndex:\n" + index_text(index, inl))
    return (text + "\n\nDiff (lines: prefix + new, - removed, space context; then the line number):\n"
            + "\n\n".join(f"### {h['alias']} {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in hunks))


# ---- the analysis' own scope for big PRs: every hunk is written to the run's folder with an index; what fits is
# inlined (high value first), the model reads the rest itself; too big for one pass: one pass per cohort (directory),
# then a merge pass for the whole-PR parts. All under the one cap.

INLINE = {"haiku": 60000, "sonnet": 150000, "opus": 150000}  # characters inlined per pass
SPLIT = 3  # cohorts when the high-value hunks exceed SPLIT times what one pass inlines
LOW = re.compile(r"(^|/)([^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum)$|\.snap$|\.min\.(js|css)$|(^|/)(dist|vendor|generated|__generated__)/")


def low_value(path):
    return bool(LOW.search(path or ""))


def hunk_chars(h):
    return len(h["path"]) + len(h["alias"]) + 6 + sum(len(line) + 1 for line in h["lines"])


def write_run(run, hunks):
    """<run>/patches/<alias>.patch for every hunk and <run>/index.json: [{alias, path, add, del, low, chars}]."""
    pdir = pathlib.Path(run) / "patches"
    pdir.mkdir(parents=True, exist_ok=True)
    index = []
    for h in hunks:
        (pdir / f"{h['alias']}.patch").write_text(f"{h['path']}\n" + "\n".join(h["lines"]) + "\n")
        index.append({"alias": h["alias"], "path": h["path"], "add": sum(1 for x in h["lines"] if x.startswith("+")),
                      "del": sum(1 for x in h["lines"] if x.startswith("-")), "low": low_value(h["path"]), "chars": hunk_chars(h)})
    (pathlib.Path(run) / "index.json").write_text(json.dumps(index, indent=1))
    return index


def index_text(index, inlined=()):
    return "\n".join(f"{i['alias']} {i['path']} +{i['add']} -{i['del']}{' low' if i['low'] else ''}{' (inlined)' if i['alias'] in inlined else ''}" for i in index)


def pick_inline(hunks, budget):
    """The hunks inlined into a prompt: high-value ones in diff order while they fit; low-value ones never."""
    out, used = [], 0
    for h in hunks:
        if low_value(h["path"]):
            continue
        size = hunk_chars(h)
        if used + size <= budget:
            out.append(h)
            used += size
    return out


def cohorts_of(hunks, budget, most=6):
    """None when one pass reads it all; else the high-value hunks in cohorts by directory (top two levels), packed to
    about twice what a pass inlines, at most `most` (the smallest merge)."""
    high = [h for h in hunks if not low_value(h["path"])]
    if sum(hunk_chars(h) for h in high) <= SPLIT * budget:
        return None
    groups = {}
    for h in high:
        groups.setdefault("/".join(h["path"].split("/")[:-1][:2]) or ".", []).append(h)
    cohorts = []
    for key in sorted(groups, key=lambda k: -sum(hunk_chars(h) for h in groups[k])):
        g = groups[key]
        target = next((c for c in cohorts if sum(hunk_chars(h) for h in c) + sum(hunk_chars(h) for h in g) <= 2 * budget), None)
        if target is None:
            cohorts.append(list(g))
        else:
            target.extend(g)
    while len(cohorts) > most:
        cohorts.sort(key=lambda c: sum(hunk_chars(h) for h in c))
        cohorts[1].extend(cohorts.pop(0))
    return [sorted(c, key=lambda h: int(h["alias"][1:]) if h["alias"][1:].isdigit() else 0) for c in cohorts]


def pass_budgets(cap, n):
    """n cohort passes and one merge pass under one cap: 70% shared by the cohorts, 30% for the merge."""
    down = lambda x: int(x * 10000) / 10000  # noqa: E731  (rounded down: the sum never exceeds the cap)
    return [down(cap * 0.7 / n)] * n, down(cap * 0.3)


def account(answer, aliases, index):
    """Every alias in exactly one step: duplicates and unknown aliases dropped, the missing ones into the skimmed step
    ("Skimmed (low value)", made when there is none) with a one-line reason. No silent "not analyzed"."""
    steps, seen = answer.get("steps") or [], set()
    for st in steps:
        st["hunks"] = [a for a in st.get("hunks") or [] if a in aliases and not (a in seen or seen.add(a))]
    missing = [a for a in aliases if a not in seen]
    if missing:
        skim = next((st for st in steps if st.get("skimmed")), None)
        if skim is None:
            skim = {"title": "Skimmed (low value)", "risk": "skim", "skimmed": True, "why_it_matters": "", "explanation": "", "reading_order": 999,
                    "hunks": [], "check_questions": []}
            steps.append(skim)
        by = {i["alias"]: i for i in index}
        names = list(dict.fromkeys(by[a]["path"].split("/")[-1] for a in missing if a in by))
        note = f"Not placed in a layer: {len(missing)} {'hunk' if len(missing) == 1 else 'hunks'} ({', '.join(names[:4])}{', …' if len(names) > 4 else ''}), read them yourself."
        skim["why_it_matters"] = f"{skim.get('why_it_matters') or ''} {note}".strip()
        skim["hunks"] += missing
    answer["steps"] = steps
    return answer


def scope_of(answer, index, passes=1):
    """What the run read: {files, detailed, skimmed, why, passes}; skimmed files are those only in skimmed steps."""
    path = {i["alias"]: i["path"] for i in index}
    files = set(path.values())
    detail = {path[a] for st in answer.get("steps") or [] if not st.get("skimmed") for a in st.get("hunks") or [] if a in path}
    skimmed = files - detail
    why = "low value" if skimmed and all(low_value(f) for f in skimmed) else "skimmed" if skimmed else ""
    if skimmed and all(re.search(r"\.lock$|lock\.(json|yaml)$|go\.sum$", f) for f in skimmed):
        why = "lockfiles"
    return {"files": len(files), "detailed": len(detail), "skimmed": len(skimmed), "why": why, "passes": passes}


# ---- after the model: ids, the severity scale, and the links between requirements, findings and the picture. Every
# field made here is optional for the UI: an analysis cached before them loads without.

def fnv(text):
    """pr.js hash(): FNV-1a, 32 bit, hex, over UTF-16 code units."""
    h, raw = 0x811C9DC5, text.encode("utf-16-le")
    for i in range(0, len(raw), 2):
        h = ((h ^ int.from_bytes(raw[i:i + 2], "little")) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def judge(f, breaks_requirement=False):
    """A finding's severity by the fixed scale: from its impact (a finding that breaks a requirement is high; a gap in
    the tests leaves it unguarded, which is "untested"). One without an impact (an older analysis, a review turned
    from text) keeps its own. Unknown enum values go."""
    for key, allowed in (("impact", SCALE), ("category", CATEGORIES), ("certainty", CERTAINTY), ("effort", EFFORT), ("path_certainty", CERTAINTY)):
        if f.get(key) not in allowed:
            f.pop(key, None)
    if not isinstance(f.get("introduced_here"), bool):
        f.pop("introduced_here", None)
    if "path_certainty" not in f:
        f.pop("path_why", None)
    if f.get("category") == "test" and f.get("impact"):
        f["impact"] = "untested"
    elif breaks_requirement and SCALE.get(f.get("impact")) != "high":
        f["impact"] = "breaks_requirement"
    f["severity"] = SCALE.get(f.get("impact")) or (f["severity"] if f.get("severity") in LEVELS else "medium")
    return f


def checked(rows, areas):
    """A run's self-report as one row per area, in the areas' order: [{area, result, note}]; an area the model left out
    is not_checked."""
    by = {r.get("area"): r for r in rows or [] if isinstance(r, dict)}
    return [{"area": a, "result": by.get(a, {}).get("result") if by.get(a, {}).get("result") in RESULTS else "not_checked",
             "note": str(by.get(a, {}).get("note") or "")} for a in areas]


def code_owners(root):
    """The CODEOWNERS rules of a checkout, in file order: [(pattern, owners)]; None when it has no such file."""
    for name in (".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"):
        text = read_checkout(root, name)
        if text is not None:
            rows = [line.split("#")[0].split() for line in text.splitlines()]
            return [(r[0], " ".join(r[1:])) for r in rows if r]
    return None


def owner_of(path, rules):
    """The owners of the last rule that matches path ("" when none does, or the rule names nobody).
    ponytail: fnmatch globs, so * also crosses folders; no negation, no escapes. Enough to name an owner; the full
    gitignore matching when a repo's rules need it."""
    import fnmatch
    found = ""
    for pattern, who in rules or []:
        p = pattern.strip("/")
        ways = [p, f"{p}/*"] if pattern.startswith("/") or "/" in p else [p, f"{p}/*", f"*/{p}", f"*/{p}/*"]
        if any(fnmatch.fnmatchcase(path, w) for w in ways):
            found = who
    return found


def runs_in_of(node):
    """A node's runs_in as a list: [] without one, a single id (an older analysis) as a list of one."""
    r = node.get("runs_in")
    return [r] if isinstance(r, str) and r else [str(x) for x in r] if isinstance(r, list) else []


def _reaches(runs, start, goal):
    """Whether goal is reachable from start along runs_in (breadth-first, each node once)."""
    seen, todo = set(), [start]
    while todo:
        cur = todo.pop()
        if cur == goal:
            return True
        if cur in seen or cur not in runs:
            continue
        seen.add(cur)
        todo += runs_in_of(runs[cur])
    return False


def place(answer):
    """Each finding's place on the architecture picture checked against it: breaks {node} or {from, to, edge: the
    UI's edge id e<k>}; a place the picture doesn't have is dropped. Also after a diagram refresh (new picture)."""
    arch = answer.get("architecture") or {}
    nodes = {n.get("id") for n in arch.get("nodes") or []}
    edges = {(e.get("from"), e.get("to")): f"e{k}" for k, e in reversed(list(enumerate(arch.get("edges") or [])))}
    for f in (f for st in answer.get("steps") or [] for f in st.get("findings") or []):
        b = f.pop("breaks", None) or {}
        if b.get("node") in nodes:
            f["breaks"] = {"node": b["node"]}
        elif (b.get("from"), b.get("to")) in edges:
            f["breaks"] = {"from": b["from"], "to": b["to"], "edge": edges[(b["from"], b["to"])]}
    for row in answer.get("components") or []:
        if row.get("node") not in nodes:
            row.pop("node", None)
    groups = {g.get("id") for g in arch.get("groups") or []}
    for n in arch.get("nodes") or []:  # runs_in: groups or other nodes (a list; an older single id becomes one), else none
        hosts = [h for h in dict.fromkeys(runs_in_of(n)) if h in (nodes | groups) - {n.get("id")}]
        if hosts:
            n["runs_in"] = hosts
        else:
            n.pop("runs_in", None)
    runs = {n.get("id"): n for n in arch.get("nodes") or []}
    reaches = lambda a, b: _reaches(runs, a, b)  # noqa: E731
    for n in arch.get("nodes") or []:  # and no cycle (a -> b -> a): a host that leads back to the node goes
        if n.get("runs_in"):
            n["runs_in"] = [h for h in n["runs_in"] if not reaches(h, n.get("id"))]
            if not n["runs_in"]:
                n.pop("runs_in", None)
    for e in arch.get("edges") or []:
        if not isinstance(e.get("in_process"), bool):
            e.pop("in_process", None)


def seat_state_diagrams(answer, path_of):
    """A state diagram belongs to the layer that changes the state machine. One the model put at the level of the
    whole PR or into another layer moves to the layer whose hunks hold the file most of its evidence points at
    (nodes' at, transitions' evidence; path_of: {hunk alias: path}). Without evidence or such a layer it stays."""
    steps = answer.get("steps") or []
    for holder in [answer, *steps]:
        for v in [v for v in holder.get("visuals") or [] if v.get("kind") == "state_machine"]:
            seen = [str(x[k]).rsplit(":", 1)[0].removeprefix("./") for x in [*(v.get("nodes") or []), *(v.get("edges") or []), *(v.get("transitions") or [])]
                    for k in ("at", "evidence") if x.get(k)]
            top = max(dict.fromkeys(seen), key=seen.count, default=None)
            target = next((s for s in steps if any(path_of.get(a) == top for a in s.get("hunks") or [])), None)
            if target is not None and target is not holder:
                holder["visuals"].remove(v)
                target.setdefault("visuals", []).append(v)


OLD_STATE = {"seen": "met", "partly": "partly", "absent": "not_done", "extra": "extra"}  # coverage of older analyses
COVERAGE = {"met": "seen", "partly": "partly", "broken": "absent", "not_done": "absent", "extra": "extra"}


def changed_lines(hunks):
    """{path: the new-side line numbers the diff adds} from hunks [{path, lines}]."""
    out = {}
    for h in hunks:
        new = 0
        for line in h.get("lines") or []:
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            if m:
                new = int(m[1])
            elif line[:1] == "+":
                out.setdefault(h["path"], set()).add(new)
                new += 1
            elif line[:1] == " ":
                new += 1
    return out


def introduced(f, changed, breaks_requirement=False):
    """introduced_here from the diff where it can tell (changed: {path: added line numbers}, None when unknown): a
    finding whose lines the PR adds is the PR's, and so is one that breaks a requirement of this PR, also in old lines
    (an old status write that the PR's new rule forbids). Otherwise the model's word, and without one true (a blocker
    stays one)."""
    path, line = str(f.get("file") or "").strip().removeprefix("./"), int(f.get("line") or 0)
    end = max(line, int(f.get("end") or line))  # the model's end: compared with, never enumerated
    if breaks_requirement or changed is not None and line and any(line <= n <= end for n in changed.get(path, ())):
        f["introduced_here"] = True
    elif not isinstance(f.get("introduced_here"), bool):
        f["introduced_here"] = True
    return f


def finish(answer, root=None, path_of=None, changed=None):
    """The answer made consistent, in place. Requirements (asks): id, state (older ones: from coverage), coverage (from
    state, for readers of the older field), findings (ids of the findings that break it; a "met" one with findings is
    partly). answer.unlinked: the ids of the requirements that are partly, broken or not_done although no finding names
    them (the model owes one; the UI can say so instead of showing an empty list). Findings: id (the UI's: "a" + fnv(category|file|title)), severity by the scale (judge), criteria only
    those asks has, breaks only when the picture has it (place). A layer's depends_on: only titles of other layers.
    Check questions: question_files as long as the
    questions, a path only when it is a file of the diff (path_of: {hunk alias: path}) or the checkout. State diagrams
    sit in the layer of their state machine (seat_state_diagrams). Components: owner from CODEOWNERS (None:
    nobody), and component_counts {new, changed, no_owner, codeowners: the repo has such a file}. Each finding's
    introduced_here (introduced(); changed: changed_lines() of the whole diff, None in a follow-up analysis). A
    requirement's short name has at most eight words.
    ponytail: a big PR's cohort passes don't know the requirements or the picture, so their findings carry no
    criteria and no breaks; let the merge pass assign them when big PRs need the links."""
    asks, path_of = answer.get("asks") or [], path_of or {}
    paths = set(path_of.values())
    seat_state_diagrams(answer, path_of)
    for k, a in enumerate(asks, 1):
        a["id"] = str(a.get("id") or f"c{k}")
        a["state"] = a["state"] if a.get("state") in ASK_STATES else OLD_STATE.get(a.get("coverage"), "not_done")
        if a.get("short"):
            a["short"] = " ".join(str(a["short"]).split()[:8])
        a["findings"] = []
    by_id = {a["id"]: a for a in asks}
    root = pathlib.Path(root) if root else None
    titles = {st.get("title") for st in answer.get("steps") or []}
    for st in answer.get("steps") or []:
        files = [str(x or "").strip().removeprefix("./") for x in st.get("question_files") or []]
        known = lambda f: f in paths or bool(root and f and checkout_file(root, f))  # noqa: E731
        st["question_files"] = [files[k] if k < len(files) and known(files[k]) else "" for k in range(len(st.get("check_questions") or []))]
        if "depends_on" in st:
            st["depends_on"] = [x for x in dict.fromkeys(st["depends_on"] or []) if x in titles and x != st.get("title")]
        for f in st.get("findings") or []:
            f["criteria"] = [c for c in dict.fromkeys(f.get("criteria") or []) if c in by_id]
            mine = any(by_id[c]["state"] != "extra" for c in f["criteria"])
            judge(f, mine)
            introduced(f, changed, mine)
            f["id"] = "a" + fnv(f"{f.get('category') or 'structure'}|{str(f.get('file') or '').strip().removeprefix('./')}|{str(f.get('title') or '').strip()}")
            for c in f["criteria"]:
                if f["id"] not in by_id[c]["findings"]:
                    by_id[c]["findings"].append(f["id"])
    for a in asks:
        if a["findings"] and a["state"] == "met":
            a["state"] = "partly"
        a["coverage"] = COVERAGE[a["state"]]
    answer["unlinked"] = [a["id"] for a in asks if a["state"] in ("partly", "broken", "not_done") and not a["findings"]]
    place(answer)
    comps = answer.get("components")
    if comps is not None:
        rules = code_owners(root)
        for c in comps:
            c["owner"] = owner_of(str(c.get("at") or "").rsplit(":", 1)[0].removeprefix("./"), rules) or None
        count = lambda test: sum(1 for c in comps if test(c))  # noqa: E731
        answer["component_counts"] = {"new": count(lambda c: c.get("status") == "new"), "changed": count(lambda c: c.get("status") == "changed"),
                                      "no_owner": count(lambda c: not c["owner"]), "codeowners": rules is not None}
    return answer


COHORT_SCHEMA = {"type": "object", "required": ["summary", "steps"], "properties": {"summary": S, "steps": SCHEMA["properties"]["steps"]}}
MERGE_SCHEMA = {"type": "object", "required": [k for k in SCHEMA["required"] if k != "steps"] + ["reading_order"],
                "properties": {**{k: v for k, v in SCHEMA["properties"].items() if k != "steps"}, "reading_order": {"type": "array", "items": {"type": "integer"}}}}


def progress(req, k, n):
    if req.get("status"):
        save(req["status"], {"busy": True, "pid": os.getpid(), "started": req.get("started") or dt.datetime.now().astimezone().isoformat(),
                             "model": req["model"], "pass": k, "passes": n})


def span(header):
    """A hunk header's new-side lines [first, last] (an only-removing hunk: the line it sits after)."""
    m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?", header or "")
    if not m:
        return 0, -1
    first, n = int(m[1]), 1 if m[2] is None else int(m[2])
    return first, first + max(n, 1) - 1


def merge_incremental(prev, answer, inc, full):
    """An analysis of only the changes since the last review merged into the one shown so far, for today's whole diff.
    prev: that saved analysis; answer: the model's on the new hunks inc [{alias n1.., path, lines}]; full: today's PR
    diff hunks [{alias, id, path, head}]. Previous steps point at the same hunk ids (gone ones keep their id under an
    alias o<k>, so they show as outdated); new steps point at today's hunks overlapping their new lines, are marked
    new and go first in reading order. Suggestions follow their hunk (new-side lines only); findings (file and line, no
    hunk) stay in their step: old layers keep theirs, new layers bring their own. Returns (hunks, answer).
    ponytail: merge risk, effort, rules and pictures stay the previous ones (they judged the whole PR)."""
    alias_of = {h["id"]: h["alias"] for h in full}
    hunks = [{"alias": h["alias"], "id": h["id"]} for h in full]
    old = {}
    for k, h in enumerate(prev.get("hunks") or [], 1):
        if h["id"] in alias_of:
            old[h["alias"]] = alias_of[h["id"]]
        else:
            old[h["alias"]] = f"o{k}"
            hunks.append({"alias": f"o{k}", "id": h["id"]})
    spans = [(h["alias"], h["path"], *span(h["head"])) for h in full]
    inc_by = {h["alias"]: (h["path"], *span(h["lines"][0] if h.get("lines") else "")) for h in inc}

    def overlapping(alias):
        if alias not in inc_by:
            return []
        path, a, b = inc_by[alias]
        return [fa for fa, fp, x, y in spans if fp == path and x <= max(a, b) and a <= y]

    def at_line(alias, line):
        path = inc_by.get(alias, (None,))[0]
        return next((fa for fa, fp, x, y in spans if fp == path and x <= line <= y), None)

    def remap_old(step):
        sugs = [{**g, "hunk": old[g["hunk"]]} for g in step.get("suggestions") or [] if g.get("hunk") in old]
        return {**step, "hunks": [old[a] for a in step.get("hunks") or [] if a in old], "suggestions": sugs}

    def remap_new(step):
        hs = list(dict.fromkeys(fa for a in step.get("hunks") or [] for fa in overlapping(a)))
        sugs = [{**g, "hunk": at_line(g["hunk"], g["line"])} for g in step.get("suggestions") or [] if g.get("side") != "old"]
        return {**step, "hunks": hs, "suggestions": [g for g in sugs if g["hunk"]], "new": True,
                "reading_order": int(step.get("reading_order") or 1) - 1000}

    a = prev.get("answer") or {}
    merged = {**a, "steps": [remap_new(x) for x in answer.get("steps") or []] + [remap_old(x) for x in a.get("steps") or []],
              "asks": [{**x, "hunks": [old[h] for h in x.get("hunks") or [] if h in old]} for x in a.get("asks") or []],
              "summary": f"{a.get('summary', '')}\n\n**Since the last review:** {answer.get('summary', '')}".strip()}
    return hunks, merged


# ---- Refresh diagrams: only the pictures again (architecture, the PR's and each layer's visuals, with sources), for
# today's diff, with the shown analysis' layers as context. The text analysis stays as it is.

DIAGRAMS_SCHEMA = {"type": "object", "required": ["architecture", "layers"], "properties": {
    "architecture": ARCHITECTURE, "visuals": VISUALS,
    "layers": {"type": "array", "items": {"type": "object", "required": ["layer", "visuals"], "properties": {
        "layer": {"type": "integer"}, "visuals": VISUALS}}}}}


def picture_guide(lang):
    """The full prompt's guidance on pictures and sources (sliced out of it, so both prompts say the same)."""
    full = prompt([], [], None, False, lang=lang)
    cut = lambda a, b: full[full.index(a):full.index(b, full.index(a))]  # noqa: E731
    return "\n\n".join([cut("visuals (pictures of this layer", " The steps are layers"), cut("Sources:", "\n\ntitle/summary"),
                         cut("architecture: the picture", " blast_radius:")])


def diagrams_prompt(hunks, prev, task_text, tools, lang="English"):
    a = prev.get("answer") or {}
    layers = "\n".join(f"{k}. {x.get('title', '')}: {x.get('explanation', '')} (hunks {', '.join(x.get('hunks') or [])})"
                       for k, x in enumerate(a.get("steps") or []))
    return ("Draw the pictures of this pull request again from the diff below: architecture, visuals for the whole PR, and "
            "per layer (by its number) its visuals. Only the pictures: the layers and texts stay as they are." +
            (" You are in a checkout of the PR head and may read it to check what exists." if tools else "") +
            f" Write every text field in {lang}.\n\n" + picture_guide(lang) +
            f"\n\nTitle: {a.get('title', '')}\nSummary: {a.get('summary', '')}\n\nLayers:\n{layers}" +
            "\n\nKeep the id of every architecture node that stays (ids so far: "
            + (", ".join(str(n.get("id")) for n in (a.get("architecture") or {}).get("nodes") or []) or "none") + "): findings point at them." +
            ("\n\nTask (PR description and ticket; what is only here is spec):\n" + task_text[:8000] if task_text else "") +
            "\n\nDiff:\n" + "\n\n".join(f"### {h['alias']} {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in hunks))


def merge_diagrams(prev, answer, head, meta, path_of=None):
    """The saved analysis with only its pictures replaced: architecture, the PR's visuals, each layer's visuals (by
    number; a layer the answer leaves out keeps none). Text, layers, asks stay. diagrams: when, for which head."""
    a = dict(prev.get("answer") or {})
    per = {int(x.get("layer", -1)): x.get("visuals") or [] for x in answer.get("layers") or []}
    a["architecture"] = answer.get("architecture") or {"groups": [], "nodes": [], "edges": []}
    a["visuals"] = answer.get("visuals") or []
    a["steps"] = [{**{k: v for k, v in x.items() if k != "visual"}, "visuals": per.get(k, [])} for k, x in enumerate(a.get("steps") or [])]
    seat_state_diagrams(a, path_of or {})
    place(a)
    return {**prev, "answer": a, "diagrams": {"generated": dt.datetime.now().astimezone().isoformat(), "head": head,
                                              "model": meta.get("model_id"), "cost": meta.get("cost")}}


def main_diagrams(req):
    """req: {diagrams: the analysis file to refresh, also: other files holding the same analysis, head, model, context,
    pr, worktree, hunks, status}."""
    model, ctx, wt, lang = req["model"], req.get("context"), req.get("worktree"), llm.language()
    prev = json.loads(pathlib.Path(req["diagrams"]).read_text())
    t = task(req.get("pr"), (ctx or {}).get("tickets", True))
    tools = bool(wt and pathlib.Path(wt).is_dir())
    extra = permissions(wt, "Read", "Grep", "Glob") if tools else ()
    meta = {}
    answer = llm.claude(FEATURE_DIAGRAMS, git_hint(wt if tools else None) + diagrams_prompt(req["hunks"], prev, t and t["text"], tools, lang), context=ctx, model=model,
                        schema=DIAGRAMS_SCHEMA, system=SYSTEM.format(lang=lang), budget=BUDGET_DIAGRAMS[llm.tier(model)], timeout=TIMEOUT,
                        cwd=wt if tools else pathlib.Path.home(), tools="Read,Grep,Glob,Bash" if tools else "", meta=meta, extra=extra)
    if not answer:
        raise RuntimeError(f"{FEATURE_DIAGRAMS}: no answer")
    result = merge_diagrams(prev, answer, req.get("head"), meta, {h["alias"]: h["path"] for h in req["hunks"]})
    for path in [req["diagrams"], *(req.get("also") or [])]:  # only files that still hold this analysis
        try:
            same = json.loads(pathlib.Path(path).read_text()).get("generated") == prev.get("generated")
        except (OSError, ValueError):
            same = False
        if same:
            save(path, result)
    return {"cost": meta.get("cost"), "ms": meta.get("ms"), "model_id": meta.get("model_id", model)}


# ---- Ask about this: one question on the architecture (or a layer's pictures), with a short thread. The answer is text
# plus the picture's node and edge ids it is about and the places that back it. Sync: prints the answer as JSON.

FEATURE_ASK = "Review: architecture question"
BUDGET_ASK = {"haiku": 0.3, "sonnet": 1.0, "opus": 3.0}
ASK_SCHEMA = {"type": "object", "required": ["text", "highlights", "evidence"], "properties": {
    "text": S, "highlights": {"type": "object", "required": ["nodes", "edges"], "properties": {"nodes": STRINGS, "edges": STRINGS}},
    "evidence": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["at"], "properties": {"at": S, "why": S}}}}}


def deep_context(req):
    """What the ask and drill calls share: the analysis in short, the picture (nodes, edges e0.. with evidence), the
    focus (a node with its edges, a layer, or the whole picture) and the relevant diff hunks."""
    a = req.get("analysis") or {}
    layers = "\n".join(f"- {x.get('title', '')}: {x.get('why', '')}" for x in a.get("layers") or [])
    hunks = "\n\n".join(f"### {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in req.get("hunks") or [])
    what = "the existing code (no PR)" if req.get("explore") else "a pull request"
    return (f"This is about {what}.\nAnalysis: {a.get('title', '')}\n{a.get('summary', '')}\nLayers:\n{layers or '(none)'}\n\n"
            f"Picture (architecture; edges by id):\n{json.dumps(req.get('picture') or {}, ensure_ascii=False)}\n\n"
            f"Focus:\n{json.dumps(req.get('scope') or {'kind': 'picture'}, ensure_ascii=False)}"
            + (f"\n\nDiff hunks (lines: prefix + new, - removed; then the line number):\n{hunks}" if hunks else ""))


def ask_prompt(req, tools, lang="English"):
    turns = "\n\n".join(f"Q: {t.get('q', '')}\nA: {t.get('a', '')}" for t in req.get("history") or [])
    return (f"Answer the question below in {lang}, briefly (at most 8 sentences, markdown allowed), about the focus when "
            "there is one." + (" You may read the code (Read, Grep, Glob) to check before you answer; claim only what you "
            "confirmed." if tools else "") +
            " highlights: the ids of the picture's nodes and edges (e0, e1, …) your answer is about (empty when none). "
            "evidence: file:line places that back the answer, each with why (one short phrase).\n\n" + deep_context(req)
            + (f"\n\nEarlier in this thread:\n{turns}" if turns else "") + f"\n\nQuestion: {req['ask']}")


def read_tools(root):
    """Read-only tools in root (the PR head checkout or the explored repo), or none."""
    if not (root and pathlib.Path(root).is_dir()):
        return {"tools": "", "cwd": pathlib.Path.home(), "extra": ()}
    return {"tools": "Read,Grep,Glob", "cwd": root, "extra": ("--restricted", "--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Glob",
                                                              "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash")}


def main_ask(req):
    model, lang, rt = req["model"], llm.language(), read_tools(req.get("root"))
    meta = {}
    answer = llm.claude(FEATURE_ASK, ask_prompt(req, bool(rt["tools"]), lang), context=req.get("context"), model=model, schema=ASK_SCHEMA,
                        system=SYSTEM.format(lang=lang), budget=BUDGET_ASK[llm.tier(model)], timeout=TIMEOUT, cwd=rt["cwd"], tools=rt["tools"],
                        meta=meta, extra=rt["extra"])
    if not answer:
        raise RuntimeError(f"{FEATURE_ASK}: no answer")
    return {"answer": answer, "cost": meta.get("cost"), "ms": meta.get("ms"), "model_id": meta.get("model_id", model)}


# ---- Show details: one card (or layer) from the inside: its functions and classes and how data flows through them,
# with sample values like a debugger's and where each is. Sync: prints the sub-diagram as JSON.

FEATURE_DRILL = "Review: drill down"
BUDGET_DRILL = {"haiku": 0.5, "sonnet": 1.5, "opus": 4.0}
DRILL_NODE = {"type": "object", "required": ["id", "label"], "properties": {
    "id": S, "label": S, "note": S, "values": S, "at": S, "changed": {"type": "boolean"}, "type": {"enum": STATE_TYPES}, "source": SOURCE, "evidence": S}}
DRILL_SCHEMA = {"type": "object", "required": ["summary", "visual"], "properties": {
    "summary": S, "visual": {"type": "object", "required": ["kind", "title", "nodes", "edges"], "properties": {
        "kind": {"enum": ["flow", "sequence", "state_machine"]}, "title": S,
        "nodes": {"type": "array", "maxItems": 12, "items": DRILL_NODE}, "edges": {"type": "array", "maxItems": 16, "items": TRANSITION},
        "transitions": {"type": "array", "maxItems": 16, "items": TRANSITION}}}}}


def drill_prompt(req, tools, lang="English"):
    d = req["drill"]
    path = " › ".join(d.get("path") or [])
    return (f"Show the inside of {d.get('label', 'this component')} ({path}) in {lang}: its functions, classes or steps and how "
            "data flows through them, as one picture. Pick the kind that explains it best: flow (data and calls, edges with what "
            "is passed), sequence (who calls whom in order) or state_machine (how a status moves). At most 12 nodes: id, label "
            "(e.g. sendDueReminders()), note (what it does, one line), values (sample values at that point, like a debugger: "
            "\"loan = {id: 7, dueAt: 2026-03-12}, sent = 0\"; derived from the code, invent nothing), at (file:line), changed "
            "(touched by the change), source (implemented, existing or spec) and evidence (file:line). Edges: from, to, label "
            "(the payload), changed. summary (markdown): one sentence on what it does in the system as a whole, then 2-4 bullets on "
            "what the new code of this change does in it and how, **bold** for the change, `code` for files and functions." +
            (" Read the code (Read, Grep, Glob) to find the real functions and lines; claim only what you read." if tools else "") +
            "\n\nWhat to open up:\n" + json.dumps(d.get("subject") or {}, ensure_ascii=False) + "\n\n" + deep_context(req))


def main_drill(req):
    model, lang, rt = req["model"], llm.language(), read_tools(req.get("root"))
    meta = {}
    answer = llm.claude(FEATURE_DRILL, drill_prompt(req, bool(rt["tools"]), lang), context=req.get("context"), model=model, schema=DRILL_SCHEMA,
                        system=SYSTEM.format(lang=lang), budget=BUDGET_DRILL[llm.tier(model)], timeout=TIMEOUT, cwd=rt["cwd"], tools=rt["tools"],
                        meta=meta, extra=rt["extra"])
    if not answer:
        raise RuntimeError(f"{FEATURE_DRILL}: no answer")
    return {"answer": answer, "cost": meta.get("cost"), "ms": meta.get("ms"), "model_id": meta.get("model_id", model)}


def save(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    tmp.replace(path)


def main(req):
    model, ctx, wt, lang = req["model"], req.get("context"), req.get("worktree"), llm.language()
    t = task(req.get("pr"), (ctx or {}).get("tickets", True))
    tools = bool(wt and pathlib.Path(wt).is_dir())
    prev = json.loads(pathlib.Path(req["previous"]).read_text()) if req.get("previous") else None
    hunks = req["hunks"]
    paths = list(dict.fromkeys(h["path"] for h in hunks))
    candidates = blast_candidates(wt, paths) if tools else []
    run = req.get("run") or str(pathlib.Path(req["out"]).with_suffix("")) + ".run"
    index = write_run(run, hunks)
    cap, aliases = BUDGET[llm.tier(model)], [h["alias"] for h in hunks]
    # Read-only tools in the checkout plus the run's folder (the patches); without a checkout, only the folder.
    extra = ("--effort", "high", "--add-dir", run, *permissions(wt if tools else None, "Read", "Grep", "Glob"))
    call = lambda feature, text, schema, budget, meta: llm.claude(feature, git_hint(wt if tools else None) + text, context=ctx, model=model, schema=schema, system=SYSTEM.format(lang=lang),  # noqa: E731
                                                              budget=budget, timeout=TIMEOUT, cwd=wt if tools else run, tools="Read,Grep,Glob,Bash", meta=meta, extra=extra)
    cohorts = None if prev else cohorts_of(hunks, INLINE[llm.tier(model)])
    metas = []
    if not cohorts:
        meta = {}
        text = prompt(pick_inline(hunks, INLINE[llm.tier(model)]), [], t and t["text"], True, rules=repo_rules(wt), candidates=candidates,
                      previous=prev and previous_digest(prev), lang=lang, index=index, patches=pathlib.Path(run) / "patches")
        answer = call(FEATURE_INC if prev else FEATURE, text, SCHEMA, cap, meta)
        metas.append(meta)
        if not answer:
            raise RuntimeError(f"{FEATURE}: no answer")
    else:
        answer = analyze_cohorts(req, cohorts, hunks, index, run, t, candidates, wt, lang, call, metas)
    account(answer, aliases, index)
    if tools:  # only context files that exist: no invented callers
        blast = answer.get("blast_radius") or {}
        blast["context"] = [c for c in blast.get("context") or [] if checkout_file(wt, c.get("file", ""))]
    scope = scope_of(answer, index, passes=len(cohorts) + 1 if cohorts else 1)
    out_hunks = [{"alias": h["alias"], "id": h["id"]} for h in hunks]
    scope["checked"] = checked(answer.pop("checked", None), AREAS_CODE)
    if prev:
        out_hunks, answer = merge_incremental(prev, answer, hunks, req["full"])
    paths = {h["path"] for h in (req["full"] if prev else hunks)}
    scope["read"] = [p for p in dict.fromkeys(str(x).strip().removeprefix("./") for x in answer.pop("read", None) or [])
                     if p and p not in paths and (not tools or checkout_file(wt, p))]
    finish(answer, wt if tools else None, {h["alias"]: h["path"] for h in (req["full"] if prev else hunks)}, None if prev else changed_lines(hunks))
    cost = sum(m.get("cost") or 0 for m in metas) if any(m.get("cost") is not None for m in metas) else None
    result = {"source": req.get("source") or req.get("pr"), "model": model, "model_id": next((m["model_id"] for m in metas if m.get("model_id")), model),
              "hunks": out_hunks, "answer": answer, "incremental": req.get("since") if prev else None, "cut": [], "scope": scope,
              "cost": cost, "usage": {k: sum((m.get("usage") or {}).get(k) or 0 for m in metas) for k in ("input", "output", "cache_read", "cache_write")},
              "ms": sum(m.get("ms") or 0 for m in metas), "budget": cap,
              "task": {k: t[k] for k in ("title", "jira", "note")} if t else {}, "head": req.get("head"),
              "generated": dt.datetime.now().astimezone().isoformat()}
    save(req["out"], result)
    save(req["latest"], result)
    return result


def analyze_cohorts(req, cohorts, hunks, index, run, t, candidates, wt, lang, call, metas):
    """One pass per cohort (up to 3 at a time), then a merge pass for the whole-PR parts and the reading order. The
    layers are the cohorts' layers; the merge orders them. Progress: "Pass k of n" in the status file."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    n = len(cohorts) + 1
    cb, mb = pass_budgets(BUDGET[llm.tier(req["model"])], len(cohorts))
    patches = pathlib.Path(run) / "patches"

    def one(k):
        c, meta = cohorts[k], {}
        names = {h["alias"] for h in c}
        text = (f"This is pass {k + 1} of {n} over a big pull request: analyze only the hunks of this cohort (the index lists them; "
                "a merge pass draws the whole picture later). Answer with summary (this cohort in 2 sentences) and steps for these "
                "hunks only, following the rules below; architecture, rules and the rest come later.\n\n"
                + prompt(pick_inline(c, INLINE[llm.tier(req["model"])]), [], None, True, lang=lang, index=[i for i in index if i["alias"] in names], patches=patches))
        out = call(f"{FEATURE} (pass {k + 1} of {n})", text, COHORT_SCHEMA, cb[k], meta)
        return k, out or {"summary": "", "steps": []}, meta

    done, results = 0, [None] * len(cohorts)
    progress(req, 1, n)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for fut in as_completed([pool.submit(one, k) for k in range(len(cohorts))]):
            k, out, meta = fut.result()
            results[k] = out
            metas.append(meta)
            done += 1
            progress(req, done + 1, n)
    layers = [st for r in results for st in r.get("steps") or []]
    digest = "\n".join(f"{k}. {st.get('title', '')}: {st.get('why_it_matters', '')} (hunks {', '.join(st.get('hunks') or [])})" for k, st in enumerate(layers))
    meta = {}
    text = (f"This is the merge pass ({n} of {n}) over a big pull request analyzed in {len(cohorts)} cohorts. The layers below are "
            "final; write the whole-PR parts from them, the index and the code (read patches or the checkout where it helps): "
            "title, summary, behavior, merge_risk, effort, rule_checks, architecture, blast_radius, visuals, intent, "
            "behavior_points, what_changed, read, asks (hunks as aliases), components, checked and reading_order (the layer numbers in the "
            f"order the PR is best read). Write every text field in {lang}.\n\n" + picture_guide(lang) + "\n\n" + INVENTORY_TEXT +
            "\n\nLayers:\n" + digest +
            "\n\nCohort summaries:\n" + "\n".join(f"- {r.get('summary', '')}" for r in results) +
            (("\n\nUpstream candidates (git grep):\n" + "\n".join(f"- {f} (names {stem})" for f, stem in candidates)) if candidates else "") +
            "\n\nRules:\n" + (repo_rules(wt) or "(none)") +
            ("\n\nTask:\n" + t["text"][:8000] if t and t.get("text") else "") +
            "\n\nIndex:\n" + index_text(index))
    merged = call(f"{FEATURE} (merge)", text, MERGE_SCHEMA, mb, meta) or {}
    metas.append(meta)
    order = [k for k in merged.pop("reading_order", []) if isinstance(k, int) and 0 <= k < len(layers)]
    order += [k for k in range(len(layers)) if k not in order]
    for rank, k in enumerate(order, 1):
        layers[k]["reading_order"] = rank
    return {**{k: merged.get(k) for k in MERGE_SCHEMA["required"] if k != "reading_order"}, "steps": layers}

if __name__ == "__main__":
    req = json.loads(pathlib.Path(sys.argv[1][1:]).read_text() if sys.argv[1].startswith("@") else sys.argv[1])
    req["started"] = dt.datetime.now().astimezone().isoformat()
    req["model"] = llm.code_model(req.get("model"))  # analysis, diagrams, Look inside, Ask, drill: never haiku
    status = req.get("status")
    if status:
        save(status, {"busy": True, "pid": os.getpid(), "started": dt.datetime.now().astimezone().isoformat(), "model": req["model"]})
    try:
        if req.get("ask") or req.get("drill"):  # sync calls: the answer on stdout
            print(json.dumps(main_ask(req) if req.get("ask") else main_drill(req), ensure_ascii=False))
            sys.exit(0)
        r = main_diagrams(req) if req.get("diagrams") else main(req)
        if status:
            save(status, {"done": True, "cost": r["cost"], "ms": r["ms"]})
        print(json.dumps({"cost": r["cost"], "model": r["model_id"], "ms": r["ms"]}))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        if status:
            save(status, {"error": str(e)[:500]})
        print(str(e), file=sys.stderr)
        sys.exit(1)
