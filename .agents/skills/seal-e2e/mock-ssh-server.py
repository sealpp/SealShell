import asyncio
import json
import os
import re
from pathlib import Path

import asyncssh


class MockSSHServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return True


call_count = {"shell": 0, "exec": 0, "probe": 0, "stat": 0}
state_path = os.environ.get("MOCK_SSH_STATE_PATH")
mock_sftp_root = Path(os.environ.get("MOCK_SFTP_ROOT", "/tmp/seal-mock-sftp"))
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


async def handle_shell(process: asyncssh.SSHServerProcess) -> None:
    call_count["shell"] += 1
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
