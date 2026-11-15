#!/usr/bin/env python3
"""Fix verification for the review layout: were the findings sent to Fix really fixed by the pushes since?

argv[1]: JSON {context ({id, env}: the PR's), model (sonnet|opus; a passed haiku runs as sonnet, llm.code_model), worktree (checkout with the PR head), head, items:
[{id, file, line, title, detail, suggestion, since (the head when it was sent to Fix)}]}.
An item can also be checked on its fix branch, before the fix is in the PR: it then carries its own `worktree` (the
fix's), `head` (the commit the agent reported), `since` (where the branch started) and `branch` (its name); its
evidence is the whole diff of that branch.
For each finding: the diff of its file from `since` to `head` (worktree.since_diff; the file as it is now when that
history is gone). One call, feature "PR fix verification", in the PR's context. Prints {results: [{id, verdict:
fixed|not_fixed|unclear, reason}], cost}; exit 1 with the reason on stderr.
"""
import json
import pathlib
import sys

# No __pycache__ next to the mod's files: a new file in the mod's folder reloads the mod, and the review that waits for
# this script's answer is gone with it (the first verification after an update came back empty that way).
sys.dont_write_bytecode = True

import llm  # noqa: E402  (this folder)
import worktree  # noqa: E402

FEATURE = "PR fix verification"
BUDGET = {"haiku": 0.3, "sonnet": 1.0, "opus": 3.0}
PER_ITEM = 6000
SCHEMA = {"type": "object", "required": ["results"], "properties": {"results": {"type": "array", "items": {
    "type": "object", "required": ["id", "verdict", "reason"], "properties": {
        "id": {"type": "string"}, "verdict": {"enum": ["fixed", "not_fixed", "unclear"]}, "reason": {"type": "string"}}}}}}


def evidence(req, item, cache):
    """The changes to the finding's file since it went to Fix; else the file around the line now."""
    where, head = item.get("worktree") or req["worktree"], item.get("head") or req["head"]
    key = (where, item["since"], head)
    if key not in cache:
        cache[key] = worktree.since_diff(where, item["since"], head, sorted({i["file"] for i in req["items"]}))
    d = cache[key]
    # A fix branch holds nothing but the fix, which often changes other files than the finding's: all of it.
    # ponytail: one job's findings each carry the same diff; share it once when jobs with many findings get common.
    if item.get("branch") and d["patch"]:
        return f"The whole diff of the fix branch {item['branch']}, not in the PR yet ({d['mode']}):\n" + d["patch"][:4 * PER_ITEM]
    parts = [chunk for chunk in d["patch"].split("diff --git ") if chunk.startswith(f"a/{item['file']} ")]
    if parts:
        return f"Diff since the fix request ({d['mode']}):\n" + ("diff --git " + parts[0])[:PER_ITEM]
    try:
        lines = (pathlib.Path(where) / item["file"]).read_text(errors="replace").splitlines()
    except OSError:
        return "The file no longer exists."
    lo = max(0, int(item.get("line") or 1) - 20)
    note = "No change to the file since the fix request." if d["mode"] != "full" else d["note"]
    return f"{note}\nThe file now, from line {lo + 1}:\n" + "\n".join(lines[lo:lo + 40])


def prompt(req):
    cache, out = {}, []
    for i in req["items"]:
        out.append(f"## [{i['id']}] `{i['file']}`:{i['line']}: {i['title']}\n{i.get('detail') or ''}"
                   + (f"\nSuggestion: {i['suggestion']}" if i.get("suggestion") else "") + "\n\n" + evidence(req, i, cache))
    return ("For each review finding below, check whether the changes since the fix request fix it. verdict: fixed, "
            "not_fixed (not or only partly fixed), unclear (can't be decided from what is shown); reason: one sentence in "
            f"{llm.language()}, concrete about the code. Return every id exactly once.\n\n" + "\n\n".join(out))


def main(req):
    req = {**req, "model": llm.code_model(req.get("model"))}  # it judges code: never haiku
    meta = {}
    answer = llm.claude(FEATURE, prompt(req), context=req.get("context"), model=req["model"], schema=SCHEMA,
                        budget=BUDGET[llm.tier(req["model"])], timeout=540, meta=meta)
    ids = {i["id"] for i in req["items"]}
    return {"results": [r for r in (answer or {}).get("results", []) if r.get("id") in ids], "cost": meta.get("cost")}


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.loads(sys.argv[1]))))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
