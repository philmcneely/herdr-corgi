#!/usr/bin/env python3
"""The one way code from a PR runs for a probe: a small script that shows a suspected failure, run in a sandbox. The
probe agent (threads.js, kind "probe") only writes the script; the review starts this runner itself:

    python3 <this file> <checkout> <id> [--base <rev>]

(`python3 <this file> --barrier` prints the fence this machine has: sandbox-exec, bwrap or none.)
<checkout> is the agent's worktree at the PR head (absolute), <id> names its script <checkout>/.pr-review-probe/<id>.py.
For the head (and the base, when given) the runner:
- exports the commit with `git archive` into a new, empty folder (only what git tracks: no .env, no build output);
- copies the script there and runs it as `python3 -I <script> <export>` from that folder, with `env -i` (PATH, a
  temporary HOME and TMPDIR, nothing else: no AWS_*, GH_TOKEN, context variables);
- on macOS under `sandbox-exec`: no network, writes only in its own temporary folder, reads only from an allowlist (its own
  folder, the interpreter's, the system's libraries and shared data: not /tmp, not the user's temporary folder, not the
  home), no new processes; on Linux under bubblewrap (`bwrap`: no namespace shared, no capability, only the system folders and
  the interpreter's own folders read-only, empty tmpfs over /tmp and /run, only its own temporary folder writable,
  socket(AF_UNIX) refused by seccomp, dead with the runner); without
  either it still runs and says so
  (`network_barrier: false`: the review then asks before every probe);
- stops it after 30 s, keeps at most 4 KB of its output and blacks out e-mail addresses and token patterns.
The script ends with a line `reproduced <what it shows>` or `not_reproduced <what it saw>` (exit 0 or 1). Anything
else, a crash or the time limit is `script_failed`: never read as a refutation. How strong the evidence is the runner
reads from the script, never from what it prints (strength_of): models_env when it says it models the platform
(a top-level MODELS_ENV = "…"), forced_schedule when it forces an interleaving (threading.Barrier), else runs_pr_code.
On the base the outcome is one of four (base_verdict): already_on_base (reproduced there too), new_in_pr (the code it
tests is not there: ImportError or AttributeError), unknown (a signature that does not fit: TypeError, or the script
failed otherwise), not_on_base.
The script is read once, without following a link (a link, a folder that is a link, anything but a plain file of at
most 64 KB is refused), and the result is printed as JSON, nothing is written into the checkout:
{id, status, strength, line, exit, ms, head, base: {rev, status, line, exit, ms, verdict} | null, pre_existing,
network_barrier, sandbox, output, at, script (what ran, blacked out like the output)}. The review takes script and
result from this output only. Exit 2 when the call is refused, 3 when there is no script. Standard library only.
"""
import ast
import datetime as dt
import io
import json
import os
import platform
import pwd
import re
import shutil
import stat
import struct
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
import threading
import time

PROBE_DIR = ".pr-review-probe"
ID = re.compile(r"[A-Za-z0-9_-]{1,40}")  # as threads.js PROBE_ID and resilience.py PROBE_ID
REV = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./^~-]{0,199}")
LIMIT_S, OUT_CAP, READ_CAP, SCRIPT_CAP = 30, 4096, 65536, 64000
STRENGTHS = ("runs_pr_code", "forced_schedule", "models_env")
VERDICT = re.compile(r"^\s*(reproduced|not_reproduced|refuted)\b[\s:]*(.*)$")
# What is blacked out of an output before anyone sees it: e-mail addresses and the usual token shapes.
SECRETS = [re.compile(p) for p in (
    r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})*\.[A-Za-z]{2,24}\b", r"\bgh[pousr]_[A-Za-z0-9]{20,}", r"\bgithub_pat_[A-Za-z0-9_]{20,}", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bsk-[A-Za-z0-9_-]{20,}", r"\bxox[abposr]-[A-Za-z0-9-]{10,}", r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{10,}=*",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
    r"(?i)\b(?:secret|token|password|passwd|api[_-]?key)\b(\s*[=:]\s*)\S+")]


class NoScript(ValueError):
    """The agent wrote no script: no refusal of something that is there (exit 3, not 2)."""


def redact(text):
    for p in SECRETS:
        text = p.sub(lambda m: f"{m.group(0)[:m.start(1) - m.start(0)]}{m.group(1)}[redacted]" if p.groups else "[redacted]", text)
    return text


def git(checkout, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}  # as safegit: no GIT_DIR or GIT_CONFIG_* from outside
    env.update(GIT_CEILING_DIRECTORIES=os.path.dirname(checkout), GIT_CONFIG_NOSYSTEM="1", GIT_PAGER="cat")
    return subprocess.run(["git", "--no-pager", "-C", checkout, "-c", "core.fsmonitor=false", *args], env=env, capture_output=True, timeout=120)


def commit_of(checkout, rev):
    """The commit a revision names, or None."""
    if not REV.fullmatch(rev) or ".." in rev:
        return None
    r = git(checkout, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    return r.stdout.decode().strip() or None if r.returncode == 0 else None


def export(checkout, sha, dest):
    """The commit's tracked files into dest: regular files and folders only, nothing outside dest (no links, no
    absolute or .. names)."""
    r = git(checkout, "archive", "--format=tar", sha)
    if r.returncode != 0:
        raise RuntimeError(f"git archive failed: {r.stderr.decode()[:200]}")
    root = os.path.realpath(dest)
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
        for m in tar.getmembers():
            name = os.path.normpath(m.name)
            target = os.path.realpath(os.path.join(root, name))
            if name.startswith(("/", "..")) or not (target == root or target.startswith(root + os.sep)) or not (m.isfile() or m.isdir()):
                continue
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tar.extractfile(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def user_home():
    return os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)  # from the account, not from $HOME


def interp_dirs():
    """The interpreter's own folders a probe needs (sysconfig: the standard library, its compiled modules, the
    executable's folder, the folder of libpython), never its whole prefix."""
    p = sysconfig.get_paths()
    dirs = [p.get("stdlib"), p.get("platstdlib"), os.path.dirname(os.path.realpath(sys.executable)), sysconfig.get_config_var("LIBDIR")]
    return [os.path.realpath(d) for d in dict.fromkeys(dirs) if d]


def above(dirs, hidden):
    """The dirs that are a hidden folder or one above it: making them readable again would show the hidden one."""
    n = os.path.realpath  # also for a path that does not exist: "/x/", "/x/." and links in its existing part resolve alike
    return [d for d in dirs if any(n(h) == n(d) or n(h).startswith(n(d).rstrip(os.sep) + os.sep) for h in hidden)]


def barrier():
    """How the script is fenced in here: sandbox-exec (macOS), bwrap (Linux, when it is installed and may make its
    namespaces) or none. A network namespace alone (unshare -rn) is not enough: it leaves the files readable and
    writable, so it counts as none and the review asks before every probe. Also none when the interpreter's folders
    are the user's home or above it: they could not be shown without showing the home."""
    if above(interp_dirs(), [user_home()]):
        return "none"
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        return "sandbox-exec"
    if sys.platform.startswith("linux") and shutil.which("bwrap"):
        root = tempfile.mkdtemp(prefix="pr-review-probe-check-")
        try:
            trial = subprocess.run([*bwrap_args(root), os.path.realpath(sys.executable), "-I", "-c", "pass"], capture_output=True, timeout=30)
            return "bwrap" if trial.returncode == 0 else "none"
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return "none"
        finally:
            shutil.rmtree(root, ignore_errors=True)
    return "none"


# Linux: what a probe sees of the machine, read-only (each only if it exists): the system's programs and libraries and
# the few files of /etc the loader and the clock need. Not /: that would show /run, /tmp and their sockets
# (docker.sock, the session bus) and every user's files.
SYSTEM_RO = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/localtime", "/etc/alternatives"]
EMPTY = ["/tmp", "/var/tmp", "/run", "/var/run", "/dev/shm"]  # empty tmpfs: no socket of the machine in them


def bwrap_args(root, extra_deny=(), dirs=None):
    """Linux: no namespace shared (network, PID, IPC, UTS, user, cgroup), no capability, a new session (no terminal to
    type into), dead with the runner; only the system folders above and the interpreter's own folders, read-only;
    empty tmpfs where sockets live; root (the probe's own folder) the one writable place. The user's home and the extra
    folders are simply not there. Refuses (ValueError) an interpreter folder that is a hidden one or above it."""
    hidden = [user_home(), *[os.path.realpath(d) for d in extra_deny]]
    dirs = interp_dirs() if dirs is None else dirs
    if above(dirs, hidden):
        raise ValueError(f"the interpreter's folder {above(dirs, hidden)[0]} would show the home")
    ro = [a for d in [*SYSTEM_RO, *dirs] for a in ("--ro-bind-try", d, d)]
    return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", *ro,
            "--dev", "/dev", "--proc", "/proc", *[a for d in EMPTY for a in ("--tmpfs", d)], "--bind", root, root]


# seccomp (Linux), on top: socket(AF_UNIX, …) fails with EACCES, so nothing in the probe can talk to a local service
# even if a socket were visible. Classic BPF over struct seccomp_data {int nr; u32 arch; u64 ip; u64 args[6]}.
# ponytail: x86_64 and aarch64 only (another CPU: no filter, the folders above still hide the sockets); the x32 ABI is
# not filtered.
SECCOMP_ARCH = {"x86_64": (0xC000003E, 41), "amd64": (0xC000003E, 41), "aarch64": (0xC00000B7, 198), "arm64": (0xC00000B7, 198)}


def no_unix_sockets(machine=None):
    arch = SECCOMP_ARCH.get((machine or platform.machine()).lower())
    if not arch:
        return None
    audit, nr = arch
    LD, JEQ, RET, ALLOW, EACCES = 0x20, 0x15, 0x06, 0x7FFF0000, 0x00050000 | 13
    prog = [(LD, 0, 0, 4), (JEQ, 0, 5, audit), (LD, 0, 0, 0), (JEQ, 0, 3, nr), (LD, 0, 0, 16), (JEQ, 0, 1, 1), (RET, 0, 0, EACCES), (RET, 0, 0, ALLOW)]
    return b"".join(struct.pack("=HBBI", *x) for x in prog)


# macOS: what a probe may read, besides its own folder and the interpreter's: the system's libraries and programs, the
# shared data (zoneinfo, locale) and the clock's files. Not /private/tmp, not the user's temporary folder, not other
# programs' output there, not /Volumes, not the home: an allowlist, as under Linux.
MAC_READ = ["/usr/lib", "/usr/bin", "/usr/share", "/System", "/dev", "/private/var/db/timezone"]
MAC_READ_FILES = ["/", "/private/etc/localtime"]  # these entries themselves, nothing under them (no /tmp: it is /private/tmp)
MAC_LINKS = ["/etc", "/var", "/tmp"]  # the root's links, metadata only: a path through them resolves, nothing is listed


def mac_reads():
    """The folders a probe reads on macOS: MAC_READ, the interpreter's own (interp_dirs, its prefix) and, for a
    Homebrew interpreter, Homebrew's Cellar and opt (the libraries it links against), never Homebrew's var (databases)."""
    exe = os.path.realpath(sys.executable)
    brew = re.match(r"(.*)/Cellar/", exe)
    return [*MAC_READ, *interp_dirs(), os.path.realpath(sys.base_prefix), *([f"{brew[1]}/Cellar", f"{brew[1]}/opt"] if brew else [])]


def profile(root, extra_deny=()):
    """macOS: no network (unix sockets too), no new process, writes only under root; reads only root, the folders of
    mac_reads and the entries of MAC_READ_FILES (an allowlist), plus the metadata of their parent folders (a path is
    resolved through them: their names and dates, no contents, no listing). Refuses (ValueError) an interpreter folder
    that is the user's home, an extra folder or above one."""
    q = lambda p: json.dumps(p)  # noqa: E731  (a quoted SBPL string)
    hidden = [user_home(), *[os.path.realpath(d) for d in extra_deny]]
    reads = mac_reads()
    if above(reads[len(MAC_READ):], hidden):
        raise ValueError(f"the interpreter's folder {above(reads[len(MAC_READ):], hidden)[0]} would show the home")
    allow = list(dict.fromkeys([os.path.realpath(root), *reads]))
    parents = sorted({a for d in allow for a in ancestors(d)})
    return "\n".join(["(version 1)", "(allow default)", "(deny network*)", "(deny process-fork)", "(deny file-write*)",
                      f"(allow file-write* (subpath {q(os.path.realpath(root))}) (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
                      "(deny file-read*)",
                      "(allow file-read* " + " ".join([*[f"(literal {q(f)})" for f in MAC_READ_FILES], *[f"(subpath {q(a)})" for a in allow]]) + ")",
                      "(allow file-read-metadata " + " ".join(f"(literal {q(a)})" for a in [*parents, *MAC_LINKS]) + ")",
                      *[f"(deny file-read* (subpath {q(h)}))" for h in hidden[1:]]])  # the test's extra folders, even inside an allowed one


def ancestors(path):
    out, p = [], path
    while p not in ("/", ""):
        p = os.path.dirname(p)
        out.append(p)
    return out


def run_one(script, export_dir, root, how, limit):
    """Runs the script in its export; → {status, strength, line, exit, ms, output}."""
    home, tmp = os.path.join(root, "home"), os.path.join(root, "tmp")
    os.makedirs(home), os.makedirs(tmp)
    env = ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", f"HOME={home}", f"TMPDIR={tmp}", "PYTHONDONTWRITEBYTECODE=1", "LANG=C.UTF-8"]
    cmd = [*env, os.path.realpath(sys.executable), "-I", script, export_dir]
    extra = [p for p in os.environ.get("PROBE_EXTRA_DENY", "").split(os.pathsep) if p]  # tests: more folders it may not read
    if how == "sandbox-exec":
        cmd = ["sandbox-exec", "-p", profile(root, extra), *cmd]
    fds = ()
    if how == "bwrap":
        prog = no_unix_sockets()
        if prog:  # the filter goes in through a pipe, which bwrap reads before the script starts
            r_fd, w_fd = os.pipe()
            os.write(w_fd, prog), os.close(w_fd)
            fds = (r_fd,)
        cmd = [*bwrap_args(root, extra), *(["--seccomp", str(fds[0])] if fds else []), *cmd]
    started, chunks, size = time.monotonic(), [], [0]
    p = subprocess.Popen(cmd, cwd=export_dir, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, pass_fds=fds)
    for fd in fds:
        os.close(fd)

    def read():  # keep the first READ_CAP bytes, stop the script once it writes more
        while True:
            b = p.stdout.read(4096)
            if not b:
                return
            if size[0] < READ_CAP:
                chunks.append(b[:READ_CAP - size[0]])
            size[0] += len(b)
            if size[0] > READ_CAP:
                kill(p)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        code, why = p.wait(timeout=limit), None
    except subprocess.TimeoutExpired:
        kill(p)
        code, why = p.wait(), f"stopped after {limit} s"
    reader.join(5)
    ms = int((time.monotonic() - started) * 1000)
    text = b"".join(chunks).decode("utf-8", "replace")
    if size[0] > READ_CAP:
        why = why or f"stopped: more than {READ_CAP // 1024} KB of output"
    found = [m for m in map(VERDICT.match, text.splitlines()) if m]
    if why or code not in (0, 1) or not found:
        status, line = "script_failed", why or (f"exit {code}" if code not in (0, 1) else "no line starting with reproduced or not_reproduced")
    else:
        word, line = found[-1].group(1), found[-1].group(2).strip()
        status = "reproduced" if word == "reproduced" else "not_reproduced"
    # Cut first, then black out (the patterns run on 4 KB, not on 64 KB of one word); a secret cut in two at the edge
    # is blacked out as far as it is shown.
    out = redact(text[:OUT_CAP + 200])[:OUT_CAP] + ("\n[cut at 4 KB]" if len(text) > OUT_CAP else "")
    return {"status": status, "line": redact(line[:400])[:300], "exit": code, "ms": ms, "output": out, "text": text}


def kill(p):
    try:
        os.killpg(p.pid, 9)
    except (ProcessLookupError, PermissionError):
        pass


def strength_of(script):
    """How strong a probe's evidence is, from its source as Python (ast), never from what it prints or from text in a
    docstring or comment: a module-level assignment MODELS_ENV = "<what it plays>" (it models part of the platform,
    for example a redelivery) → models_env; a call of threading.Barrier (it forces an interleaving) → forced_schedule;
    else it runs the PR's code as it is → runs_pr_code. A script that does not parse: runs_pr_code (it will fail)."""
    try:
        tree = ast.parse(script)
    except (SyntaxError, ValueError):
        return "runs_pr_code"
    if any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "MODELS_ENV" for t in n.targets)
           and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str) and n.value.value.strip() for n in tree.body):
        return "models_env"
    if any(isinstance(n, ast.Call) and ((isinstance(n.func, ast.Attribute) and n.func.attr == "Barrier") or (isinstance(n.func, ast.Name) and n.func.id == "Barrier"))
           for n in ast.walk(tree)):
        return "forced_schedule"
    return "runs_pr_code"


def base_verdict(b):
    """What the run on the base says: already_on_base (it reproduces there too), new_in_pr (the code it tests is not
    there: an ImportError or AttributeError, raised or reported), unknown (a TypeError: a signature that does not fit,
    or the script failed otherwise), not_on_base."""
    if b["status"] == "reproduced":
        return "already_on_base"
    text = b.get("text", "")
    if re.search(r"\b(ModuleNotFoundError|ImportError|AttributeError)\b", text):
        return "new_in_pr"
    if re.search(r"\bTypeError\b", text) or b["status"] == "script_failed":
        return "unknown"
    return "not_on_base"


def probe(checkout, pid, base=None, limit=LIMIT_S):
    """Runs probe pid on the checkout's HEAD (and on base); → the result, also written next to the script."""
    folder = os.path.join(checkout, PROBE_DIR)
    if os.path.islink(folder) or os.path.realpath(folder) != os.path.join(checkout, PROBE_DIR):
        raise ValueError(f"{PROBE_DIR} must be a plain folder in the checkout")
    script = os.path.join(folder, f"{pid}.py")
    if not os.path.lexists(script):
        raise NoScript(f"{PROBE_DIR}/{pid}.py is not there")
    try:  # opened without following a link, and what was opened is checked: nothing can be swapped in between
        fd = os.open(script, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise ValueError(f"{PROBE_DIR}/{pid}.py must be a plain file") from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError(f"{PROBE_DIR}/{pid}.py must be a plain file")
    with os.fdopen(fd, "rb") as f:
        code = f.read(SCRIPT_CAP + 1)
    if len(code) > SCRIPT_CAP:
        raise ValueError(f"{PROBE_DIR}/{pid}.py is larger than {SCRIPT_CAP // 1000} KB")
    head = commit_of(checkout, "HEAD")
    base_sha = commit_of(checkout, base) if base else None
    if not head or (base and not base_sha):
        raise ValueError(f"no commit for {'HEAD' if not head else base}")
    how = barrier()

    def on(sha):
        root = os.path.realpath(tempfile.mkdtemp(prefix="pr-review-probe-"))
        try:
            ex = os.path.join(root, "export")
            os.makedirs(ex)
            export(checkout, sha, ex)
            target = os.path.join(ex, PROBE_DIR, f"{pid}.py")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.lexists(target):
                os.remove(target)
            with open(target, "wb") as f:
                f.write(code)
            return run_one(target, ex, root, how, limit)
        finally:
            shutil.rmtree(root, ignore_errors=True)
    r = on(head)
    b = on(base_sha) if base_sha else None
    verdict = base_verdict(b) if b else None
    out = {"id": pid, **{k: r[k] for k in ("status", "line", "exit", "ms")}, "strength": strength_of(code.decode("utf-8", "replace")), "head": head,
           "base": {"rev": base_sha, **{k: b[k] for k in ("status", "line", "exit", "ms")}, "verdict": verdict} if b else None,
           "pre_existing": verdict == "already_on_base" and r["status"] == "reproduced",
           "network_barrier": how != "none", "sandbox": how, "output": r["output"], "at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
           "script": redact(code.decode("utf-8", "replace"))}  # what ran, for the review: it reads no file of the agent's folder itself
    return out


def main(argv):
    if argv == ["--barrier"]:  # the review asks before a probe when there is none
        print(barrier())
        return 0
    args, base = list(argv), None
    if "--base" in args:
        k = args.index("--base")
        if k + 1 >= len(args):
            return refuse("--base needs a revision")
        base = args.pop(k + 1)
        args.pop(k)
    if len(args) != 2 or not os.path.isabs(args[0]) or not os.path.isdir(args[0]):
        return refuse("usage: probe.py <checkout> <id> [--base <rev>]")
    checkout, pid = os.path.realpath(args[0]), args[1]
    if not ID.fullmatch(pid):
        return refuse("an id is 1 to 40 letters, digits, - and _")
    t = os.environ.get("PROBE_TIMEOUT", "")  # tests: a shorter limit, never a longer one
    limit = min(LIMIT_S, max(1, int(t))) if t.isdigit() else LIMIT_S
    try:
        print(json.dumps(probe(checkout, pid, base, limit), indent=1))
    except NoScript as e:
        return refuse(str(e), 3)
    except (ValueError, RuntimeError, OSError) as e:
        return refuse(str(e))
    return 0


def refuse(why, code=2):
    print(f"probe: refused: {why}", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
