"""Install frontend and Python test-fixture dependencies; Rust/MSVC are prerequisites."""
import argparse
import os
import shutil
from _tools import ROOT, SHELL, cargo, environment, npm, run

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-browser", action="store_true")
    options = parser.parse_args()
    cargo()
    if not shutil.which("uv"):
        parser.error("Install uv and add it to PATH first.")
    run(["uv", "sync", "--locked"])
    run(npm("ci", "--no-audit", "--no-fund"), SHELL)
    if not options.skip_browser:
        env = environment()
        env.setdefault("PLAYWRIGHT_DOWNLOAD_HOST", "https://registry.npmmirror.com/-/binary/playwright")
        env["PLAYWRIGHT_SKIP_BROWSER_GC"] = "1"
        run(["node", "node_modules/playwright/cli.js", "install", "chromium"], SHELL, env)
    print("Ready. Run: python scripts/dev.py")

if __name__ == "__main__":
    main()
