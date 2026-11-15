"""Run: python3 test_bytecode.py  (no network, no claude).

A file that appears in the mod's folder reloads the mod, and the view waiting for a script's result is gone. So no
script may leave a __pycache__ there: every entry script that imports a module of this folder sets
sys.dont_write_bytecode before the first such import."""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PENDING = {"verify.py"}  # gets the line from another branch; drop this once both are merged
scripts = [p for p in sorted(HERE.glob("*.py")) if not p.name.startswith("test_") and '__name__ == "__main__"' in p.read_text()]
siblings = "|".join(p.stem for p in HERE.glob("*.py"))
checked = []
for p in scripts:
    lines = p.read_text().splitlines()
    first = next((k for k, line in enumerate(lines) if re.match(rf"\s*(import|from)\s+({siblings})\b", line)), None)
    if first is None or p.name in PENDING:
        continue
    flag = next((k for k, line in enumerate(lines) if line.startswith("sys.dont_write_bytecode = True")), None)
    assert flag is not None and flag < first, f"{p.name}: sys.dont_write_bytecode = True must come before line {first + 1} ({lines[first].strip()})"
    checked.append(p.name)
assert {"review.py", "reviewers.py", "explore.py", "models.py", "triage.py"} <= set(checked), checked

# And for real: each of them run the way the app starts it (up to its __main__ part) leaves no file behind.
with tempfile.TemporaryDirectory() as d:
    for p in HERE.glob("*.py"):
        shutil.copy(p, d)
    before = sorted(os.listdir(d))
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
    for name in checked:
        r = subprocess.run([sys.executable, "-c", "import runpy, sys; runpy.run_path(sys.argv[1], run_name='started')", name], cwd=d, env=env, capture_output=True, text=True)
        assert r.returncode == 0, f"{name}: {r.stderr[-300:]}"
        assert sorted(os.listdir(d)) == before, f"{name} left {sorted(set(os.listdir(d)) - set(before))} in the mod's folder"
print("ok")
