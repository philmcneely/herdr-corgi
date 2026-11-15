# Run: python3 test_lsp_bridge.py   (pure helpers, then a throwaway bridge in a temp HERDR_APP_HOME: token, paths, idle exit)
import json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lsp_bridge as b

root = os.path.realpath(HERE)
assert b.inside(root, "main.js") == os.path.join(root, "main.js")
assert b.inside(root, "../x") is None and b.inside(root, "/etc/passwd") is None
assert b.preview("a\nb\nc\nd\ne", 2, 1, 1) == (2, ["b", "c", "d"])
assert b.preview("a\nb", 0, 3, 8) == (1, ["a", "b"])
assert b.hover_text({"kind": "markdown", "value": "**x**"}) == "**x**"
assert b.hover_text([{"language": "go", "value": "func F()"}, "doc"]) == "```go\nfunc F()\n```\n\ndoc"
assert b.hover_text(None) == ""
assert b.ext_of("/a/b.TSX") == "tsx" and b.ext_of("/a/Makefile") == ""
assert b.jdt_name("jdt://contents/rt.jar/java.util/List.class?=x") == "java.util.List"

# Bounded storage: LRU by last use, count and byte caps, 14-day expiry, unknown dirs dropped, in-use dirs kept.
data = tempfile.mkdtemp()
b.DATA, b.INDEX = data, os.path.join(data, "lsp-index.json")
b.LIMITS = {"jdtls": (2, 3000)}
now = time.time()
idx = {}
for name, age_days, size in [("a", 1, 1000), ("b", 2, 1000), ("c", 3, 1000), ("old", 20, 10), ("big", 0.5, 5000)]:
    os.makedirs(os.path.join(data, "jdtls", name))
    open(os.path.join(data, "jdtls", name, "f"), "wb").write(b"x" * size)
    idx[f"jdtls/{name}"] = {"root": f"/r/{name}", "last": now - age_days * 86400}
os.makedirs(os.path.join(data, "jdtls", "legacy"))
json.dump(idx, open(b.INDEX, "w"))
removed = b.prune(keep={"jdtls/c"})
assert sorted(os.listdir(os.path.join(data, "jdtls"))) == ["a", "c"], os.listdir(os.path.join(data, "jdtls"))
assert sorted(removed) == ["jdtls/b", "jdtls/big", "jdtls/legacy", "jdtls/old"], removed
assert set(b.load_index()) == {"jdtls/a", "jdtls/c"}
assert b.forget_dirs("/r/a") == ["jdtls/a"] and not os.path.exists(os.path.join(data, "jdtls", "a"))

# Logs rotate: at most LOG_CAP plus one backup.
b.LOG_CAP = 1000
lg = b.CappedLog(os.path.join(data, "x.log"))
for _ in range(100):
    lg.write("y" * 99 + "\n")
assert os.path.getsize(os.path.join(data, "x.log")) <= 1100 and os.path.getsize(os.path.join(data, "x.log.1")) <= 1100

# Repo identity: same repo id for a checkout's worktrees (slot "wt"), stable across paths.
repo = tempfile.mkdtemp()
git = lambda *a, cwd=repo: subprocess.run(["git", *a], cwd=cwd, capture_output=True, check=True)
git("init", "-q"); git("-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "x")
git("worktree", "add", "-q", ".worktrees/review")
main_id, wt_id = b.repo_id(repo), b.repo_id(os.path.join(repo, ".worktrees", "review"))
assert main_id.endswith("-main") and wt_id.endswith("-wt") and main_id[:-5] == wt_id[:-3], (main_id, wt_id)
assert b.throwaway(os.path.join(repo, ".worktrees", "review")) and not b.throwaway(repo)
# The review worktree in Herdr's folder for worktrees (<worktrees>/<repo>/pr-review): a linked worktree of that name.
# A main checkout that happens to be called pr-review is not one.
central = os.path.join(tempfile.mkdtemp(), "x", "pr-review")
git("worktree", "add", "-q", "--detach", central)
named = os.path.join(tempfile.mkdtemp(), "pr-review"); os.makedirs(named); git("init", "-q", cwd=named)
assert b.throwaway(central) and b.throwaway(central + os.sep) and not b.throwaway(named) and not b.throwaway(os.path.dirname(central))

# Symbols and references (the Impact picture): the pure parts, then both endpoints against a stand-in language server.
L = ["def total(items, rate):", "x = total(a,", "   b(1), \")\",", "   c)", "const f = async (a,", "  b) => 1", "class A:", "y = name"]
assert [b.span_end(L, 0, 4), b.span_end(L, 1, 4), b.span_end(L, 4, 6), b.span_end(L, 6, 6), b.span_end(L, 7, 4), b.span_end(L, 9, 0)] == [0, 3, 5, 6, 7, 9]
rng = lambda a, b_, c=0, d=0: {"start": {"line": a, "character": c}, "end": {"line": b_, "character": d}}
tree = [{"name": "Cart", "kind": 5, "range": rng(0, 6), "selectionRange": rng(0, 0, 6, 10), "children": [
            {"name": "add", "kind": 6, "range": rng(1, 4, 4, 0), "selectionRange": rng(1, 1, 8, 11), "children": [{"name": "local", "kind": 13, "range": rng(2, 2), "selectionRange": rng(2, 2)}]}]},
        {"name": "RATE", "kind": 14, "range": rng(7, 7), "selectionRange": rng(7, 7)}, {"name": "", "kind": 12, "range": rng(8, 8)}]
src = ["class Cart:", "    def add(self, x,", "            y):", "        local = 1", "", "", "", "RATE = 2"]
flat = b.flat_symbols(tree, src)
assert [(x["name"], x["kind"], x["container"], x["line"], x["end"], x["nameLine"], x["character"], x["sigEnd"]) for x in flat] == [
    ("Cart", "class", "", 1, 6, 1, 6, 1), ("add", "method", "Cart", 2, 4, 2, 8, 3), ("RATE", "constant", "", 8, 8, 8, 0, 8)], flat  # a function's locals are left out; an end at column 0 is the line before
old_form = b.flat_symbols([{"name": "add", "kind": 12, "containerName": "Cart", "location": {"uri": "file:///x", "range": rng(1, 3, 4, 9)}}], src)
assert (old_form[0]["nameLine"], old_form[0]["character"], old_form[0]["container"], old_form[0]["sigEnd"]) == (2, 8, "Cart", 3), old_form

fake = os.path.join(tempfile.mkdtemp(), "fake_ls.py")
open(fake, "w").write('''import json, os, sys
def send(m):
    body = json.dumps(m).encode(); sys.stdout.buffer.write(b"Content-Length: %d\\r\\n\\r\\n" % len(body) + body); sys.stdout.buffer.flush()
root = None
while True:
    n = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line in (b"\\r\\n", b"\\n"): break
        if line.lower().startswith(b"content-length:"): n = int(line.split(b":")[1])
    m = json.loads(sys.stdin.buffer.read(n)); meth = m.get("method")
    if meth == "initialize": root = m["params"]["rootPath"]; send({"jsonrpc": "2.0", "id": m["id"], "result": {"capabilities": {}}})
    elif meth == "textDocument/documentSymbol":
        r = lambda a, b: {"start": {"line": a, "character": 4}, "end": {"line": b, "character": 9}}
        send({"jsonrpc": "2.0", "id": m["id"], "result": [{"name": "total", "kind": 12, "range": r(0, 1), "selectionRange": r(0, 0)}]})
    elif meth == "textDocument/references":
        assert m["params"]["context"] == {"includeDeclaration": False}
        at = lambda p, l, c=4: {"uri": "file://" + p, "range": {"start": {"line": l, "character": c}, "end": {"line": l, "character": c + 5}}}
        send({"jsonrpc": "2.0", "id": m["id"], "result": [at(root + "/b.py", 2), at(root + "/b.py", 2, 20), at(root + "/b.py", 0, 14), at("/etc/hosts", 1), at(root + "/node_modules/x/y.py", 0),
             at(root + "/.venv/z.py", 0), at(root + "/link.py", 0), at(root + "/a.py", 9)]})
    elif "id" in m: send({"jsonrpc": "2.0", "id": m["id"], "result": None})
''')
proj = os.path.realpath(tempfile.mkdtemp())
for name, text in [("a.py", "def total(items):\n    return 1\n"), ("b.py", "from a import total\n\nx = total(1,\n    2)\n"), ("node_modules/x/y.py", "total()\n"), (".venv/z.py", "total()\n"), ("notes.txt", "x")]:
    os.makedirs(os.path.dirname(os.path.join(proj, name)), exist_ok=True)
    open(os.path.join(proj, name), "w").write(text)
os.symlink("/etc/hosts", os.path.join(proj, "link.py"))  # a link out of the checkout is outside it
b.SERVERS = {**b.SERVERS, "python": [sys.executable, fake]}
br = b.Bridge()
try:
    got = br.symbols({"root": proj, "path": "a.py"})
    assert got["status"] == "ok" and got["server"] == "Python" and [(x["name"], x["line"], x["end"], x["sigEnd"]) for x in got["symbols"]] == [("total", 1, 2, 1)], got
    refs = br.references({"root": proj, "path": "a.py", "line": 1, "character": 4})
    # Inside the checkout only, one per line, with the line's text and where the call's bracket closes; a place past
    # the end of its file has no text. Outside: /etc/hosts, the link to it, node_modules, the dot folder.
    assert refs["references"] == [{"path": "a.py", "line": 10, "character": 4, "end": 10, "text": ""}, {"path": "b.py", "line": 1, "character": 14, "end": 1, "text": "from a import total"},
                                  {"path": "b.py", "line": 3, "character": 4, "end": 4, "text": "x = total(1,"}], refs
    assert (refs["outside"], refs["more"], refs["status"]) == (4, 0, "ok"), refs
    b.MAX_REFS = 1
    assert [len(br.references({"root": proj, "path": "a.py", "line": 1, "character": 4})[k]) if k == "references" else br.references({"root": proj, "path": "a.py", "line": 1, "character": 4})[k] for k in ("references", "more")] == [1, 2]
    for fn in (br.symbols, br.references):  # the same gate as hover and definition
        assert fn({"root": proj, "path": "notes.txt"})["status"] == "unsupported"
        for bad in ({"root": proj, "path": "../x.py"}, {"root": proj, "path": "link.py"}, {"root": "rel", "path": "a.py"}, {"root": proj, "path": "/etc/hosts"}):
            try:
                fn(bad); raise AssertionError(f"{fn.__name__} took {bad}")
            except PermissionError:
                pass
    try:  # Rust stays off for someone else's code
        br.references({"root": proj, "path": "a.rs"}); raise AssertionError("no file, no server")
    except PermissionError:
        pass
    open(os.path.join(proj, "m.rs"), "w").write("fn main() {}\n")
    try:
        br.symbols({"root": proj, "path": "m.rs"}); raise AssertionError("rust-analyzer started for untrusted code")
    except RuntimeError as e:
        assert "off for someone else's code" in str(e), e
finally:
    br.stop_all()
print("lsp_bridge symbols and references ok")

home = tempfile.mkdtemp()
env = {**os.environ, "HERDR_APP_HOME": home, "LSP_BRIDGE_IDLE": "4"}
st = json.loads(subprocess.run([sys.executable, os.path.join(HERE, "lsp_bridge.py"), "start"], env=env, capture_output=True, text=True).stdout)
state = os.path.join(home, "pr-data", "lsp-bridge.json")
assert oct(os.stat(state).st_mode & 0o777) == "0o600"


def post(path, body, headers):
    req = urllib.request.Request(f"http://127.0.0.1:{st['port']}{path}", data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


ok = {"X-Bridge-Token": st["token"]}
assert post("/status", {}, {})[0] == 403
assert post("/status", {}, {"X-Bridge-Token": "x"})[0] == 403
assert post("/status", {}, {**ok, "Origin": "http://evil"})[0] == 403
assert post("/status", {}, ok) == (200, post("/status", {}, ok)[1]) and post("/status", {}, ok)[1]["servers"] == []
assert post("/hover", {"root": root, "path": "../../../.ssh/config", "line": 1}, ok)[1]["message"] == "path is not a file inside root"
assert post("/hover", {"root": "relative", "path": "main.js"}, ok)[1]["message"] == "root is not a local folder"
assert post("/definition", {"root": root, "path": "AGENTS.md" if os.path.exists(os.path.join(root, "AGENTS.md")) else "mod.json", "line": 1}, ok)[1]["status"] == "unsupported"
assert post("/contents", {"root": root, "uri": "file:///etc/hosts"}, ok)[0] == 400
for path in ("/symbols", "/references"):
    assert post(path, {"root": root, "path": "main.js"}, {})[0] == 403
    assert post(path, {"root": root, "path": "../../../.ssh/config", "line": 1}, ok) == (400, {"status": "error", "message": "path is not a file inside root"})
    assert post(path, {"root": root, "path": "mod.json", "line": 1}, ok)[1]["status"] == "unsupported"
time.sleep(10)
assert not os.path.exists(state), "bridge should exit after idling"
print("lsp_bridge ok")

# The bridge goes with the process that started it (Herdr): `start` names its parent as the owner.
home = tempfile.mkdtemp()
env = {**os.environ, "HERDR_APP_HOME": home, "LSP_BRIDGE_OWNER_CHECK": "0.5"}
herdr = subprocess.Popen([sys.executable, "-c", "import subprocess, sys; subprocess.run([sys.executable, sys.argv[1], 'start']); import time; time.sleep(60)",
                          os.path.join(HERE, "lsp_bridge.py")], env=env, stdout=subprocess.DEVNULL)
state = os.path.join(home, "pr-data", "lsp-bridge.json")
for _ in range(100):
    if os.path.exists(state): break
    time.sleep(0.1)
pid = json.load(open(state))["pid"]
assert b.alive(pid)
herdr.kill(); herdr.wait()
for _ in range(60):
    if not b.alive(pid): break
    time.sleep(0.1)
assert not b.alive(pid) and not os.path.exists(state), "bridge should exit once its owner is gone"
print("lsp_bridge owner ok")
