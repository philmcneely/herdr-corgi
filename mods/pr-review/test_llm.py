"""Run: python3 test_llm.py  (no network: subprocess.run is stubbed)."""
import json
import pathlib
import subprocess
import tempfile

import llm

calls = []


def fake_run(args, **kw):
    calls.append((args, kw))
    out = {"result": "hi", "structured_output": {"answer": {"x": 1}}, "total_cost_usd": 0.0123, "usage": {"input_tokens": 10, "output_tokens": 5},
           "modelUsage": {"claude-haiku-x": {}}}
    return subprocess.CompletedProcess(args, 0, json.dumps(out), "")


real = subprocess.run
subprocess.run = fake_run
try:
    with tempfile.TemporaryDirectory() as d:
        llm.CONFIG = pathlib.Path(d) / "pr-review.config.json"

        # No settings: no ledger is written, English is the language, the context's env is applied.
        meta = {}
        got = llm.claude("Feature A", "prompt", context={"id": "red", "env": {"CLAUDE_CONFIG_DIR": "/x/.claude-red", "GONE": None}},
                         schema={"type": "object"}, meta=meta)
        assert got == {"x": 1}, got
        args, kw = calls[-1]
        assert args[:4] == ["claude", "-p", "--model", "sonnet"] and "--json-schema" in args and kw["input"] == "prompt"
        assert json.loads(args[args.index("--json-schema") + 1]) == {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "object"}}}, "one top-level property"
        assert kw["env"]["CLAUDE_CONFIG_DIR"] == "/x/.claude-red" and "GONE" not in kw["env"]
        assert meta["cost"] == 0.0123 and meta["tokens"] == 15 and meta["model_id"] == "claude-haiku-x"
        assert meta["usage"] == {"input": 10, "output": 5, "cache_read": 0, "cache_write": 0}
        assert llm.language() == "English" and llm.ledger_dir() is None
        assert not list(pathlib.Path(d).rglob("usage-*.jsonl"))

        # A ledger folder configured: one line per call, with the feature and the context id as `account`.
        ledger = pathlib.Path(d) / "ledger"
        llm.CONFIG.write_text(json.dumps({"ledger": str(ledger), "language": "German"}))
        assert llm.claude("Feature B", "p", context={"id": "blue", "env": None}) == "hi"
        lines = [json.loads(x) for f in ledger.glob("usage-*.jsonl") for x in f.read_text().splitlines()]
        assert [(e["feature"], e["account"], e["cost"], e["tokens"], e["ok"]) for e in lines] == [("Feature B", "blue", 0.0123, 15, True)], lines
        assert llm.language() == "German"
        llm.log("Codex review", "blue", "codex", 0, 100, tool="codex")  # non-Claude tools log the same way
        assert len(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()) == 2

        # No context: the env is inherited untouched, the ledger says "default".
        llm.claude("Feature C", "p")
        assert calls[-1][1]["env"].get("CLAUDE_CONFIG_DIR") == __import__("os").environ.get("CLAUDE_CONFIG_DIR")
        assert json.loads(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()[-1])["account"] == "default"

        # A failed call raises with the reason, and is still in the ledger as not ok.
        subprocess.run = lambda args, **kw: subprocess.CompletedProcess(args, 1, "", "boom")
        try:
            llm.claude("Feature D", "p")
            raise AssertionError("no error")
        except RuntimeError as e:
            assert "boom" in str(e)
        assert json.loads(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()[-1])["ok"] is False

    # reviewers.py: a missing slash command is recognized (the review then runs as a plain prompt).
    import reviewers
    assert reviewers.missing_command("Unknown skill: code-review") and reviewers.missing_command("Unknown slash command /x")
    assert not reviewers.missing_command("3 findings")

    # A slash command that runs as a fork: the result line says only "Command completed", the answer is the fork's
    # StructuredOutput call in the stream. It must not read as "no findings".
    line = lambda **kw: json.dumps(kw)  # noqa: E731
    said = lambda parent, *content: line(type="assistant", parent_tool_use_id=parent, message={"content": list(content)})  # noqa: E731
    finding = {"file": "./.github/a.py", "line": 2, "title": "always raises", "detail": "d", "category": "bug", "impact": "dead_path",
               "effect": "no event is published", "preconditions": [], "certainty": "derived"}
    report = {"findings": [finding], "scope": {"read": ["./a.py"], "checked": [{"area": "tests", "result": "finding"}], "skipped": ["vendored code"]}}
    done = {"type": "result", "result": "Command completed", "local_command": "code_review", "total_cost_usd": 0.07, "modelUsage": {"claude-sonnet-x": {}}}
    fork = "\n".join([line(type="system", subtype="init"), said("forked-command-code-review", {"type": "text", "text": "Looking at the diff."}),
                      said("forked-command-code-review", {"type": "tool_use", "name": "StructuredOutput", "input": {"answer": report}}),
                      said(None, {"type": "text", "text": "Command completed"}), line(**done)])
    got = llm.parse(fork)
    assert got["structured_output"] == {"answer": report} and got["text"] == "Looking at the diff." and got["total_cost_usd"] == 0.07
    assert llm.parse(json.dumps({"result": "hi", "structured_output": {"x": 1}}))["structured_output"] == {"x": 1}  # plain json as before
    assert llm.parse("not json") == {}

    outs = []
    subprocess.run = lambda args, **kw: (calls.append((args, kw)), subprocess.CompletedProcess(args, 0, outs.pop(0), ""))[1]
    req = {"kind": "claude", "model": "sonnet", "context": None, "worktree": d, "base": "feat/below", "number": 12, "level": "medium"}
    outs.append(fork)
    answer, meta = reviewers.claude_review(req, reviewers.code_review_command(req))
    args, kw = calls[-1]
    assert kw["input"] == "/code-review medium origin/feat/below...HEAD", "the PR's own range, and nothing after it: the command would review that text"
    assert "stream-json" in args and "--verbose" in args and "--disable-slash-commands" not in args
    assert "certainty" in json.loads(args[args.index("--json-schema") + 1])["properties"]["answer"]["description"], "the fork learns the fields from the schema"
    assert "`inline code`" in reviewers.ASK and "title stays one line of plain text" in reviewers.ASK, "reviewers write their texts as the analysis does"
    item = json.loads(args[args.index("--json-schema") + 1])["properties"]["answer"]["properties"]["findings"]["items"]["properties"]
    assert "no markdown" in item["title"]["description"] and "paragraphs" in item["detail"]["description"] and "fenced code" in item["suggestion"]["description"]
    found = reviewers.normalize(answer["findings"], "claude", d)
    assert len(found) == 1 and found[0]["severity"] == "high" and found[0]["impact"] == "dead_path" and found[0]["certainty"] == "derived"
    assert found[0]["file"] == ".github/a.py", "a leading ./ goes, a dot folder stays"
    assert reviewers.scope(answer["scope"], "claude") == {"read": ["a.py"], "skipped": ["vendored code"], "checked": [
        {"area": a, "result": "finding" if a == "tests" else "not_checked", "note": ""} for a in reviewers.AREAS["claude"]]}
    assert reviewers.scope(None, "claude") is None and reviewers.scope({}, "codex") is None

    # The fork wrote its review as text: a Haiku pass turns it into findings, and the run says so.
    outs += ["\n".join([said("forked-command-code-review", {"type": "text", "text": "a.py:2 always raises"}), line(**done)]),
             json.dumps({"structured_output": {"answer": {"findings": [{"file": "a.py", "line": 2, "severity": "high", "title": "always raises", "detail": "d"}]}}, "total_cost_usd": 0.01})]
    answer, meta = reviewers.claude_review(req, reviewers.code_review_command(req))
    assert meta["converted"] and abs(meta["cost"] - 0.08) < 1e-9 and "a.py:2 always raises" in calls[-1][1]["input"]
    assert calls[-1][0][:4] == ["claude", "-p", "--model", "haiku"], "reshaping prose stays on haiku"
    assert reviewers.normalize(answer["findings"], "claude", d)[0]["severity"] == "high"

    # The command wrote its review as the main answer's text, without the answer tool: that prose is turned too.
    review_text = "8 findings, most severe first: 1. `a.py:2`: `publish_overdue` always raises `ValueError` because the table forbids the move."
    outs += ["\n".join([line(**{**done, "result": review_text})]),
             json.dumps({"structured_output": {"answer": {"findings": [{"file": "a.py", "line": 2, "severity": "high", "title": "always raises", "detail": "d"}]}}, "total_cost_usd": 0.01})]
    answer, meta = reviewers.claude_review(req, reviewers.code_review_command(req))
    assert meta["converted"] and review_text in calls[-1][1]["input"] and len(answer["findings"]) == 1

    # No answer anywhere: the run fails with a reason instead of counting 0 findings.
    outs.append("\n".join([said(None, {"type": "text", "text": "Command completed"}), line(**done)]))
    try:
        reviewers.claude_review(req, reviewers.code_review_command(req))
        raise AssertionError("an empty run passed as a review")
    except RuntimeError as e:
        assert "gave no findings answer" in str(e) and "Command completed" in str(e)
finally:
    subprocess.run = real
# Code is read and judged by at least sonnet: an old caller's haiku is lifted, the rest passes through.
assert [llm.code_model(m) for m in ["haiku", "claude-haiku-4-5-20251001", None, "", "sonnet", "opus", "claude-fable-5-1"]] == \
    ["sonnet", "sonnet", "sonnet", "sonnet", "sonnet", "opus", "claude-fable-5-1"]
print("ok")
