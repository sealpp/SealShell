import asyncio
import codecs
import json
import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

import asyncssh


class MockSSHServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        expected = os.environ.get("MOCK_SSH_PASSWORD")
        return expected is None or password == expected


call_count = {"shell": 0, "exec": 0, "probe": 0, "stat": 0}
state_path = os.environ.get("MOCK_SSH_STATE_PATH")
bash_path = os.environ.get("MOCK_SSH_BASH")
mock_sftp_root = Path(os.environ.get("MOCK_SFTP_ROOT", str(Path(tempfile.gettempdir()) / "seal-mock-sftp")))
mock_sftp_root.mkdir(parents=True, exist_ok=True)
(mock_sftp_root / "README.md").write_text("SealShell SFTP mock\n", encoding="utf-8")
SAMPLE_COMMAND = (
    "printf '__SEAL_CPU__\\n'; cat /proc/stat; "
    "printf '__SEAL_MEM__\\n'; free -b; "
    "printf '__SEAL_DISK__\\n'; df -P -k /; "
    "printf '__SEAL_PROCS__\\n'; ps -eo pid"
)


def sample_output() -> str:
    call_count["stat"] += 1
    write_state()
    total = 600 + call_count["stat"] * 100
    idle = 400 + call_count["stat"] * 20
    return (
        "__SEAL_CPU__\n"
        f"cpu  {total - idle - 100} 0 100 {idle}\n"
        "__SEAL_MEM__\n"
        "Mem: 16000000000 4000000000 4000000000 0 2000000000 12000000000\n"
        "__SEAL_DISK__\n"
        "Filesystem 1K-blocks Used Available Use% Mounted on\n"
        "/dev/sda1 100000 40000 60000 40% /\n"
        "__SEAL_PROCS__\n"
        "PID\n1\n2\n3\n"
    )


def write_state() -> None:
    if state_path:
        Path(state_path).write_text(json.dumps(call_count), encoding="utf-8")


def command_output(command: str) -> tuple[str, int]:
    if command == "printf 'SEAL_BASH_VERSION=%s\\n' \"$BASH_VERSION\"":
        if bash_path:
            result = subprocess.run([bash_path, "--noprofile", "--norc", "-c", command], capture_output=True, text=True)
            return result.stdout, result.returncode
        return "SEAL_BASH_VERSION=\n", 0
    if command == "uname -s":
        call_count["probe"] += 1
        write_state()
        return "Linux\n", 0
    if command == "printf exec-ok":
        return "exec-ok", 0
    if command == SAMPLE_COMMAND:
        return sample_output(), 0
    if command == "echo smoke-ok":
        return "smoke-ok\n", 0
    return f"unknown command: {command}\n", 1


async def handle_bash(process: asyncssh.SSHServerProcess, startup_command: str | None = None) -> None:
    call_count["shell"] += 1
    shell_id = str(call_count["shell"])
    write_state()
    args = ["--noprofile", "--norc", "-c", startup_command] if startup_command else ["--noprofile", "--norc", "-i"]
    bash = await asyncio.create_subprocess_exec(
        bash_path, *args, cwd=mock_sftp_root,
        env={**os.environ, "HISTFILE": str(mock_sftp_root / "bash-history"), "CHERE_INVOKING": "1"},
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )

    async def forward_input() -> None:
        while True:
            try:
                data = await process.stdin.read(4096)
            except asyncssh.TerminalSizeChanged:
                continue
            if not data:
                bash.stdin.close()
                return
            bash.stdin.write(data.encode())
            await bash.stdin.drain()

    async def forward_output() -> None:
        pending = ""
        decoder = codecs.getincrementaldecoder("utf-8")()
        while data := await bash.stdout.read(4096):
            text = decoder.decode(data)
            process.stdout.write(text)
            pending += text
            for match in re.finditer(r"\x1b\]1337;CurrentDir=([^\x07]*)\x07", pending):
                call_count.setdefault("shell_cwds", {})[shell_id] = match[1]
                write_state()
            start = pending.rfind("\x1b]")
            pending = pending[start:] if start > pending.rfind("\x07") else ""

    tasks = [asyncio.create_task(forward_input()), asyncio.create_task(forward_output())]
    try:
        await bash.wait()
        await tasks[1]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if bash.returncode is None:
            bash.terminate()
            await bash.wait()


async def handle_shell(process: asyncssh.SSHServerProcess) -> None:
    if bash_path:
        await handle_bash(process)
        return
    call_count["shell"] += 1
    shell_id = str(call_count["shell"])
    cwd = "/"

    def report_cwd() -> None:
        if not os.environ.get("MOCK_SSH_REPORT_CWD"):
            return
        call_count.setdefault("shell_cwds", {})[shell_id] = cwd
        process.stdout.write(f"\x1b]7;file://mock{quote(cwd, safe='/')}\x07")
        write_state()

    report_cwd()
    write_state()
    while True:
        try:
            line = await process.stdin.readline()
        except asyncssh.TerminalSizeChanged:
            # PTY window changes are stream events, not shell termination.
            continue
        if not line:
            return
        # sshclient-wasm needs a non-empty first write to trigger PTY/shell
        # startup. We use a leading VSTART (0x11) or NUL (0x00) byte for that;
        # it is not a real command and should be stripped before execution.
        command = line.lstrip("\x00\x11").strip()
        if not command:
            continue
        if command.startswith("cd "):
            args = shlex.split(command)
            directory = args[2] if len(args) == 3 and args[1] == "--" else args[1]
            if not directory.startswith("/"):
                process.stderr.write("cd: expected an absolute directory\n")
                continue
            cwd = directory
            report_cwd()
            continue
        if command == "pwd":
            process.stdout.write(f"{cwd}\n")
            continue
        marker = re.search(
            r"printf '(__SEAL_EXEC_START_[A-Za-z0-9]+__)\\n'; (.*); status=\$\?; printf '\\n(__SEAL_EXEC_END_[A-Za-z0-9]+__)%s\\n'",
            command,
        )
        if marker:
            start, inner, end = marker.groups()
            output, status = command_output(inner)
            process.stdout.write(f"{start}\n")
            process.stdout.write(output)
            process.stdout.write(f"\n{end}{status}\n")
            continue
        output, status = command_output(command)
        process.stdout.write(output)
        if status:
            process.exit(status)
            return


async def handle_process(process: asyncssh.SSHServerProcess) -> None:
    command = (process.command or "").strip()
    if bash_path and command.startswith('exec "$BASH" --init-file '):
        await handle_bash(process, command)
        return
    if command:
        call_count["exec"] += 1
        write_state()
        output, status = command_output(command)
        process.stdout.write(output)
        if status:
            process.exit(status)
        else:
            process.exit(0)
        return
    await handle_shell(process)


async def main() -> int:
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    server = await asyncssh.listen(
        host="127.0.0.1",
        port=0,
        server_host_keys=[host_key],
        process_factory=handle_process,
        # AsyncSSH's built-in SFTP server exercises the same v3 operations as
        # the browser backend (list/stat/read/write/rename/unlink/symlink).
        sftp_factory=lambda channel: asyncssh.SFTPServer(channel, chroot=str(mock_sftp_root)),
        server_factory=MockSSHServer,
    )
    port = server.sockets[0].getsockname()[1]
    print(f"MOCK_SSH_PORT={port}", flush=True)
    await asyncio.Event().wait()
    return 0


if __name__ == "__main__":
    asyncio.run(main())
