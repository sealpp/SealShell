"""Shared Windows development tool discovery (no product runtime dependency)."""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SHELL = ROOT / "shell"

def environment():
    env = os.environ.copy()
    cargo_bin = Path.home() / ".cargo" / "bin"
    env["PATH"] = str(cargo_bin) + os.pathsep + env.get("PATH", "")
    env["PLAYWRIGHT_HTML_OPEN"] = "never"
    return env

def run(command, cwd=ROOT, env=None):
    print("> " + " ".join(map(str, command)), flush=True)
    subprocess.run(list(map(str, command)), cwd=cwd, env=env or environment(), check=True)

def cargo():
    executable = shutil.which("cargo", path=environment()["PATH"])
    if not executable:
        raise RuntimeError("Install Rust stable with the MSVC toolchain first.")
    return executable

def npm(*args):
    executable = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not executable:
        raise RuntimeError("Install Node.js >=22 first.")
    return [executable, *args]

def python_fixture():
    return ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
