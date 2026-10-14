"""Connection-owned, bounded filesystem primitives. Recursive work stays in the PWA."""

from __future__ import annotations

import asyncio
import ctypes
import errno
import os
from pathlib import Path
import stat
import sys
from typing import Any

from seal.seal_pb2 import FsEntry, FsResponse

MAX_CHUNK = 60 * 1024
MAX_HANDLES = 64
MAX_PAGE_BYTES = 56 * 1024
MAX_PAGE_ENTRIES = 128


class FileError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def file_error(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, FileError):
        return exc.code, str(exc)[:4096]
    codes = {
        errno.ENOENT: "not_found", errno.EACCES: "permission_denied",
        errno.EPERM: "permission_denied", errno.EEXIST: "already_exists",
        errno.ENOTDIR: "not_directory", errno.EISDIR: "is_directory",
        errno.ENOTEMPTY: "not_empty", errno.EXDEV: "cross_device",
        errno.ENOSPC: "no_space", errno.ELOOP: "symlink_loop",
    }
    return codes.get(getattr(exc, "errno", None), "io_error"), str(exc)[:4096]


def rename_no_replace(source: str, target: str) -> None:
    # Checking exists() then rename() races with other connections/processes.
    # Windows rename already refuses replacement; POSIX needs an exclusive flag.
    if os.name == "nt":
        os.rename(source, target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        function = libc.renameat2
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = function(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    elif sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        function = libc.renamex_np
        function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = function(os.fsencode(source), os.fsencode(target), 4)
    else:
        raise FileError("unsupported", "Exclusive rename is unavailable on this platform")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), target)


def absolute(path: str) -> str:
    if not path or "\0" in path or not os.path.isabs(path):
        raise FileError("invalid_path", "An absolute local path is required")
    return os.path.abspath(path)


def entry(path: str, follow: bool = False) -> FsEntry:
    path = absolute(path)
    value = os.stat(path, follow_symlinks=follow)
    kind = "directory" if stat.S_ISDIR(value.st_mode) else "file" if stat.S_ISREG(value.st_mode) else "symlink" if stat.S_ISLNK(value.st_mode) else "unknown"
    if not follow and getattr(value, "st_reparse_tag", 0) in (0xA0000003, 0xA000000C):
        kind = "symlink"  # Windows junctions must not be recursively traversed.
    name = os.path.basename(path) or path
    hidden = name.startswith(".") or bool(getattr(value, "st_file_attributes", 0) & 2)
    return FsEntry(name=name, path=path, kind=kind, size=value.st_size,
                   modified_at_ms=value.st_mtime_ns // 1_000_000,
                   mode=stat.S_IMODE(value.st_mode), hidden=hidden)


class FileSession:
    def __init__(self, io_slots: asyncio.Semaphore):
        self._io_slots = io_slots
        self._lock = asyncio.Lock()
        self._handles: dict[int, tuple[str, Any]] = {}
        self._next_handle = 1

    async def execute(self, request: Any) -> FsResponse:
        # Serial execution per session makes seek/read/write/close ordered on
        # Windows as well as POSIX. The server drains these tasks on disconnect.
        async with self._lock, self._io_slots:
            try:
                return await asyncio.to_thread(self._execute, request)
            except (OSError, ValueError, OverflowError, FileError) as exc:
                code, message = file_error(exc)
                return FsResponse(error={"code": code, "message": message})

    async def close(self) -> None:
        async with self._lock, self._io_slots:
            await asyncio.to_thread(self._close_all)

    def _close_all(self) -> None:
        for handle in list(self._handles):
            self._close(handle)

    def _add(self, kind: str, value: Any) -> int:
        handle = self._next_handle
        self._next_handle += 1
        self._handles[handle] = (kind, value)
        return handle

    def _get(self, handle: int, kind: str | None = None) -> Any:
        resource = self._handles.get(handle)
        if resource is None or (kind is not None and resource[0] != kind):
            raise FileError("invalid_handle", "File handle is not open in this connection")
        return resource[1]

    def _close(self, handle: int) -> None:
        self._get(handle)
        kind, value = self._handles.pop(handle)
        if kind == "directory":
            value.close()
        else:
            os.close(value)

    def _execute(self, request: Any) -> FsResponse:
        op = request.WhichOneof("operation")
        if op is None:
            raise FileError("invalid_request", "A file operation is required")
        args = getattr(request, op)
        result = FsResponse()
        if op == "info":
            roots = [f"{letter}:\\" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{letter}:\\")] if os.name == "nt" else ["/"]
            result.info.platform = sys.platform
            result.info.home = str(Path.home())
            result.info.roots.extend(roots)
            result.info.max_chunk_bytes = MAX_CHUNK
            result.info.max_handles = MAX_HANDLES
        elif op == "stat":
            result.stat.CopyFrom(entry(args.path, args.follow_links))
        elif op in ("open", "open_directory"):
            if len(self._handles) >= MAX_HANDLES:
                raise FileError("resource_limit", "Too many open files or directories")
            path = absolute(args.path)
            if op == "open_directory":
                result.opened.handle = self._add("directory", os.scandir(path))
            else:
                if not args.write and (args.create or args.truncate or args.exclusive):
                    raise FileError("invalid_request", "Creating or truncating requires write access")
                flags = os.O_WRONLY if args.write else os.O_RDONLY
                flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
                if args.create:
                    flags |= os.O_CREAT
                if args.exclusive:
                    flags |= os.O_EXCL
                fd = os.open(path, flags, 0o666)
                try:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        raise FileError("unsupported", "Only regular files can be opened")
                    if args.truncate:
                        os.ftruncate(fd, 0)
                except Exception:
                    os.close(fd)
                    raise
                result.opened.handle = self._add("write" if args.write else "read", fd)
        elif op == "read_directory":
            iterator = self._get(args.handle, "directory")
            result.directory.SetInParent()
            while len(result.directory.entries) < MAX_PAGE_ENTRIES and result.ByteSize() < MAX_PAGE_BYTES:
                item = next(iterator, None)
                if item is None:
                    result.directory.eof = True
                    self._close(args.handle)
                    break
                try:
                    value = entry(item.path)
                except FileNotFoundError:
                    continue  # Entries can disappear while enumerating a live directory.
                if value.ByteSize() > 4096:
                    raise FileError("resource_limit", "Directory entry exceeds the message budget")
                result.directory.entries.add().CopyFrom(value)
        elif op == "read":
            if not 0 < args.length <= MAX_CHUNK:
                raise FileError("invalid_request", "Invalid read block size")
            fd = self._get(args.handle, "read")
            os.lseek(fd, args.offset, os.SEEK_SET)
            result.read.payload = os.read(fd, args.length)
            result.read.eof = not result.read.payload or args.offset + len(result.read.payload) >= os.fstat(fd).st_size
        elif op == "write":
            if not 0 < len(args.payload) <= MAX_CHUNK:
                raise FileError("invalid_request", "Invalid write block size")
            fd = self._get(args.handle, "write")
            os.lseek(fd, args.offset, os.SEEK_SET)
            data = memoryview(args.payload)
            written = 0
            while written < len(data):
                count = os.write(fd, data[written:])
                if count == 0:
                    raise FileError("io_error", "File write made no progress")
                written += count
            result.written.bytes_written = written
        else:
            if op == "close":
                self._close(args.handle)
            elif op == "mkdir":
                os.mkdir(absolute(args.path))
            elif op == "remove":
                path = absolute(args.path)
                if stat.S_ISDIR(os.lstat(path).st_mode) and not os.path.islink(path):
                    os.rmdir(path)
                else:
                    os.unlink(path)
            elif op == "rename":
                source, target = absolute(args.source), absolute(args.target)
                if args.replace:
                    if not os.path.isfile(source) or (os.path.lexists(target) and not os.path.isfile(target)):
                        raise FileError("unsupported", "Replace only supports files")
                    os.replace(source, target)
                else:
                    rename_no_replace(source, target)
            elif op == "set_time":
                path = absolute(args.path)
                os.utime(path, ns=(os.stat(path).st_atime_ns, args.modified_at_ms * 1_000_000))
            elif op == "read_link":
                result.link.target = os.readlink(absolute(args.path))
                return result
            elif op == "symlink":
                os.symlink(args.target, absolute(args.path), target_is_directory=args.directory)
            else:
                raise FileError("unsupported", f"Unknown file operation: {op}")
            result.success.SetInParent()
        return result
