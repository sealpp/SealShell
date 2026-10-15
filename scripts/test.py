"""Run development checks and E2E without shell-specific commands."""

import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SHELL = ROOT / "shell"
E2E = ROOT / ".agents/skills/seal-e2e"


def run(command: list[str], cwd: Path = ROOT, overrides=None) -> None:
    print(f"> {' '.join(command)}", flush=True)
    env = os.environ.copy()
    env["PLAYWRIGHT_HTML_OPEN"] = "never"
    env.update(overrides or {})
    subprocess.run(command, cwd=cwd, env=env, check=True)


def ssh_e2e() -> None:
    test_host = os.environ.get("SEAL_E2E_HOST", "127.0.0.1")
    url = f"http://{test_host}:8081"
    with ExitStack() as cleanup:
        vite = subprocess.Popen([
            "node", "node_modules/vite/bin/vite.js", "--host", test_host,
            "--port", "8081", "--strictPort",
        ], cwd=SHELL)
        cleanup.callback(vite.wait)
        cleanup.callback(lambda: vite.terminate() if vite.poll() is None else None)
        deadline = time.monotonic() + 20
        while True:
            if vite.poll() is not None:
                raise RuntimeError(f"Vite exited with {vite.returncode}; check port 8081.")
            try:
                with urlopen(url, timeout=1):
                    break
            except (URLError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("Vite did not start within 20 seconds.")
                time.sleep(0.1)
        run(["node", str(E2E / "run-e2e.js")], overrides={"PWA_URL": url})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", nargs="?", default="all", choices=("all", "node", "unit", "ui", "files", "transfers", "ssh", "ssh-real", "proxy", "build"))
    options = parser.parse_args()
    npm = "npm.cmd" if os.name == "nt" else "npm"
    suites = ("node", "unit", "ui", "files", "ssh", "proxy", "build") if options.suite == "all" else (options.suite,)
    for suite in suites:
        ports = {"node": (17374,), "ui": (9324,), "files": (8081, 17373), "transfers": (8081, 17373), "ssh": (8081, 17373), "ssh-real": (8081, 17373), "proxy": (8081, 17373)}.get(suite, ())
        for port in ports:
            with socket.socket() as listener:
                try:
                    test_host = os.environ.get("SEAL_E2E_HOST", "127.0.0.1") if suite in ("files", "transfers", "ssh", "ssh-real", "proxy") else "127.0.0.1"
                    listener.bind((test_host, port))
                except OSError:
                    parser.error(f"Port {port} is occupied. Stop its service before running {suite} tests.")
        if suite == "node":
            run(["uv", "run", "--locked", "--extra", "dev", "python", "-m", "unittest", "discover", "-s", "tests", "-v"], ROOT / "node")
            run(["uv", "run", "--locked", "--extra", "dev", "python", "scripts/smoke_test.py"], ROOT / "node")
        elif suite in ("unit", "ui", "build"):
            script = {"unit": "test:unit", "ui": "test:e2e", "build": "build"}[suite]
            run([npm, "run", script], SHELL)
        elif suite == "files":
            run(["node", str(E2E / "run-files-e2e.js")])
        elif suite == "transfers":
            run(["node", str(E2E / "run-transfer-stress.js")])
        elif suite == "proxy":
            run(["node", str(E2E / "run-proxy-e2e.js")])
        elif suite == "ssh-real":
            run(["node", str(E2E / "run-ssh-directory-e2e.js")])
        else:
            ssh_e2e()


if __name__ == "__main__":
    main()
