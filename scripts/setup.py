"""Install locked development dependencies and generate protocol bindings."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], cwd: Path, env=None) -> None:
    print(f"> {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-browser", action="store_true", help="Use an installed Chrome/Edge for E2E")
    options = parser.parse_args()
    for tool in ("uv", "node", "npm.cmd" if os.name == "nt" else "npm"):
        if not shutil.which(tool):
            parser.error(f"Install {tool} and add it to PATH first (Node.js >=22, Python >=3.11).")
    run(["uv", "sync", "--locked", "--extra", "dev"], ROOT / "node")
    run(["npm.cmd" if os.name == "nt" else "npm", "ci", "--no-audit", "--no-fund"], ROOT / "shell")
    python = ROOT / "node/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run([str(python), "scripts/generate_proto.py", "--typescript"], ROOT / "node")
    if not options.skip_browser:
        env = os.environ.copy()
        env.setdefault("PLAYWRIGHT_DOWNLOAD_HOST", "https://registry.npmmirror.com/-/binary/playwright")
        env["PLAYWRIGHT_SKIP_BROWSER_GC"] = "1"
        run(["node", "node_modules/playwright/cli.js", "install", "chromium"], ROOT / "shell", env)
    print("Ready. Run: python scripts/dev.py", flush=True)


if __name__ == "__main__":
    main()
