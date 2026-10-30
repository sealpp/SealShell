"""Run the Tauri desktop app with Vue hot reload."""
import argparse
import json
import socket
from _tools import SHELL, cargo, run

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    options = parser.parse_args()
    cargo()
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", options.port))
        except OSError:
            parser.error(f"Port {options.port} is occupied. Select another with --port.")
    config = {"build": {"devUrl": f"http://127.0.0.1:{options.port}", "beforeDevCommand": f"npm run dev -- --port {options.port}"}}
    try:
        run(["node", "node_modules/@tauri-apps/cli/tauri.js", "dev", "--config", json.dumps(config)], SHELL)
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
