import { FileOperationError } from '../files/types'
import createLibssh2Module, { type LIBSSH2_CHANNEL, type LIBSSH2_SESSION, type SSH2WASMModule } from '@verdigris/libssh2.js'
import { RoutedTransport } from '../transport/routed-transport'
import type { ProxyConnection } from '../transport/types'

const EAGAIN = -37
// Emscripten's WASI errno value for EAGAIN, returned by the custom socket callback.
const SOCKET_EAGAIN = -6
const CALLBACK_SEND = 5
const CALLBACK_RECV = 6
const BUFFER_SIZE = 64 * 1024

// libssh2_sftp_open() takes LIBSSH2_FXF_* protocol flags. These are distinct
// from the POSIX O_* values (for example, CREAT is 0x08 and TRUNC is 0x10).
const SFTP_FXF_WRITE = 0x00000002
const SFTP_FXF_CREAT = 0x00000008
const SFTP_FXF_TRUNC = 0x00000010

function kindFromMode(mode: number): 'file' | 'directory' | 'symlink' | 'unknown' {
  const type = mode & 0o170000
  if (type === 0o040000) return 'directory'
  if (type === 0o120000) return 'symlink'
  if (type === 0o100000 || type === 0) return 'file'
  return 'unknown'
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function readCString(module: SSH2WASMModule, pointer: number, maxBytes?: number): string {
  if (!pointer) return ''
  const heap = module.HEAPU8
  const end = maxBytes === undefined ? heap.length : Math.min(heap.length, pointer + maxBytes)
  let cursor = pointer
  while (cursor < end && heap[cursor] !== 0) cursor += 1
  return textDecoder.decode(heap.subarray(pointer, cursor))
}

function allocateCString(module: SSH2WASMModule, value: string): number {
  const bytes = textEncoder.encode(value)
  const pointer = module._malloc(bytes.length + 1)
  module.HEAPU8.set(bytes, pointer)
  module.HEAPU8[pointer + bytes.length] = 0
  return pointer
}

export class Libssh2Error extends Error {
  constructor(readonly code: number, message: string) {
    super(`${code}: ${message}`)
    this.name = 'Libssh2Error'
  }
}

function errorFor(module: SSH2WASMModule, session: LIBSSH2_SESSION, fallback: string): Libssh2Error {
  const code = module.ssh2_session_last_errno(session)
  const rawMessage = (module as any).ssh2_session_last_error(session)
  const message = typeof rawMessage === 'number' ? readCString(module, rawMessage) || fallback : rawMessage || fallback
  return new Libssh2Error(code, message)
}

export interface Libssh2SessionOptions {
  host: string
  port: number
  username: string
  password: string
  proxy?: ProxyConnection
  onHostKey?: (publicKey: Uint8Array) => Promise<boolean>
}

export class Libssh2Session {
  readonly transport = new RoutedTransport()
  private module!: SSH2WASMModule
  private session: LIBSSH2_SESSION = 0
  private channel: LIBSSH2_CHANNEL = 0
  private sftp: number = 0
  private closed = false
  private readonly incoming: Uint8Array[] = []
  private readonly outputHandlers = new Set<(payload: Uint8Array) => void>()
  private handshakeBytes = new Uint8Array()

  async connect(options: Libssh2SessionOptions): Promise<void> {
    this.module = await createLibssh2Module({
      locateFile: () => '/libssh2.wasm',
      ALLOW_MEMORY_GROWTH: true,
      customSend: (ptr, length) => {
        if (!this.module || this.closed) return -1
        const payload = this.module.HEAPU8.slice(ptr, ptr + length)
        void this.transport.send(payload).catch((error) => this.transport.close(error instanceof Error ? error.message : 'transport send failed'))
        return length
      },
      customRecv: (ptr, length) => {
        const payload = this.incoming.shift()
        if (!payload) return SOCKET_EAGAIN
        const chunk = payload.subarray(0, length)
        this.module.HEAPU8.set(chunk, ptr)
        if (chunk.length < payload.length) this.incoming.unshift(payload.subarray(chunk.length))
        return chunk.length
      },
    })
    if (this.module.ssh2_init() !== 0) throw new Error('libssh2 initialization failed')
    this.session = this.module.ssh2_session_init()
    if (!this.session) throw new Error('libssh2 session allocation failed')
    this.module.ssh2_session_set_blocking(this.session, 0)
    this.module.ssh2_session_callback_set_custom(this.session, CALLBACK_SEND)
    this.module.ssh2_session_callback_set_custom(this.session, CALLBACK_RECV)
    this.transport.onData((payload) => {
      if (this.handshakeBytes.length < 256 * 1024) {
        const merged = new Uint8Array(this.handshakeBytes.length + payload.length)
        merged.set(this.handshakeBytes)
        merged.set(payload, this.handshakeBytes.length)
        this.handshakeBytes = merged
      }
      this.incoming.push(payload)
      this.outputHandlers.forEach((handler) => handler(payload))
    })
    await this.transport.connect(options.host, options.port, options.proxy)
    const handshake = await this.pump(() => this.module.ssh2_session_handshake_custom(this.session))
    if (handshake !== 0) throw errorFor(this.module, this.session, 'SSH handshake failed')
    if (options.onHostKey) {
      const hostKey = this.readHostKey()
      if (!hostKey) throw new Libssh2Error(-10, 'SSH host key was not exposed by libssh2')
      if (hostKey && !await options.onHostKey(hostKey)) throw new Error('remote host key was rejected')
    }
    const auth = await this.withStrings([options.username, options.password], ([username, password]) => this.pump(() => (this.module as any).ssh2_userauth_password(this.session, username, password)))
    if (auth !== 0) throw errorFor(this.module, this.session, 'SSH password authentication failed')
  }

  onRawData(handler: (payload: Uint8Array) => void): () => void {
    this.outputHandlers.add(handler)
    return () => this.outputHandlers.delete(handler)
  }

  async openShell(columns: number, rows: number): Promise<void> {
    this.channel = await this.pumpHandle(() => this.module.ssh2_channel_open_session(this.session))
    if (!this.channel) throw errorFor(this.module, this.session, 'SSH channel open failed')
    await this.withStrings(['xterm-256color'], ([term]) => this.pump(() => (this.module as any).ssh2_channel_request_pty(this.channel, term)))
    const size = await this.pump(() => this.module.ssh2_channel_request_pty_size(this.channel, columns, rows))
    if (size !== 0) throw errorFor(this.module, this.session, 'SSH PTY resize failed')
    const shell = await this.pump(() => this.module.ssh2_channel_shell(this.channel))
    if (shell !== 0) throw errorFor(this.module, this.session, 'SSH shell start failed')
  }

  async write(payload: Uint8Array): Promise<void> {
    if (!this.channel) throw new Error('SSH shell is not open')
    const ptr = this.module._malloc(payload.length)
    try {
      this.module.HEAPU8.set(payload, ptr)
      let offset = 0
      while (offset < payload.length) {
        const written = await this.pump(() => this.module.ssh2_channel_write(this.channel, ptr + offset, payload.length - offset))
        if (written < 0) throw errorFor(this.module, this.session, 'SSH channel write failed')
        offset += written
      }
    } finally {
      this.module._free(ptr)
    }
  }

  async resize(columns: number, rows: number): Promise<void> {
    if (!this.channel) return
    const result = await this.pump(() => this.module.ssh2_channel_request_pty_size(this.channel, columns, rows))
    if (result !== 0) throw errorFor(this.module, this.session, 'SSH PTY resize failed')
  }

  pollShellOutput(): Uint8Array {
    if (!this.channel || this.closed) return new Uint8Array()
    const buffer = this.module._malloc(BUFFER_SIZE)
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const read = this.module.ssh2_channel_read(this.channel, buffer, BUFFER_SIZE)
        if (read <= 0) break
        chunks.push(this.module.HEAPU8.slice(buffer, buffer + read))
      }
    } finally {
      this.module._free(buffer)
    }
    if (!chunks.length) return new Uint8Array()
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const output = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }
    return output
  }

  async exec(command: string): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    const channel = await this.pumpHandle(() => this.module.ssh2_channel_open_session(this.session))
    if (!channel) throw errorFor(this.module, this.session, 'SSH exec channel open failed')
    const stdout: number[] = []
    const stderr: number[] = []
    const buffer = this.module._malloc(BUFFER_SIZE)
    try {
      const started = await this.withStrings([command], ([commandPtr]) => this.pump(() => (this.module as any).ssh2_channel_exec(channel, commandPtr)))
      if (started !== 0) throw errorFor(this.module, this.session, 'SSH exec failed')
      let idle = 0
      while (idle < 2_000) {
        const read = this.readChannelNow(channel, buffer, false)
        const readErr = this.readChannelNow(channel, buffer, true)
        if (read.length) stdout.push(...read)
        if (readErr.length) stderr.push(...readErr)
        if (!read.length && !readErr.length) {
          if (this.module.ssh2_channel_eof(channel)) break
          idle += 1
          await this.transport.waitForData(25)
        } else idle = 0
      }
      const exitCode = this.module.ssh2_channel_get_exit_status(channel)
      return { stdout: Uint8Array.from(stdout), stderr: Uint8Array.from(stderr), exitCode }
    } finally {
      this.module.ssh2_channel_close(channel)
      this.module.ssh2_channel_free(channel)
      this.module._free(buffer)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      // SFTP owns a channel and allocates through its parent session.
      // Release it while that session and its callbacks are still alive.
      if (this.sftp) {
        this.module.ssh2_sftp_shutdown(this.sftp)
        this.sftp = 0
      }
      if (this.channel) {
        this.module.ssh2_channel_close(this.channel)
        this.module.ssh2_channel_free(this.channel)
        this.channel = 0
      }
      if (this.session) {
        await this.withStrings(['application closed'], ([reason]) => this.pump(() => (this.module as any).ssh2_session_disconnect(this.session, reason)))
        this.module.ssh2_session_free(this.session)
        this.session = 0
      }
      this.module?.ssh2_exit()
    } finally {
      await this.transport.close()
    }
  }

  private async pump(call: () => number): Promise<number> {
    while (true) {
      const result = call()
      if (result !== EAGAIN) return result
      if (!this.incoming.length) await this.transport.waitForData()
    }
  }

  private async pumpHandle(call: () => number): Promise<number> {
    while (true) {
      const handle = call()
      if (handle) return handle
      if (this.module.ssh2_session_last_errno(this.session) !== EAGAIN) return handle
      if (!this.incoming.length) await this.transport.waitForData()
    }
  }

  async initSftp(): Promise<void> {
    const handle = await this.pumpHandle(() => this.module.ssh2_sftp_init(this.session))
    if (!handle) throw errorFor(this.module, this.session, 'SFTP subsystem initialization failed')
    this.sftp = handle
  }

  async listDirectory(path: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'unknown'; size: number; modifiedAt: number; mode?: number; target?: string }>> {
    if (!this.sftp) throw new Error('SFTP subsystem is not initialized')
    const handle = await this.withStrings([path], ([pathPtr]) => this.pumpHandle(() => (this.module as any).ssh2_sftp_opendir(this.sftp, pathPtr)))
    if (!handle) throw errorFor(this.module, this.session, 'SFTP directory open failed')
    const namePtr = this.module._malloc(4096)
    const longPtr = this.module._malloc(8192)
    const attrsPtr = this.module._malloc(64)
    const entries: Array<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'unknown'; size: number; modifiedAt: number; mode?: number }> = []
    try {
      while (true) {
        const result = await this.pump(() => (this.module as any).ssh2_sftp_readdir(handle, namePtr, 4096, longPtr, 8192, attrsPtr))
        if (result === 0) break
        if (result < 0) throw errorFor(this.module, this.session, 'SFTP directory read failed')
        const name = readCString(this.module, namePtr)
        if (!name || name === '.' || name === '..') continue
        const attrs = this.readAttributes(attrsPtr)
        entries.push({ name, kind: kindFromMode(attrs.permissions), size: attrs.filesize, modifiedAt: attrs.mtime * 1000, mode: attrs.permissions })
      }
      return entries
    } finally {
      this.closeSftpHandle(handle)
      this.module._free(namePtr)
      this.module._free(longPtr)
      this.module._free(attrsPtr)
    }
  }

  async statPath(path: string): Promise<{ size: number; modifiedAt: number; mode: number; kind: 'file' | 'directory' | 'symlink' | 'unknown' }> {
    const attrsPtr = this.module._malloc(64)
    try {
      const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_stat(this.sftp, pathPtr, attrsPtr)))
      if (result !== 0) {
        const code = (this.module as any)._ssh2_sftp_last_error(this.sftp)
        throw new FileOperationError(code === 2 ? 'not_found' : code === 3 ? 'permission_denied' : 'io_error', `SFTP stat failed (${code}): ${path}`)
      }
      const parsed = this.readAttributes(attrsPtr)
      return { size: parsed.filesize, modifiedAt: parsed.mtime * 1000, mode: parsed.permissions, kind: kindFromMode(parsed.permissions) }
    } finally { this.module._free(attrsPtr) }
  }

  async readPath(path: string, offset = 0, length = 256 * 1024): Promise<ArrayBuffer> {
    const handle = await this.openFile(path, 0, 0)
    const buffer = this.module._malloc(length)
    try {
      if (offset) (this.module as any).ssh2_sftp_seek64(handle, BigInt(offset))
      const result = await this.pump(() => this.module.ssh2_sftp_read(handle, buffer, length))
      if (result < 0) throw errorFor(this.module, this.session, 'SFTP read failed')
      return this.module.HEAPU8.slice(buffer, buffer + result).buffer
    } finally {
      this.closeSftpHandle(handle)
      this.module._free(buffer)
    }
  }

  async writePath(path: string, payload: ArrayBuffer, offset = 0): Promise<void> {
    const handle = await this.openFile(path, SFTP_FXF_WRITE | SFTP_FXF_CREAT | (offset === 0 ? SFTP_FXF_TRUNC : 0), 0o644)
    const data = new Uint8Array(payload)
    const ptr = this.module._malloc(Math.max(1, data.length))
    try {
      if (offset) (this.module as any).ssh2_sftp_seek64(handle, BigInt(offset))
      this.module.HEAPU8.set(data, ptr)
      let written = 0
      while (written < data.length) {
        const result = await this.pump(() => this.module.ssh2_sftp_write(handle, ptr + written, data.length - written))
        if (result <= 0) throw errorFor(this.module, this.session, 'SFTP write failed')
        written += result
      }
    } finally {
      this.closeSftpHandle(handle)
      this.module._free(ptr)
    }
  }

  async mkdirPath(path: string): Promise<void> {
    const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_mkdir(this.sftp, pathPtr, 0o755)))
    if (result !== 0) throw errorFor(this.module, this.session, 'SFTP mkdir failed')
  }

  async removePath(path: string, recursive = false): Promise<void> {
    if (recursive) {
      const stat = await this.statPath(path)
      if (stat.kind === 'directory') {
        for (const child of await this.listDirectory(path)) await this.removePath(`${path.replace(/\/$/, '')}/${child.name}`, child.kind === 'directory')
        const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_rmdir(this.sftp, pathPtr)))
        if (result !== 0) throw errorFor(this.module, this.session, 'SFTP directory removal failed')
        return
      }
    }
    const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_unlink(this.sftp, pathPtr)))
    if (result !== 0) throw errorFor(this.module, this.session, 'SFTP remove failed')
  }

  async renamePath(source: string, target: string, overwrite = false): Promise<{ atomic: boolean }> {
    const extended = (this.module as any).ssh2_sftp_posix_rename_ex
    if (overwrite && extended) {
      const result = await this.withStrings([source, target], ([sourcePtr, targetPtr]) => this.pump(() => extended(this.sftp, sourcePtr, source.length, targetPtr, target.length, 1)))
      if (result !== 0) throw errorFor(this.module, this.session, 'SFTP atomic rename failed')
      return { atomic: true }
    }
    const result = await this.withStrings([source, target], ([sourcePtr, targetPtr]) => this.pump(() => (this.module as any).ssh2_sftp_rename(this.sftp, sourcePtr, targetPtr)))
    if (result !== 0) throw errorFor(this.module, this.session, 'SFTP rename failed')
    return { atomic: !overwrite }
  }

  async chmodPath(path: string, mode: number): Promise<void> {
    const attrsPtr = this.module._malloc(64)
    try {
      const view = new DataView(this.module.HEAPU8.buffer)
      view.setUint32(attrsPtr, 4, true)
      view.setUint32(attrsPtr + 24, mode, true)
      const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_setstat(this.sftp, pathPtr, attrsPtr)))
      if (result !== 0) throw errorFor(this.module, this.session, 'SFTP chmod failed')
    } finally { this.module._free(attrsPtr) }
  }

  async utimesPath(path: string, modifiedAt: number): Promise<void> {
    const attrsPtr = this.module._malloc(64)
    try {
      const view = new DataView(this.module.HEAPU8.buffer)
      view.setUint32(attrsPtr, 8, true)
      view.setUint32(attrsPtr + 32, Math.floor(modifiedAt / 1000), true)
      view.setUint32(attrsPtr + 36, Math.floor(modifiedAt / 1000), true)
      const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_setstat(this.sftp, pathPtr, attrsPtr)))
      if (result !== 0) throw errorFor(this.module, this.session, 'SFTP timestamp update failed')
    } finally { this.module._free(attrsPtr) }
  }

  async readlinkPath(path: string): Promise<string> {
    const buffer = this.module._malloc(4096)
    try {
      const result = await this.withStrings([path], ([pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_readlink(this.sftp, pathPtr, buffer, 4096)))
      if (result < 0) throw errorFor(this.module, this.session, 'SFTP readlink failed')
      return readCString(this.module, buffer, result)
    } finally { this.module._free(buffer) }
  }

  async symlinkPath(target: string, path: string): Promise<void> {
    const result = await this.withStrings([target, path], ([targetPtr, pathPtr]) => this.pump(() => (this.module as any).ssh2_sftp_symlink(this.sftp, targetPtr, pathPtr)))
    if (result !== 0) throw errorFor(this.module, this.session, 'SFTP symlink failed')
  }

  supports(extension: string): boolean {
    return extension === 'posix-rename@openssh.com' && (this.module as any)?.__sealshellPatchedPosixRename === true
  }

  private async openFile(path: string, flags: number, mode: number): Promise<number> {
    const handle = await this.withStrings([path], ([pathPtr]) => this.pumpHandle(() => (this.module as any).ssh2_sftp_open(this.sftp, pathPtr, flags, mode)))
    if (!handle) throw errorFor(this.module, this.session, 'SFTP file open failed')
    return handle
  }

  private closeSftpHandle(handle: number): void {
    const close = (this.module as any).ssh2_sftp_close ?? (this.module as any).ssh2_sftp_close_handle
    close?.(handle)
  }

  private readAttributes(ptr: number): { filesize: number; permissions: number; mtime: number } {
    const view = new DataView(this.module.HEAPU8.buffer)
    return { filesize: Number(view.getBigUint64(ptr + 8, true)), permissions: view.getUint32(ptr + 24, true), mtime: view.getUint32(ptr + 32, true) }
  }

  private async withStrings<T>(values: string[], callback: (pointers: number[]) => Promise<T>): Promise<T> {
    const pointers = values.map((value) => allocateCString(this.module, value))
    try { return await callback(pointers) } finally { pointers.forEach((pointer) => this.module._free(pointer)) }
  }

  private readChannelNow(channel: LIBSSH2_CHANNEL, buffer: number, stderr: boolean): Uint8Array {
    const read = stderr
      ? this.module.ssh2_channel_read_stderr(channel, buffer, BUFFER_SIZE)
      : this.module.ssh2_channel_read(channel, buffer, BUFFER_SIZE)
    if (read <= 0) return new Uint8Array()
    return this.module.HEAPU8.slice(buffer, buffer + read)
  }

  private readHostKey(): Uint8Array | undefined {
    const native = (this.module as unknown as { ssh2_session_hostkey?: (session: number) => { key: Uint8Array } }).ssh2_session_hostkey
    if (native) {
      try {
        const result = native(this.session)
        if (result?.key?.length) return new Uint8Array(result.key)
      } catch {
        // The pinned upstream wrapper does not expose this helper in every build.
      }
    }
    const bytes = this.handshakeBytes
    const bannerEnd = bytes.indexOf(10)
    const start = bannerEnd >= 0 ? bannerEnd + 1 : 0
    for (let offset = start; offset + 5 <= bytes.length; offset += 1) {
      const packetLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
      if (packetLength < 16 || packetLength > 1024 * 1024 || offset + 4 + packetLength > bytes.length) continue
      const padding = bytes[offset + 4]
      const payloadLength = packetLength - padding - 1
      const payloadStart = offset + 5
      if (payloadLength < 5 || bytes[payloadStart] !== 31) continue
      const keyLength = new DataView(bytes.buffer, bytes.byteOffset + payloadStart + 1, 4).getUint32(0, false)
      if (keyLength > 0 && payloadStart + 5 + keyLength <= offset + 4 + packetLength) return bytes.slice(payloadStart + 5, payloadStart + 5 + keyLength)
    }
    return undefined
  }
}
