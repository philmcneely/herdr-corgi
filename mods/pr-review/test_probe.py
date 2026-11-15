"""Run: python3 test_probe.py  (a scratch repo, no network): the runner of the probe agents. Harmless probes give
their result; hostile ones (network, writes and reads outside, the environment, endless loops, forks, floods of
output, links out of the folder) get nowhere and still give a result the review can show."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
import probe  # noqa: E402

ME = str(pathlib.Path(__file__).with_name("probe.py"))
top = pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
repo, outside = top / "repo", top / "outside"
repo.mkdir(), outside.mkdir()
(outside / "secret.txt").write_text("TOPSECRET\n")
# The machine's own git settings (signing, hooks) stay out of the scratch repo.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
git = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t", *a], cwd=repo, capture_output=True, text=True, check=True, env=GIT_ENV)  # noqa: E731
git("init", "-q")
(repo / "lib.py").write_text("def mails(n):\n    return n\n")
git("add", "lib.py"), git("commit", "-qm", "base")
base = git("rev-parse", "HEAD").stdout.strip()
(repo / "lib.py").write_text("def mails(n):\n    return 2 * n  # the bug\n")
(repo / ".env").write_text("TOKEN=untracked\n")  # not tracked: never in the export
git("add", "lib.py"), git("commit", "-qm", "head")
(repo / probe.PROBE_DIR).mkdir()


def run(name, body, *extra, env=None, cli=False):
    """The probe through the command line (cli) or in this process (faster: one interpreter less per probe)."""
    (repo / probe.PROBE_DIR / f"{name}.py").write_text(body)
    env = env or {}
    if cli:
        r = subprocess.run([sys.executable, ME, str(repo), name, *extra], capture_output=True, text=True, env={**os.environ, **env}, timeout=120)
        return r.returncode, (json.loads(r.stdout) if r.returncode == 0 else r.stderr)
    saved = dict(os.environ)
    os.environ.update({k: v for k, v in env.items() if k != "PROBE_TIMEOUT"})
    try:
        return 0, probe.probe(str(repo), name, extra[1] if extra else None, int(env.get("PROBE_TIMEOUT", probe.LIMIT_S)))
    finally:
        os.environ.clear(), os.environ.update(saved)


HEADER = "import sys\nsys.path.insert(0, sys.argv[1])\nimport lib\n"
# A harmless probe: it reproduces on the head, not on the base; the result file sits next to the script.
code, r = run("double", HEADER + "n = lib.mails(10)\nprint('strength: forced_schedule')\nprint(f'reproduced mailer.send: {n} calls for 10 records' if n != 10 else f'not_reproduced {n} calls')\n", "--base", base, cli=True)
assert code == 0 and r["status"] == "reproduced" and r["line"] == "mailer.send: 20 calls for 10 records" and r["strength"] == "runs_pr_code", "what the script prints about its strength does not count"
assert r["base"]["status"] == "not_reproduced" and r["pre_existing"] is False and r["head"] and r["base"]["rev"] == base, r
assert json.loads((repo / probe.PROBE_DIR / "double.result.json").read_text())["status"] == "reproduced"
# The same failure on the base: there before this PR.
code, r = run("old", HEADER + "print('reproduced it returns', lib.mails(1) >= 1)\n", "--base", base)
assert r["status"] == "reproduced" and r["pre_existing"] is True, r
assert r["base"]["verdict"] == "already_on_base", r
# The strength comes from the script's source: a Barrier forces a schedule, MODELS_ENV says it models the platform.
assert probe.strength_of("import threading\nb = threading.Barrier(2)\n") == "forced_schedule"
assert probe.strength_of('MODELS_ENV = "SQS redelivers the whole batch"\nimport threading\nthreading.Barrier(2)\n') == "models_env"
assert probe.strength_of("print('strength: forced_schedule')\n# MODELS_ENV = 'x' in a comment\n") == "runs_pr_code"
assert probe.strength_of('"""Probe.\nMODELS_ENV = "a scheduler"\n"""\nprint(1)\n') == "runs_pr_code", "a docstring that mentions it is no assignment"
assert probe.strength_of('def f():\n    MODELS_ENV = "x"\n') == "runs_pr_code", "only at module level"
assert probe.strength_of('MODELS_ENV = ""\n') == "runs_pr_code", "an empty one says nothing"
assert probe.strength_of('from threading import Barrier\nb = Barrier(2)\n') == "forced_schedule"
assert probe.strength_of('s = "threading.Barrier(2)"\n') == "runs_pr_code", "a Barrier in a string is no Barrier"
assert probe.strength_of("def broken(:\n") == "runs_pr_code"
code, r = run("barrier", HEADER + "import threading\nb = threading.Barrier(1)\nb.wait()\nprint('reproduced', lib.mails(1))\n")
assert r["strength"] == "forced_schedule", r
# The base: the code it tests is not there (new in this PR), a signature that does not fit (unknown), not there.
(repo / "lib_new.py").write_text("def only_here():\n    return 1\n")
git("add", "lib_new.py"), git("commit", "-qm", "new module")
code, r = run("new", "import sys\nsys.path.insert(0, sys.argv[1])\nimport lib_new\nprint('reproduced', lib_new.only_here())\n", "--base", base)
assert r["status"] == "reproduced" and r["base"]["verdict"] == "new_in_pr" and r["pre_existing"] is False, r
code, r = run("sig", HEADER + "n = lib.mails(10)\nif n == 10:\n    lib.mails(1, 2)\nprint('reproduced', n)\n", "--base", base)
assert r["base"]["verdict"] == "unknown", r
code, r = run("caught", HEADER + "try:\n    lib.gone()\nexcept AttributeError as e:\n    print('not_reproduced not importable:', repr(e)); raise SystemExit(1)\nprint('reproduced')\n", "--base", base)
assert r["base"]["verdict"] == "new_in_pr", "an AttributeError the script reports itself counts too"
v = lambda status, text="": probe.base_verdict({"status": status, "text": text})  # noqa: E731
assert [v("reproduced"), v("not_reproduced"), v("script_failed", "ModuleNotFoundError: x"), v("script_failed", "TypeError: f() takes 1"), v("script_failed", "boom")] == \
    ["already_on_base", "not_on_base", "new_in_pr", "unknown", "unknown"]
# A crash, no verdict line or a bad exit code is script_failed, never not_reproduced.
for name, body in (("crash", "raise KeyError(7)\n"), ("silent", "print('hello')\n"), ("exit3", "print('reproduced x')\nraise SystemExit(3)\n")):
    code, r = run(name, body)
    assert code == 0 and r["status"] == "script_failed", (name, r)
# Only tracked files are exported: the untracked .env is not there.
code, r = run("env-file", "import os\nprint('reproduced' if os.path.exists('.env') else 'not_reproduced no .env in the export')\n")
assert r["status"] == "not_reproduced", r

if probe.barrier() == "sandbox-exec":
    assert r["network_barrier"] is True and r["sandbox"] == "sandbox-exec"
    # One hostile probe tries everything at once and names what got through: the network (a listener on this machine,
    # a name lookup and a connection out), writes outside its own folder (next to the checkout, in another folder),
    # reads from a denied folder and from the user's home, new processes (a fork bomb, a spawned command).
    # Other programs' files in /private/tmp (as the output of another Claude session) and in the user's own
    # temporary folder: the macOS sandbox reads from an allowlist, so none of them.
    other = pathlib.Path(tempfile.mkdtemp(dir="/private/tmp", prefix="claude-probe-test-")) / "out.txt"
    other.write_text("OTHER SESSION OUTPUT\n")
    mytmp = pathlib.Path(tempfile.mkdtemp()) / "note.txt"  # in $TMPDIR, the user's temporary folder
    mytmp.write_text("USER TMP\n")
    usock = tempfile.mkdtemp(dir="/tmp") + "/s"  # a short path: unix socket paths are short
    usrv = socket.socket(socket.AF_UNIX)
    usrv.bind(usock), usrv.listen(1)
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0)), srv.listen(5)
    threading.Thread(target=lambda: [srv.accept() for _ in range(5)], daemon=True).start()
    port, target, home = srv.getsockname()[1], outside / "written.txt", probe.user_home()
    hostile = f"""import os, socket, subprocess
got = []
def tries(name, fn):
    try:
        fn(); got.append(name)
    except Exception:
        pass
tries("local socket", lambda: socket.create_connection(("127.0.0.1", {port}), timeout=3))
tries("internet", lambda: (socket.getaddrinfo("example.com", 443), socket.create_connection(("example.com", 443), timeout=3)))
tries("write outside", lambda: open({str(target)!r}, "w").write("x"))
tries("write checkout", lambda: open({str(repo / 'pwned.txt')!r}, "w").write("x"))
tries("read denied", lambda: open({str(outside / 'secret.txt')!r}).read())
tries("read home", lambda: os.listdir({home!r}))
tries("list /private/tmp", lambda: os.listdir("/private/tmp"))
tries("list /tmp", lambda: os.listdir("/tmp"))
tries("read other session", lambda: open({str(other)!r}).read())
tries("list user tmp", lambda: os.listdir({str(mytmp.parent.parent)!r}))
tries("read user tmp", lambda: open({str(mytmp)!r}).read())
tries("list volumes", lambda: os.listdir("/Volumes"))
tries("read etc", lambda: open("/etc/hosts").read())
def bomb():
    for _ in range(50):
        if os.fork() == 0:
            os._exit(0)
tries("fork", bomb)
tries("spawn", lambda: subprocess.run(["/bin/echo", "hi"]))
def unix():
    u = socket.socket(socket.AF_UNIX)
    u.settimeout(3)
    u.connect({usock!r})
tries("unix socket", unix)
open("inside.txt", "w").write("fine")
print("reproduced got through: " + ", ".join(got) if got else "not_reproduced all blocked")
"""
    code, r = run("hostile", hostile)  # no extra folders: the allowlist alone keeps everything out
    assert r["status"] == "not_reproduced" and r["line"] == "all blocked", r
    assert not target.exists() and not (repo / "pwned.txt").exists() and "TOPSECRET" not in json.dumps(r), r
    assert "OTHER SESSION" not in json.dumps(r) and "USER TMP" not in json.dumps(r), r
    import shutil
    shutil.rmtree(other.parent, ignore_errors=True), shutil.rmtree(mytmp.parent, ignore_errors=True)
    # What the probes need still reads: the standard library with its compiled modules, the time zones, the clock.
    code, r = run("stdlib", "import zoneinfo, time, sqlite3, ssl, decimal, hashlib, json\nprint('reproduced', zoneinfo.ZoneInfo('Europe/Berlin'), time.localtime().tm_zone != '')\n")
    assert r["status"] == "reproduced", r
else:
    print(f"(no sandbox-exec here: {probe.barrier()}; the network, write, read and fork checks are skipped)")

# The environment: only PATH, HOME, TMPDIR and the locale reach the script; HOME is its own temporary folder.
code, r = run("environ", "import os\nprint('reproduced', sorted(os.environ), os.environ['HOME'])\n", env={"GH_TOKEN": "ghp_" + "x" * 30, "AWS_SECRET_ACCESS_KEY": "abc"})
assert r["status"] == "reproduced" and "GH_TOKEN" not in r["output"] and "AWS_" not in r["output"] and "pr-review-probe-" in r["line"], r
# An endless loop stops at the limit (shortened for the test), a flood of output at its cap; both are script_failed.
code, r = run("loop", "while True:\n    pass\n", env={"PROBE_TIMEOUT": "2"}, cli=True)
assert r["status"] == "script_failed" and "stopped after 2 s" in r["line"] and r["ms"] < 10000, r
code, r = run("flood", "import sys\nwhile True:\n    sys.stdout.write('x' * 10000)\n")
assert r["status"] == "script_failed" and "more than" in r["line"] and len(r["output"]) <= probe.OUT_CAP + 20, r
code, r = run("long", "print('y' * 9000)\nprint('reproduced long')\n")
assert r["status"] == "reproduced" and r["output"].endswith("[cut at 4 KB]"), r
# Secrets are blacked out of what is shown.
MAIL = "ada" + "@" + "example.com"  # built here, so the leak scan of the repo sees no address
code, r = run("leak", "print('" + MAIL + " ghp_' + 'a' * 36 + ' token=abc123 Bearer abcdefghijklmn AKIA' + 'A' * 16)\nprint('reproduced mail to " + MAIL + "')\n")
assert r["status"] == "reproduced" and "ada@" not in json.dumps(r) and "ghp_" not in r["output"] and "abc123" not in r["output"] and "AKIA" not in r["output"] and "token=[redacted]" in r["output"], r
assert probe.redact("password: hunter2 and x" + "@" + "y.io") == "password: [redacted] and [redacted]"

# Refused calls: a bad id, a script that is a link, a result path that is a link, the folder as a link, no checkout.
for bad in ["../x", "a/b", "*", "a b", "", "x" * 41]:  # the id is the script's file name: 1 to 40 letters, digits, - and _
    r = subprocess.run([sys.executable, ME, str(repo), bad], capture_output=True, text=True)
    assert r.returncode == 2 and "refused" in r.stderr, bad
assert probe.ID.fullmatch("ok_1-" + "y" * 35)
(outside / "evil.py").write_text("print('reproduced from outside')\n")
os.symlink(outside / "evil.py", repo / probe.PROBE_DIR / "linked.py")
r = subprocess.run([sys.executable, ME, str(repo), "linked"], capture_output=True, text=True)
assert r.returncode == 2 and "plain file" in r.stderr, r.stderr
(repo / probe.PROBE_DIR / "trap.py").write_text("print('reproduced x')\n")
os.symlink(outside / "victim.json", repo / probe.PROBE_DIR / "trap.result.json")
r = subprocess.run([sys.executable, ME, str(repo), "trap"], capture_output=True, text=True)
assert r.returncode == 2 and not (outside / "victim.json").exists(), r
r = subprocess.run([sys.executable, ME, "repo", "double"], capture_output=True, text=True)
assert r.returncode == 2
r = subprocess.run([sys.executable, ME, str(repo), "double", "--base", "--output=x"], capture_output=True, text=True)
assert r.returncode == 2 and "no commit" in r.stderr, r.stderr
other = top / "other"
other.mkdir(), subprocess.run(["git", "init", "-q"], cwd=other, check=True, env=GIT_ENV)
os.symlink(outside, other / probe.PROBE_DIR)
r = subprocess.run([sys.executable, ME, str(other), "evil"], capture_output=True, text=True)
assert r.returncode == 2 and "plain folder" in r.stderr, r.stderr
assert subprocess.run([sys.executable, ME, "--barrier"], capture_output=True, text=True).stdout.strip() == probe.barrier()
# The fence per machine, with stubs for the platform and the tools: sandbox-exec on macOS; on Linux bwrap only when
# it is there and may make its namespaces; a bare unshare (network only) is no fence.
import types  # noqa: E402
def fence(platform, tools, works=True):
    saved = (probe.sys, probe.shutil.which, probe.subprocess.run)
    probe.sys = types.SimpleNamespace(platform=platform, executable=sys.executable, prefix=sys.prefix, base_prefix=sys.base_prefix)
    probe.shutil.which = lambda name: f"/usr/bin/{name}" if name in tools else None
    calls = []
    probe.subprocess.run = lambda args, **k: calls.append(args) or types.SimpleNamespace(returncode=0 if works else 1)
    try:
        return probe.barrier(), calls
    finally:
        probe.sys, probe.shutil.which, probe.subprocess.run = saved
assert fence("darwin", {"sandbox-exec"})[0] == "sandbox-exec"
assert fence("darwin", set())[0] == "none"
how, calls = fence("linux", {"bwrap", "unshare"})
assert how == "bwrap" and calls[0][:3] == ["bwrap", "--unshare-all", "--die-with-parent"], calls
assert fence("linux", {"bwrap"}, works=False)[0] == "none", "bwrap that may not make namespaces"
assert fence("linux", {"unshare"})[0] == "none", "a network namespace alone is no fence"
assert fence("win32", {"bwrap"})[0] == "none"
# The bwrap call: nothing shared, no capability, a new session, death with the runner; not / but only the system folders
# and the interpreter's own ones, read-only; empty tmpfs over the places of sockets; the probe's folder writable last.
home = probe.user_home()
py = ["/opt/py/lib/python3.12", "/opt/py/bin"]
args = probe.bwrap_args("/tmp/pr-review-probe-x", ["/srv/secret"], dirs=py)
pairs = list(zip(args, args[1:], args[2:]))
assert args[:6] == ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"], args
assert ("--ro-bind", "/", "/") not in pairs and ("--ro-bind-try", "/", "/") not in pairs and "--share-net" not in args, "/ is never bound"
assert home not in args and "/srv/secret" not in args, "the home and the extra folders are simply not there"
for d in ["/usr", "/lib", "/etc/ld.so.cache", *py]:
    assert ("--ro-bind-try", d, d) in pairs, d
for d in probe.EMPTY:
    assert args[args.index(d) - 1] == "--tmpfs" and args.index(d) > args.index("--dev"), d
assert args[-3:] == ["--bind", "/tmp/pr-review-probe-x", "/tmp/pr-review-probe-x"]
# An interpreter folder that is the home or above it would show the home again: refused, and the machine counts as none.
for bad in ([home], [os.path.dirname(home)], ["/"], [*py, home + "/"]):
    try:
        probe.bwrap_args("/tmp/x", dirs=bad)
        raise AssertionError(bad)
    except ValueError:
        pass
assert probe.bwrap_args("/tmp/x", dirs=[home + "/.pyenv/versions/3.12/lib/python3.12"]), "a folder inside the home is fine: only it shows"
assert probe.above(["/", "/srv/people", "/srv/people/ann", "/srv/people/ann/.pyenv/lib", "/opt/py"], ["/srv/people/ann"]) == ["/", "/srv/people", "/srv/people/ann"]
saved = probe.interp_dirs
for platform, tools in (("darwin", {"sandbox-exec"}), ("linux", {"bwrap"})):
    probe.interp_dirs = lambda: ["/opt/py/bin", os.path.dirname(home)]
    try:
        assert fence(platform, tools)[0] == "none", platform
    finally:
        probe.interp_dirs = saved
probe.interp_dirs = lambda: ["/"]
try:
    probe.profile("/tmp/x")
    raise AssertionError("profile with / readable")
except ValueError:
    pass
finally:
    probe.interp_dirs = saved
assert "(subpath \"/\")" not in probe.profile("/tmp/x") and "base_prefix" not in probe.profile("/tmp/x")
# seccomp: socket(AF_UNIX, …) fails with EACCES on x86_64 and aarch64, everything else passes; another CPU: no filter.
def bpf(prog, arch, nr, arg0):
    """A small classic-BPF interpreter for the three instructions the filter uses."""
    import struct
    ins = [struct.unpack("=HBBI", prog[i:i + 8]) for i in range(0, len(prog), 8)]
    data = struct.pack("=iIQ6Q", nr, arch, 0, arg0, 0, 0, 0, 0, 0)
    acc, pc = 0, 0
    while True:
        code, jt, jf, k = ins[pc]
        if code == 0x20:
            acc = struct.unpack_from("=I", data, k)[0]
            pc += 1
        elif code == 0x15:
            pc += 1 + (jt if acc == k else jf)
        elif code == 0x06:
            return k
for machine, (audit, nr) in (("x86_64", (0xC000003E, 41)), ("aarch64", (0xC00000B7, 198))):
    prog = probe.no_unix_sockets(machine)
    assert bpf(prog, audit, nr, 1) == 0x0005000D, machine          # socket(AF_UNIX): EACCES
    assert bpf(prog, audit, nr, 2) == 0x7FFF0000, machine          # socket(AF_INET): allowed (the namespace has no network)
    assert bpf(prog, audit, nr + 1, 1) == 0x7FFF0000, machine      # another call with 1 as its first argument
    assert bpf(prog, 0x40000003, nr, 1) == 0x7FFF0000, machine     # another ABI: not this filter's business
assert probe.no_unix_sockets("riscv64") is None
print("ok")
