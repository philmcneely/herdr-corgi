#!/usr/bin/env python3
"""Context around one PR for the review layout, no LLM: related PRs, CI checks, mergeability.

argv[1]: JSON {url, head, base, worktree (a checkout of the repo, or null), files: [paths the PR changes], out}.
Related: the 30 most recently updated other OPEN PRs of the repo that change the same files (gh pr list), and PRs
MERGED into the base in the last 90 days that touched them (git log on the files, PR numbers from merge and squash
subjects). Checks: `gh pr checks`; mergeability: `gh pr view`. A stacked PR: when the base branch is the head branch of
another open PR of the same repo, that PR is stacked_on {number, title, url} and its row in `open` has stacked true (the
merge order is settled, so the overlap is no conflict to agree on). The other way round: an open PR whose base is
this PR's head branch (`branch`) builds on it, is listed in stacked_above and its row in `open` has stacked and above. security_trigger says whether the security reviewer
should start by itself for this diff, decided from the diff alone: {run, reasons: [{file, line, rule, text}], why_not}.
Writes {at, head, open, merged, checks, mergeable, merge_state, stacked_on, stacked_above, security_trigger} to `out` (pr-data/cache,
keyed by PR and head; prs.py --prune bounds that folder) and prints it.
"""
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys

OPEN_LIMIT, MERGED_DAYS, KEEP = 30, 90, 10
PR_NUMBER = re.compile(r"Merge pull request #(\d+)|\(#(\d+)\)\s*$")


def overlap(files, prs):
    """prs [{number, title, files}] that share files with `files`, most shared first: {…, overlap, files: shared}."""
    mine = set(files)
    out = [{**p, "files": sorted(mine & set(p["files"])), "overlap": len(mine & set(p["files"]))} for p in prs]
    return sorted((p for p in out if p["overlap"]), key=lambda p: (-p["overlap"], -p["number"]))[:KEEP]


def stacked_on(base, prs):
    """The open PR whose head branch is `base` (prs [{number, title, url, branch, fork}]; a fork's branch of the same
    name is another branch), or None."""
    return next(({k: p[k] for k in ("number", "title", "url")} for p in prs if base and p.get("branch") == base and not p.get("fork")), None)


def stacked_above(branch, prs):
    """The open PRs whose base branch is `branch` (this PR's head branch): they build on this one."""
    return [{k: p[k] for k in ("number", "title", "url")} for p in prs if branch and p.get("base") == branch]


# ---- Should the security reviewer start by itself? Decided from the diff alone, no model: a wrong yes costs one
# reviewer run, a wrong no leaves a change to permissions or auth unlooked at, so the patterns lean towards yes.

DOCS = re.compile(r"(^|/)docs?/|\.(md|mdx|rst|adoc)$|(^|/)(LICENSE|CHANGELOG|NOTICE|AUTHORS|README)[^/]*$", re.I)
TESTS = re.compile(r"(^|/)(tests?|__tests__|specs?|fixtures|testdata)/|(^|/)test_[^/]*$|[._-](test|spec)\.[a-z]+$", re.I)
DEPS = re.compile(r"(^|/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|poetry\.lock|uv\.lock|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|"
                  r"go\.(mod|sum)|Cargo\.(toml|lock)|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock))$")
INFRA = re.compile(r"(^|/)(template|serverless|samconfig|cloudformation[^/]*|docker-compose[^/]*)\.(ya?ml|json|toml)$|\.(tf|tfvars|hcl|bicep)$|"
                   r"(^|/)Dockerfile[^/]*$|(^|/)(k8s|kubernetes|helm|charts|terraform|infra|infrastructure|deploy|deployment|cdk)/|(^|/)\.github/workflows/", re.I)
# (rule, a pattern on a changed line, what the reason says, added lines only). The first three are for infrastructure
# files, the rest for code; a file gives one reason per rule, at its first matching line.
INFRA_RULES = [
    ("permissions", r"Polic(y|ies)\b|\biam\b|\bEffect\b|\bPrincipal\b|AssumeRole|\bRole\b|\bActions?\b|\bPermissions?\b", "changes IAM policies or permissions", False),
    ("entry", r"HttpApi|Type:\s*Api\b|FunctionUrl|Authorizer|api_?gateway|\bingress\b|LoadBalancer|\blistener\b|\bpublic|0\.0\.0\.0|\bcidr|\bports?\b", "opens or changes a way in from outside", False),
    ("secrets", r"-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(secret|passw(or)?d|token|api[_-]?key)\w*\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']", "adds what looks like a secret", True)]
CODE_RULES = [
    INFRA_RULES[2],
    ("auth", r"authori[sz]|authenticat|\btoken|bearer|passw(or)?d|\bsecret|api[_-]?key|\bjwt\b|hmac|\bsession|\bcookie|csrf|oauth|\blogin\b|permission|is_admin|\bacl\b", "touches auth or token code", False),
    ("route", r"@\w+\.(route|get|post|put|patch|delete)\(|\brouter?\.(get|post|put|patch|delete|use)\(|rawPath|path(_info)?\s*==|def (lambda_)?handler\(|exports\.handler|"
              r"@(Get|Post|Put|Delete|Request)Mapping|HandleFunc\(|add_url_rule|urlpatterns", "adds or changes a route or handler", False),
    ("access", r"\brequests\.|urllib|http\.client|httpx|aiohttp|\bfetch\(|axios|\bsocket\b|subprocess|os\.system|\bexec\(|\beval\(|\bopen\(|pickle|yaml\.load|shell=True|"
               r"child_process|\.execute\(|boto3|createConnection|net\.(Dial|Listen)", "adds network, file, process or database access", True)]


def diff_files(text):
    """`git diff -U0` → [{path, added: [(line number, text)], removed: [text]}]; a deleted file keeps its old path."""
    out, cur, new = [], None, 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            cur = {"path": line.split(" b/", 1)[-1], "added": [], "removed": []}
            out.append(cur)
        elif cur is None or line.startswith(("+++", "---")):
            continue
        elif line.startswith("@@"):
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            new = int(m[1]) if m else 0
        elif line.startswith("+"):
            cur["added"].append((new, line[1:]))
            new += 1
        elif line.startswith("-"):
            cur["removed"].append(line[1:])
        elif line.startswith(" "):
            new += 1
    return out


def security_trigger(files):
    """Whether the security reviewer should start by itself, from the diff alone. files: diff_files(), or
    [{path}] when the diff could not be read (then only the file names count). Returns {run, reasons: [{file, line
    (0: the file as a whole), rule, text: "<file> <what it changes>"}], why_not (a sentence when run is false)}.
    A pure function: the same diff gives the same answer."""
    reasons, known = [], all("added" in f for f in files)
    for f in files:
        path = f["path"]
        if DOCS.search(path) and not DEPS.search(path):
            continue
        if DEPS.search(path):
            reasons.append({"file": path, "line": 0, "rule": "dependencies", "text": f"{path} changes dependencies"})
            continue
        infra = bool(INFRA.search(path))
        if TESTS.search(path) and not infra:
            continue
        found = False
        for rule, pattern, says, added_only in (INFRA_RULES if infra else CODE_RULES):
            rx = re.compile(pattern, re.I)
            lines = [*(f.get("added") or []), *([] if added_only else [(0, x) for x in f.get("removed") or []])]
            hit = next((n for n, x in lines if rx.search(x)), None)
            if hit is not None:
                found = True
                reasons.append({"file": path, "line": hit, "rule": rule, "text": f"{path} {says}"})
        if infra and not found:
            reasons.append({"file": path, "line": 0, "rule": "infrastructure", "text": f"{path} changes infrastructure"})
    if reasons:
        return {"run": True, "reasons": reasons[:12], "why_not": None}
    if files and all(DOCS.search(f["path"]) for f in files):
        why = "Only documentation changed."
    elif not known:
        why = "The diff could not be read here, and no infrastructure or dependency file changed."
    else:
        why = "Nothing in the diff touches infrastructure, permissions, routes, auth, dependencies, secrets, or new network, file or process access."
    return {"run": False, "reasons": [], "why_not": why}


def merged_from_log(text):
    """`git log --format=%x1e%s%x1f%b%x1d --name-only` → [{number, title, files}]: a merge commit's title is its
    body's first line, a squash's its subject without " (#n)"."""
    out = {}
    for chunk in text.split("\x1e")[1:]:
        subject, _, rest = chunk.partition("\x1f")
        body, _, names = rest.partition("\x1d")
        m = PR_NUMBER.search(subject)
        if not m:
            continue
        n = int(m[1] or m[2])
        title = (body.strip().splitlines() or [subject])[0] if m[1] else PR_NUMBER.sub("", subject).strip()
        files = [x for x in names.split("\n") if x.strip()]
        p = out.setdefault(n, {"number": n, "title": title, "files": []})
        p["files"] = sorted(set(p["files"]) | set(files))
    return list(out.values())


def run(cmd, cwd=None, timeout=120):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return r.stdout if r.returncode in (0, 8) else None  # gh pr checks exits 8 while checks are pending


def main(req):
    m = re.match(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", req["url"])
    repo, number, files, wt = m[1], int(m[2]), req.get("files") or [], req.get("worktree")
    raw = run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", str(OPEN_LIMIT), "--json", "number,title,url,files,headRefName,baseRefName,isCrossRepository"])
    others = [{"number": p["number"], "title": p["title"], "url": p["url"], "files": [f["path"] for f in p.get("files") or []],
               "branch": p.get("headRefName"), "base": p.get("baseRefName"), "fork": bool(p.get("isCrossRepository"))}
              for p in json.loads(raw or "[]") if p["number"] != number]
    below, above = stacked_on(req.get("base"), others), stacked_above(req.get("branch"), others)
    on_top = {p["number"] for p in above}
    merged, diff = [], None
    if wt and files and pathlib.Path(wt).is_dir():
        base = req.get("base") or "main"
        run(["git", "fetch", "--quiet", "origin", base], cwd=wt, timeout=300)
        diff = run(["git", "diff", "--no-color", "--no-ext-diff", "-U0", f"origin/{base}...{req.get('head') or 'HEAD'}"], cwd=wt)
        log = run(["git", "log", f"origin/{base}", f"--since={MERGED_DAYS}.days.ago", "--format=%x1e%s%x1f%b%x1d", "--name-only", "--", *files[:200]], cwd=wt)
        merged = [{**p, "url": f"https://github.com/{repo}/pull/{p['number']}"} for p in overlap(files, merged_from_log(log or "")) if p["number"] != number]
    checks = json.loads(run(["gh", "pr", "checks", req["url"], "--json", "name,bucket,link"]) or "[]")
    view = json.loads(run(["gh", "pr", "view", req["url"], "--json", "mergeable,mergeStateStatus"]) or "{}")
    result = {"at": dt.datetime.now().astimezone().isoformat(), "head": req.get("head"), "stacked_on": below, "stacked_above": above,
              "open": [{**p, "stacked": (bool(below) and p["number"] == below["number"]) or p["number"] in on_top, "above": p["number"] in on_top}
                       for p in overlap(files, others)], "merged": merged,
              "checks": [{"name": c["name"], "bucket": c.get("bucket") or "pending", "link": c.get("link")} for c in checks],
              "mergeable": view.get("mergeable"), "merge_state": view.get("mergeStateStatus"),
              "security_trigger": security_trigger(diff_files(diff) if diff else [{"path": f} for f in files])}
    out = pathlib.Path(req["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main(json.loads(sys.argv[1]))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
