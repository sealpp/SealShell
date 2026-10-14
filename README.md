# SealShell

<img src="shell/public/icon.svg" width="128" alt="SealShell Logo" />

Local-first PWA shell console. The PWA owns protocol clients, product logic, and product storage; SealNode provides authenticated localhost TCP/UDP transport and local filesystem primitives.

## Layout

- `node/` — Python SealNode: loopback WebSocket, pairing/device trust, opaque TCP/UDP transport, local file access.
- `shell/` — Vue 3 + Vite PWA, IndexedDB vault, WASM SSH client, telemetry providers, and UI.
- `contracts/` — protobuf contract for pairing, device authentication, multiplexed transport, and local filesystem requests.
- `me_SealShell/` — private architecture and design documentation (separate repository).

## Quick start

### SealNode

```bash
cd node
uv venv
uv pip install -e ".[dev]"
uv run python scripts/generate_proto.py
uv run python -m seal.main
```

The Node prints a six-digit pairing code and listens on `127.0.0.1:17373`. Device trust is kept in `seal-trust.json` beside the packaged executable (or beside `node/` in source mode). Set `SEAL_TRUST_PATH` to override the file path.

### PWA

In another shell:

```bash
cd shell
npm install
npm run gen:proto
npm run dev
```

Then open `http://127.0.0.1:8080`, enter the pairing code, and add a host. The PWA stores host profiles and encrypted credentials in the browser's IndexedDB. SSH protocol traffic is implemented by the PWA WASM client and transported through SealNode as opaque bytes.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEAL_HOST` | `127.0.0.1` | WebSocket listen host; only loopback addresses are accepted. |
| `SEAL_PORT` | `17373` | WebSocket listen port. |
| `SEAL_TRUST_PATH` | application directory + `seal-trust.json` | Node identity and paired device trust file. |

## Protocol generation

After changing `contracts/seal.proto`:

```bash
cd node && uv run python scripts/generate_proto.py
cd shell && npm run gen:proto
```

Generated files are not committed (see `.gitignore`).

## Smoke test

Run the Node-side test for pairing, device challenge authentication, and opaque TCP/UDP transport:

```bash
cd node
.venv/bin/python scripts/generate_proto.py
.venv/bin/python scripts/smoke_test.py
```

## Notes

- SealNode binds loopback only and rejects non-loopback listen addresses. The loopback boundary plus device challenge authentication are the security controls; there is no WebSocket Origin check.
- SSH, RDP, X11, and other client protocol implementations belong in the PWA. Adding a protocol does not require a SealNode protocol update.
- Paired devices can access local files with the SealNode process user’s permissions. File handles belong to their WebSocket connection; operations are bounded and run off the network event loop. SealNode does not expose local processes, TCP listeners, SOCKS, or reverse connections.
- The PWA vault uses AES-256-GCM records and a browser profile key for automatic unlock. Vault data is local to the browser profile; v0 has no export, backup, migration, or recovery path.
- Tabs and layout are runtime state. Refreshing the PWA closes active transport streams; host profiles, credentials, and pairing identity remain in IndexedDB.
