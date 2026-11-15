"""How pr-review calls an LLM headless (`claude -p`), its settings, and an optional usage ledger.

    import llm
    data = llm.claude("Review analysis", prompt, context={"id": "default", "env": None}, model="sonnet", schema=SCHEMA)

Settings come from pr-review.config.json in the Herdr app home (HERDR_APP_HOME, else ~/.config/herdr-app); every
key is optional (see PROVIDERS.md):
  language      the language the AI answers in (default "English")
  ledger        a folder: each call appends one JSON line to usage-YYYY-MM.jsonl there; unset: no ledger
  globalRules   conventions every PR is checked against, besides the repo's own rules files
A context ({id, env}) comes from the panel: env vars for the call (null unsets one); id is recorded in the ledger.
"""
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import time

APP = pathlib.Path(os.environ.get("HERDR_APP_HOME") or pathlib.Path.home() / ".config/herdr-app")
CONFIG = APP / "pr-review.config.json"
KEEP_MONTHS = 24
# No hooks; and the read-only commands Claude Code runs by itself (cat, ls, git log …) read only inside the working
# directories (the checkout, --add-dir): a run reads someone else's PR and must not reach files outside it. This mod's
# own folder is one of them, so a run can call safegit.py, its only way to git (the folder holds only the mod's code;
# pr-data and the config lie beside it). Measured: readAllowPaths did not let the call through, a working directory does.
SETTINGS = {"disableAllHooks": True, "permissions": {"blockReadsOutsideWorkingDirectories": True,
                                                      "additionalDirectories": [str(pathlib.Path(__file__).resolve().parent)]}}
LEAN = ["--no-session-persistence", "--output-format", "json",
        "--settings", json.dumps(SETTINGS), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands"]


def config():
    try:
        return json.loads(CONFIG.read_text()) or {}
    except (OSError, ValueError):
        return {}


def language():
    return config().get("language") or "English"


def ledger_dir():
    path = config().get("ledger")
    return pathlib.Path(os.path.expanduser(path)) if path else None


# Secrets a model run never needs: tokens, secrets and cloud or GitHub credentials of the window (a model reads the
# PR's text and can run allowed commands). Kept: the account's own login (CLAUDE_*, ANTHROPIC_*, e.g.
# CLAUDE_CODE_OAUTH_TOKEN), AWS_* when Claude runs on Bedrock (CLAUDE_CODE_USE_BEDROCK), and whatever the context sets.
SECRET = re.compile(r"(_TOKEN|_SECRET)$|^(AWS_|GH_)")
LOGIN = re.compile(r"^(CLAUDE_|ANTHROPIC_)")


def env_for(context):
    """The process env without secrets (SECRET, but the login: LOGIN), with the context's vars applied (None unsets).
    git refuses abbreviated long options in every run: a model's `git blame --con` would else be --contents, past a
    rule that denies the full name."""
    mine = (context or {}).get("env") or {}
    bedrock = str(mine.get("CLAUDE_CODE_USE_BEDROCK", os.environ.get("CLAUDE_CODE_USE_BEDROCK", ""))).lower() not in ("", "0", "false")
    keep = lambda k: not SECRET.search(k) or LOGIN.match(k) or (bedrock and k.startswith("AWS_"))  # noqa: E731
    env = {**{k: v for k, v in os.environ.items() if keep(k)}, "GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS": "1"}
    for k, v in mine.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = os.path.expanduser(str(v))
    return env


def log(feature, context_id, model, cost, tokens=0, ms=0, ok=True, tool="claude"):
    """One ledger line, only when a ledger folder is configured. `account` holds the context id."""
    folder = ledger_dir()
    if not folder:
        return
    folder.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    line = json.dumps({"at": now.isoformat(timespec="seconds"), "feature": feature, "account": context_id, "model": model,
                       "cost": round(float(cost or 0), 6), "tokens": int(tokens or 0), "ms": int(ms), "ok": ok, "tool": tool})
    with open(folder / f"usage-{now:%Y-%m}.jsonl", "a", encoding="utf-8") as f:  # one short O_APPEND write per call
        f.write(line + "\n")
    for old in sorted(folder.glob("usage-*.jsonl"))[:-KEEP_MONTHS]:
        old.unlink(missing_ok=True)


def tier(model):
    """A model's budget class for the caps: haiku, sonnet, or opus (the bigger ones, and any model not named)."""
    m = str(model or "").lower()
    return "haiku" if "haiku" in m else "sonnet" if "sonnet" in m else "opus"


def code_model(model):
    """The model for a call that reads or judges code: at least sonnet. Haiku is fine for text (triage, turning a
    reviewer's prose into findings) but too weak to reason about code, so a passed haiku (an old caller) becomes sonnet."""
    return "sonnet" if not model or tier(model) == "haiku" else model


def parse(stdout):
    """What `claude -p` printed, as its result object: the JSON itself (--output-format json), or a stream's result
    line (stream-json). A slash command may run as a fork and answer there: the result then is only "Command
    completed" without structured_output, so the stream's last StructuredOutput call counts as the answer, and
    `text` holds what forks and subagents wrote (a review given as text)."""
    try:
        data = json.loads(stdout)
        return data if isinstance(data, dict) else {}
    except ValueError:
        pass
    events = []
    for line in stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    events = [e for e in events if isinstance(e, dict)]
    data = next((e for e in reversed(events) if e.get("type") == "result"), {})
    said = [(e.get("parent_tool_use_id"), c) for e in events if e.get("type") == "assistant"
            for c in (e.get("message") or {}).get("content") or [] if isinstance(c, dict)]
    calls = [c.get("input") for _, c in said if c.get("type") == "tool_use" and c.get("name") == "StructuredOutput"]
    if data and data.get("structured_output") is None and calls:
        data["structured_output"] = calls[-1]
    if data:
        data["text"] = "\n\n".join(c["text"] for parent, c in said if parent and c.get("type") == "text" and c.get("text"))
    return data


def claude(feature, prompt, *, context=None, model="sonnet", schema=None, system=None, budget=0.2,
           timeout=180, tools="", cwd=None, extra=(), meta=None, skills=False):
    """Runs `claude -p`, records the call, returns structured_output (with a schema) or the result text.
    meta: a dict that gets {cost, tokens, usage ({input, output, cache_read, cache_write} tokens), ms, model_id,
    result, text} of the call, for callers that show them.
    skills: keep skills and slash commands (a prompt like "/code-review medium 12") and read the run as a stream, since
    such a command may answer in a fork (parse); everything else stays lean."""
    lean = [a for a in LEAN if not (skills and a == "--disable-slash-commands")]
    if skills:
        lean = ["stream-json" if a == "json" else a for a in lean] + ["--verbose"]  # stream-json needs --verbose with -p
    args = ["claude", "-p", "--model", model, *lean, "--max-budget-usd", str(budget)]
    if tools is not None:
        args += ["--tools", tools]
    if schema is not None:
        # The whole answer under one top-level property. With many of them the model mixes the tool call's own syntax
        # into the JSON of nested objects, the call does not parse and the whole answer is sent again (seen in every
        # watched analysis, one to three times: a third of the price and a minute each).
        args += ["--json-schema", json.dumps({"type": "object", "required": ["answer"], "properties": {"answer": schema}})]
    if system:
        args += ["--system-prompt", system]
    started = time.monotonic()
    for attempt in (1, 2):  # ponytail: one retry covers the moment a Claude Code self-update swaps the binary
        try:
            out = subprocess.run([*args, *extra], input=prompt, capture_output=True, text=True, timeout=timeout,
                                 env=env_for(context), cwd=str(cwd or APP))
            break
        except FileNotFoundError:
            if attempt == 2:
                raise RuntimeError(f"{feature}: the claude command was not found on PATH") from None
            time.sleep(3)
    ms = (time.monotonic() - started) * 1000
    data = parse(out.stdout)
    usage = data.get("usage") or {}
    parts = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_input_tokens", "cache_write": "cache_creation_input_tokens"}
    tokens = sum(usage.get(k) or 0 for k in parts.values())
    ok = out.returncode == 0 and not data.get("is_error")
    log(feature, (context or {}).get("id") or "default", model, data.get("total_cost_usd") or 0, tokens, int(ms), ok)
    if meta is not None:
        meta.update(cost=data.get("total_cost_usd"), tokens=tokens, usage={k: usage.get(v) or 0 for k, v in parts.items()}, ms=int(ms), model_id=next(iter(data.get("modelUsage") or {}), model),
                    result=data.get("result"), text=data.get("text") or "")
    if not ok:
        raise RuntimeError(f"{feature}: {(out.stderr or out.stdout).strip()[:300]}")
    return (data.get("structured_output") or {}).get("answer") if schema is not None else data.get("result")
