#!/usr/bin/env python3
"""Read-only git for model runs that read someone else's PR (review.py, reviewers.py). The runs may call git only as

    python3 <this file> <checkout> <command> [args…]

and never git itself. An allowlist, nothing else passes (exit 2 with the reason):
- commands: diff, log, show, status, blame, merge-base, rev-parse, ls-files;
- options: only those listed for the command below, none that takes a file. A long option's value only as --opt=value.
  A short option with a required value (-n, -S, -G, -L) attached or as the next argument, which must not start with -;
  one whose value git takes only attached (-U3, -uno, -M50%) only attached, never bare. Every value is checked as a
  path too. Where safegit might split an argument differently from git, it refuses;
- every other argument is a revision or a path: relative, inside the checkout: no leading / or ~, no .. segment (also
  a bare ..; a revision range like base..head is no segment and stays allowed), also after : (rev:path).
git runs as `git --no-pager -C <checkout>`, with no external diff, no textconv, GIT_CEILING_DIRECTORIES above the
checkout and abbreviated options disallowed. Standard library only.
"""
import os
import re
import subprocess
import sys

# An option without a value; with a required value (a word, number, format or pattern; never a file); or with a
# value git reads only when attached (-U3, -uno, -M50%): bare it would be read differently, so it is refused.
FLAG, VALUE, ATTACHED = None, "value", "attached"
DIFF = {"--stat": FLAG, "--numstat": FLAG, "--shortstat": FLAG, "--name-only": FLAG, "--name-status": FLAG, "--summary": FLAG, "--raw": FLAG,
        "-p": FLAG, "--patch": FLAG, "-u": FLAG, "--no-patch": FLAG, "-s": FLAG, "-U": ATTACHED, "--unified": VALUE, "--minimal": FLAG,
        "--patience": FLAG, "--histogram": FLAG, "-w": FLAG, "--ignore-all-space": FLAG, "-b": FLAG, "--ignore-space-change": FLAG,
        "--ignore-blank-lines": FLAG, "--word-diff": FLAG, "--color": VALUE, "--no-color": FLAG, "--exit-code": FLAG, "--quiet": FLAG,
        "-M": ATTACHED, "--find-renames": FLAG, "--no-renames": FLAG, "--diff-filter": VALUE, "-R": FLAG, "--function-context": FLAG, "-W": FLAG,
        "--full-index": FLAG, "--abbrev": VALUE, "--no-prefix": FLAG, "--text": FLAG, "-a": FLAG, "--stat-width": VALUE}
LOG = {**DIFF, "--oneline": FLAG, "--format": VALUE, "--pretty": VALUE, "-n": VALUE, "--max-count": VALUE, "--skip": VALUE, "--since": VALUE,
       "--until": VALUE, "--after": VALUE, "--before": VALUE, "--author": VALUE, "--committer": VALUE, "--grep": VALUE, "-S": VALUE, "-G": VALUE,
       "--follow": FLAG, "--first-parent": FLAG, "--merges": FLAG, "--no-merges": FLAG, "--reverse": FLAG, "--graph": FLAG, "--decorate": FLAG,
       "--no-decorate": FLAG, "--date": VALUE, "--all": FLAG, "-L": VALUE, "-i": FLAG, "--regexp-ignore-case": FLAG}
OPTIONS = {
    "diff": {**DIFF, "--merge-base": FLAG, "--cached": FLAG, "--staged": FLAG},
    "log": LOG,
    "show": LOG,
    "blame": {"-L": VALUE, "-w": FLAG, "-M": ATTACHED, "--porcelain": FLAG, "--line-porcelain": FLAG, "-e": FLAG, "--show-email": FLAG, "-s": FLAG,
              "--date": VALUE, "-l": FLAG, "-t": FLAG, "--root": FLAG},
    "status": {"--short": FLAG, "-s": FLAG, "--porcelain": FLAG, "--branch": FLAG, "-b": FLAG, "--untracked-files": VALUE, "-u": ATTACHED},
    "merge-base": {"--all": FLAG, "--is-ancestor": FLAG, "--fork-point": FLAG, "--octopus": FLAG},
    "rev-parse": {"--short": FLAG, "--verify": FLAG, "--abbrev-ref": FLAG, "--symbolic-full-name": FLAG, "--is-inside-work-tree": FLAG, "-q": FLAG, "--quiet": FLAG},
    "ls-files": {"--cached": FLAG, "-c": FLAG, "--modified": FLAG, "-m": FLAG, "--others": FLAG, "-o": FLAG, "--exclude-standard": FLAG, "--stage": FLAG,
                 "-s": FLAG, "--deleted": FLAG, "-d": FLAG, "-z": FLAG},
}
# Options whose value may hold a path (log -L 1,5:lib/x.py, blame -L): the part after the last : is checked as one.
PATH_VALUES = {"-L"}


def bad_path(text):
    """Why a revision or path leaves the checkout, or None."""
    for part in str(text).split(":"):
        p = part.strip().replace("\\", "/")
        if p.startswith(("/", "~")) or ".." in p.split("/") or "\0" in p:
            return f"{text}: paths must be relative and stay inside the checkout"
    return None


def refused(cmd, args):
    """The reason the call is refused, or None."""
    allowed = OPTIONS.get(cmd)
    if allowed is None:
        return f"only {', '.join(OPTIONS)} are allowed"
    k, paths = 0, False
    while k < len(args):
        a = args[k]
        k += 1
        if paths or a == "--" or not a.startswith("-") or a == "-":
            if a == "--":
                paths = True
                continue
            if a == "-":
                return "reading from stdin is not allowed"
            why = bad_path(a)
            if why:
                return why
            continue
        if cmd == "log" and re.fullmatch(r"-\d+", a):  # log -5
            continue
        if a.startswith("--"):
            name, eq, value = a.partition("=")
            short = None
        else:
            name, value, eq = a[:2], a[2:], ""
            short = True
        if name not in allowed:
            return f"option {name} is not allowed for git {cmd}"
        kind = allowed[name]
        if kind is FLAG:
            if value and short and not all(f"-{c}" in allowed and allowed[f"-{c}"] is FLAG for c in value):
                return f"option {a} is not allowed for git {cmd}"  # combined flags (-pw) only of known flags
            if eq:
                return f"option {name} takes no value"
            continue
        if not value and not eq:
            if not short:
                return f"option {name} needs its value as {name}=…"
            if kind == ATTACHED:
                return f"option {name} takes its value attached ({name}…), not bare"
            if k >= len(args) or args[k].startswith("-"):
                return f"option {name} needs a value that is not an option"
            value = args[k]
            k += 1
        if not value:
            return f"option {name} needs a value"
        if value.startswith("-"):
            return f"option {name}: a value may not start with -"
        why = bad_path(value.rsplit(":", 1)[-1] if name in PATH_VALUES else value)  # -L 1,5:path: the path after the last :
        if why:
            return why
    return None


def main(argv):
    if len(argv) < 2 or not os.path.isabs(argv[0]) or not os.path.isdir(argv[0]):
        print("usage: safegit.py <checkout> <command> [args…]", file=sys.stderr)
        return 2
    root, cmd, args = os.path.realpath(argv[0]), argv[1], argv[2:]
    why = refused(cmd, args)
    if why:
        print(f"safegit: refused: {why}", file=sys.stderr)
        return 2
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}  # no GIT_DIR, GIT_EXTERNAL_DIFF, GIT_CONFIG_* from outside
    env.update(GIT_CEILING_DIRECTORIES=os.path.dirname(root), GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS="1", GIT_PAGER="cat", PAGER="cat", GIT_CONFIG_NOSYSTEM="1")
    plain = ["--no-ext-diff", "--no-textconv"] if cmd in ("diff", "log", "show") else []
    return subprocess.run(["git", "--no-pager", "-C", root, "-c", "core.fsmonitor=false", cmd, *plain, *args], env=env).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
