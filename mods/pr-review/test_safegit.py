"""Run: python3 test_safegit.py  (a scratch repo, no network): the read-only git of the model runs."""
import pathlib
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import safegit  # noqa: E402

no = lambda cmd, *a: safegit.refused(cmd, list(a))  # noqa: E731
refused = [
    # paths outside the checkout, with or without an option (git diff turns into --no-index on its own)
    ("diff", ["/etc/hosts", "README.md"]), ("diff", ["~/.ssh/known_hosts", "/dev/null"]), ("diff", ["~/x", "a.py"]), ("diff", ["../x", "a.py"]),
    ("diff", ["../../x", "y"]), ("diff", ["a/../../x", "a.py"]), ("diff", [".."]), ("diff", [".. "]), ("diff", ["HEAD", "--", "../x"]), ("diff", ["..\\x"]),
    ("show", ["HEAD:../x"]), ("show", ["HEAD:/etc/hosts"]), ("show", [":/fix"]), ("log", ["-L1,5:/etc/hosts"]), ("log", ["-L", "1,5:../x"]),
    ("status", ["/tmp"]), ("diff", ["-"]),
    # options that read or write a file, run a program, or move git elsewhere; also abbreviated and unknown ones
    ("diff", ["--no-index", "a", "b"]), ("diff", ["--ou=x"]), ("diff", ["--output=x"]), ("diff", ["--ext", "HEAD"]), ("diff", ["--ext-diff"]),
    ("diff", ["--textconv"]), ("diff", ["-Ox", "HEAD"]), ("diff", ["--orderfile=x"]), ("diff", ["--relative=../"]), ("diff", ["-C", "/x"]),
    ("diff", ["-c", "core.pager=sh"]), ("log", ["--git-dir=/x"]), ("log", ["--work-tree=/x"]), ("blame", ["--con", "x", "a.py"]),
    ("blame", ["--contents", "x", "a.py"]), ("blame", ["-S", "revs", "a.py"]), ("blame", ["--ignore-revs-file=x", "a.py"]), ("ls-files", ["-X", "x"]),
    ("ls-files", ["--exclude-from=x"]), ("rev-parse", ["--resolve-git-dir", "x"]), ("rev-parse", ["--git-path", "x"]), ("diff", ["-pO"]),
    ("diff", ["--stat=x"]), ("log", ["--format"]),
    # an option split differently than git would: a bare optional-value option, a value that is an option, a path as value
    ("diff", ["-U", "--output=/tmp/x"]), ("diff", ["-U"]), ("status", ["-u", "--output=x"]), ("diff", ["-M", "HEAD"]), ("blame", ["-M", "a.py"]),
    ("log", ["-n", "-c"]), ("log", ["-n"]), ("log", ["-L", "-/etc/hosts"]), ("log", ["-S", "--output=x"]), ("log", ["-n-c"]), ("log", ["-G", "-x"]),
    ("log", ["--format=/etc/hosts"]), ("log", ["--grep=../x"]), ("log", ["-S", "~/x"]), ("diff", ["--unified=/x"]), ("log", ["--grep", "x"]),
    ("diff", ["-pU", "x"]), ("diff", ["-wM"]),
    # other commands
    ("grep", ["x"]), ("config", ["--list"]), ("checkout", ["x"]), ("-C", ["/x", "log"]),
]
for cmd, args in refused:
    assert no(cmd, *args), (cmd, args)
allowed = [
    ("diff", ["base..head", "--", "lib/x.py"]), ("diff", ["origin/main...HEAD", "--stat"]), ("log", ["--oneline", "-5"]), ("show", ["HEAD:lib/x.py"]),
    ("blame", ["-L", "1,5", "lib/x.py"]), ("log", ["-Sneedle", "--format=%H"]), ("log", ["-S", "needle"]), ("diff", ["--exit-code", "--name-only"]),
    ("ls-files", []), ("rev-parse", ["--short", "HEAD"]), ("merge-base", ["HEAD", "origin/main"]), ("status", ["--short"]), ("status", ["-uno"]),
    ("log", ["--follow", "--", "lib/x.py"]), ("log", ["-n", "3", "-L", "1,5:lib/x.py"]), ("diff", ["-pw", "-U3", "HEAD~1"]), ("show", ["--stat", "HEAD"]),
    ("log", ["--grep=fix ../ in text", "--author=a"]), ("diff", ["--merge-base", "origin/main"]),
    ("diff", ["-U0", "-M50%", "HEAD~1"]), ("status", ["-uno"]), ("log", ["-n", "5", "-S", "needle", "-G", "a.b"]), ("blame", ["-M", "-L", "1,5", "a.py"][1:]),
    ("diff", ["--unified=3", "--find-renames"]), ("log", ["--date=format:%Y-%m-%d"]),
]
for cmd, args in allowed:
    assert no(cmd, *args) is None, (cmd, args, no(cmd, *args))

# Run for real in a scratch repo: a file outside is never read, an inside diff works, the root must be absolute.
top = pathlib.Path(tempfile.mkdtemp())
(top / "outside.txt").write_text("SECRET\n")
repo = top / "repo"
repo.mkdir()
run = lambda *a: subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, check=True)  # noqa: E731
run("init", "-q")
(repo / "a.py").write_text("x = 1\n")
run("-c", "user.name=t", "-c", "user.email=t", "add", "a.py")
run("-c", "user.name=t", "-c", "user.email=t", "commit", "-qm", "one")
me = str(pathlib.Path(__file__).with_name("safegit.py"))
call = lambda *a: subprocess.run([sys.executable, me, *a], capture_output=True, text=True)  # noqa: E731
for args in (["diff", str(top / "outside.txt"), "a.py"], ["diff", "../outside.txt", "a.py"]):
    out = call(str(repo), *args)
    assert out.returncode == 2 and "SECRET" not in out.stdout + out.stderr and "refused" in out.stderr, args
assert call(str(repo), "log", "--oneline").stdout.strip().endswith("one")
assert call(str(repo), "show", "HEAD:a.py").stdout == "x = 1\n"
assert call("repo", "log").returncode == 2 and call(str(repo / "nowhere"), "log").returncode == 2, "the checkout is an absolute, existing folder"

# regular-file: what an editor may open for a PR that is not trusted. One tracked regular file passes, as the path the
# disk has; a folder, a symlink, a submodule, an untracked file, a pattern and a path out of the checkout do not.
import os  # noqa: E402
real = os.path.realpath(repo)
(repo / "src").mkdir(); (repo / "src" / "only.py").write_text("y = 1\n"); (repo / "sp ace").mkdir(); (repo / "sp ace" / "ä b.txt").write_text("z\n")
os.symlink("/etc/hosts", repo / "link"); os.symlink("/etc", repo / "dirlink"); (repo / "untracked.txt").write_text("u\n")
run("add", "src", "sp ace", "link", "dirlink")
run("update-index", "--add", "--cacheinfo", f"160000,{run('rev-parse', 'HEAD').stdout.strip()},vendor/lib")
is_file = lambda rel: call(str(repo), "regular-file", rel)  # noqa: E731
for rel in ("a.py", "src/only.py", "sp ace/ä b.txt", "./src/only.py"):
    out = is_file(rel)
    assert out.returncode == 0 and out.stdout == os.path.join(real, os.path.normpath(rel)), (rel, out.stdout, out.stderr)
for rel in ("src", "src/", "link", "dirlink", "dirlink/hosts", "vendor/lib", "untracked.txt", "src/*.py", "*.py", "missing.py", "../outside.txt", str(top / "outside.txt"), ".", "a.py\nx"):
    out = is_file(rel)
    assert out.returncode == 1 and out.stdout == "", (rel, out.stdout)
assert call(str(repo), "regular-file").returncode == 1 and call(str(repo), "regular-file", "a.py", "src/only.py").returncode == 1, "one path"
# Two names of the PR that are one name on a disk that ignores case: `notes.md` a file, `NOTES.md` a symlink out of
# the checkout. The index says "regular file" for notes.md whatever the disk holds; the disk decides. With the
# symlink there (as that name on a disk that ignores case, as notes.md itself otherwise), nothing is opened; with the
# file there, the file is.
blob = lambda text: subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=repo, input=text, capture_output=True, text=True, check=True).stdout.strip()  # noqa: E731
run("update-index", "--add", "--cacheinfo", f"100644,{blob('notes\n')},notes.md"); run("update-index", "--add", "--cacheinfo", f"120000,{blob('/etc/hosts')},NOTES.md")
os.symlink("/etc/hosts", repo / "NOTES.md")
if not (repo / "notes.md").is_symlink():  # a disk that tells the two names apart: the same state by the one name
    os.symlink("/etc/hosts", repo / "notes.md")
assert is_file("notes.md").returncode == 1 and is_file("NOTES.md").returncode == 1, "the index's regular file is a symlink on disk"
for name in ("NOTES.md", "notes.md"):
    if (repo / name).is_symlink():
        os.unlink(repo / name)
(repo / "notes.md").write_text("notes\n")
assert is_file("notes.md").stdout == os.path.join(real, "notes.md")
print("ok")
