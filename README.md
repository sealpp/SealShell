# SealShell

<img src="shell/public/icon.svg" width="128" alt="SealShell Logo" />

A Windows desktop SSH workbench built with Tauri, Vue, and Rust. Includes terminals, local/SFTP files, Monaco editing, monitoring, process management, local port forwarding, and optional AI command suggestions.

Install the Windows setup executable to use SealShell. It includes the application and the WebView2 prerequisite; the destination computer needs no development tools. This iteration uses fresh configuration and has no automatic updater or old-data migration.

For development, install Node.js 22+, Rust stable (MSVC), Visual Studio C++ build tools, Python 3.11+, and uv:

```text
python scripts/setup.py
python scripts/dev.py
```

Vue changes reload during desktop development. Use `python scripts/dev.py --port 8081` if the default port is occupied.

```text
python scripts/test.py unit
python scripts/test.py native
python scripts/test.py ui
python scripts/test.py desktop
python scripts/build.py
```

The installer is written to `target/release/bundle/nsis/`. Rust code lives in `runtime/`, the desktop host in `shell/src-tauri/`, and Vue in `shell/src/`. Architecture and design documentation remain in the separate private repository.
