"""Run SealNode and Vite together; Ctrl+C stops both owned processes."""

import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def stop(_signal, _frame) -> None:
    raise KeyboardInterrupt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080, help="PWA port (default: 8080)")
    options = parser.parse_args()
    python = ROOT / "node/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    vite = ROOT / "shell/node_modules/vite/bin/vite.js"
    for artifact in (python, vite, ROOT / "node/seal/seal_pb2.py", ROOT / "shell/src/native/proto/seal_pb.ts"):
        if not artifact.exists():
            parser.error("Run python scripts/setup.py first.")
    for port in (int(os.environ.get("SEAL_PORT", "17373")), options.port):
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError:
                parser.error(f"Port {port} is occupied. Stop its service or select a different port.")
    # Separate process groups keep Ctrl+C in this supervisor so cleanup always
    # waits for the children to release their ports, including on Windows.
    process_options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                       if os.name == "nt" else {"start_new_session": True})
    with ExitStack() as cleanup:
        children = []
        for command, cwd in (
            ([str(python), "-u", "-m", "seal.main"], ROOT / "node"),
            (["node", str(vite), "--host", "127.0.0.1", "--port", str(options.port), "--strictPort"], ROOT / "shell"),
        ):
            child = subprocess.Popen(command, cwd=cwd, **process_options)
            children.append(child)
            cleanup.callback(child.wait)
            cleanup.callback(lambda proc=child: proc.terminate() if proc.poll() is None else None)
        print(f"Open http://127.0.0.1:{options.port}; pair with the code printed by SealNode.", flush=True)
        try:
            while all(child.poll() is None for child in children):
                time.sleep(0.25)
        except KeyboardInterrupt:
            print("\nStopping development servers...", flush=True)
            return 0
        return next(child.returncode for child in children if child.returncode is not None)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    if os.name == "nt":
        signal.signal(signal.SIGBREAK, stop)
    raise SystemExit(main())
