declare module '@verdigris/libssh2.js' {
  // Opaque pointer types for libssh2 structures
  export type LIBSSH2_SESSION = number;
  export type LIBSSH2_CHANNEL = number;
  export type LIBSSH2_SFTP = number;
  export type LIBSSH2_SFTP_HANDLE = number;
  export type LIBSSH2_LISTENER = number;
  export type LIBSSH2_KNOWNHOSTS = number;

  // libssh2 error codes
  export enum LIBSSH2_ERROR {
    NONE = 0,
    SOCKET_NONE = -1,
    BANNER_RECV = -2,
    BANNER_SEND = -3,
    INVALID_MAC = -4,
    KEX_FAILURE = -5,
    ALLOC = -6,
    SOCKET_SEND = -7,
    KEY_EXCHANGE_FAILURE = -8,
    TIMEOUT = -9,
    HOSTKEY_INIT = -10,
    HOSTKEY_SIGN = -11,
    DECRYPT = -12,
    SOCKET_DISCONNECT = -13,
    PROTO = -14,
    PASSWORD_EXPIRED = -15,
    FILE = -16,
    METHOD_NONE = -17,
    AUTHENTICATION_FAILED = -18,
    PUBLICKEY_UNRECOGNIZED = -19,
    PUBLICKEY_UNVERIFIED = -20,
    CHANNEL_OUTOFORDER = -21,
    CHANNEL_FAILURE = -22,
    CHANNEL_REQUEST_DENIED = -23,
    CHANNEL_UNKNOWN = -24,
    CHANNEL_WINDOW_EXCEEDED = -25,
    CHANNEL_PACKET_EXCEEDED = -26,
    CHANNEL_CLOSED = -27,
    CHANNEL_EOF_SENT = -28,
    SCP_PROTOCOL = -29,
    ZLIB = -30,
    SOCKET_TIMEOUT = -31,
    SFTP_PROTOCOL = -32,
    REQUEST_DENIED = -33,
    METHOD_NOT_SUPPORTED = -34,
    INVAL = -35,
    INVALID_POLL_TYPE = -36,
    EAGAIN = -37,
    BUFFER_TOO_SMALL = -38,
    BAD_USE = -39,
    COMPRESS = -40,
    OUT_OF_BOUNDARY = -41,
    AGENT_PROTOCOL = -42,
    SOCKET_RECV = -43,
    ENCRYPT = -44,
    BAD_SOCKET = -45,
    KNOWN_HOSTS = -46,
    CHANNEL_WINDOW_FULL = -47,
    KEYFILE_AUTH_FAILED = -48,
  }

  // Callback function types (simplified - one session per WebSocket)
  export type SendCallback = (bufPtr: number, length: number) => number;
  export type RecvCallback = (bufPtr: number, length: number) => number;

  // Callback type constants for ssh2_session_callback_set_custom
  export const LIBSSH2_CALLBACK_SEND = 5;
  export const LIBSSH2_CALLBACK_RECV = 6;

  // Module options for initialization
  export interface ModuleOptions {
    // Memory settings
    INITIAL_MEMORY?: number;
    ALLOW_MEMORY_GROWTH?: boolean;
    MAXIMUM_MEMORY?: number;

    // Callbacks
    onRuntimeInitialized?: () => void;
    onAbort?: (what: any) => void;
    print?: (text: string) => void;
    printErr?: (text: string) => void;

    // Custom transport functions
    customSend?: SendCallback;
    customRecv?: RecvCallback;

    // File system
    preRun?: Array<(module: LibSSH2Module) => void>;
    postRun?: Array<(module: LibSSH2Module) => void>;

    // Environment
    arguments?: string[];
    environment?: Record<string, string>;

    // Emscripten specific
    locateFile?: (path: string, prefix: string) => string;
    instantiateWasm?: (
      info: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
    ) => WebAssembly.Exports;
  }

  // Authentication methods
  export interface PasswordCredentials {
    username: string;
    password: string;
  }

  export interface KeyCredentials {
    username: string;
    publicKey?: string;
    privateKey: string;
    passphrase?: string;
  }

  export type Credentials = PasswordCredentials | KeyCredentials;

  // Channel types
  export enum ChannelType {
    SESSION = 'session',
    DIRECT_TCPIP = 'direct-tcpip',
    FORWARDED_TCPIP = 'forwarded-tcpip',
  }

  // PTY settings
  export interface PtyOptions {
    term?: string;
    width?: number;
    height?: number;
    width_px?: number;
    height_px?: number;
    modes?: string;
  }

  // SFTP file attributes
  export interface SftpAttributes {
    flags: number;
    filesize: number;
    uid: number;
    gid: number;
    permissions: number;
    atime: number;
    mtime: number;
  }

  // Main module interface
  export interface LibSSH2Module {
    // Memory management
    HEAPU8: Uint8Array;
    HEAP8: Int8Array;
    HEAPU16: Uint16Array;
    HEAP16: Int16Array;
    HEAPU32: Uint32Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
    HEAPF64: Float64Array;

    // Memory functions
    _malloc(size: number): number;
    _free(ptr: number): void;
    _realloc(ptr: number, size: number): number;

    // String utilities
    UTF8ToString(ptr: number, maxBytesToRead?: number): string;
    stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
    allocateUTF8(str: string): number;
    allocateUTF8OnStack(str: string): number;

    // Value accessors
    getValue(ptr: number, type: string): number;
    setValue(ptr: number, value: number, type: string): void;

    // Function calling
    ccall(ident: string, returnType: string | null, argTypes: string[], args: any[]): any;
    cwrap(ident: string, returnType: string | null, argTypes: string[]): (...args: any[]) => any;

    // Custom transport functions (set by user)
    customSend?: SendCallback;
    customRecv?: RecvCallback;

    // File system
    FS: any;
  }

  // libssh2 function bindings
  export interface LibSSH2Functions {
    // Initialization and cleanup
    ssh2_init(): number;
    ssh2_exit(): void;
    ssh2_version(): string;

    // Session management
    ssh2_session_init(): LIBSSH2_SESSION;
    ssh2_session_handshake(session: LIBSSH2_SESSION, socket: number): number;
    ssh2_session_handshake_custom(session: LIBSSH2_SESSION): number;
    ssh2_session_set_blocking(session: LIBSSH2_SESSION, blocking: number): void;
    ssh2_session_callback_set_custom(session: LIBSSH2_SESSION, cbtype: number): void;
    ssh2_session_last_errno(session: LIBSSH2_SESSION): number;
    ssh2_session_last_error(session: LIBSSH2_SESSION): string;
    ssh2_session_disconnect(session: LIBSSH2_SESSION, reason: string): number;
    ssh2_session_free(session: LIBSSH2_SESSION): void;
    ssh2_session_banner_get(session: LIBSSH2_SESSION): string;
    ssh2_session_hostkey(session: LIBSSH2_SESSION): { key: Uint8Array; type: number };

    // Authentication
    ssh2_userauth_list(session: LIBSSH2_SESSION, username: string): string;
    ssh2_userauth_authenticated(session: LIBSSH2_SESSION): number;
    ssh2_userauth_password(session: LIBSSH2_SESSION, username: string, password: string): number;
    ssh2_userauth_publickey_fromfile(
      session: LIBSSH2_SESSION,
      username: string,
      publickey: string | null,
      privatekey: string,
      passphrase: string
    ): number;
    ssh2_userauth_publickey_frommemory(
      session: LIBSSH2_SESSION,
      username: string,
      publickeydata: string,
      privatekeydata: string,
      passphrase: string
    ): number;
    ssh2_userauth_keyboard_interactive(
      session: LIBSSH2_SESSION,
      username: string,
      callback: (name: string, instruction: string, prompts: Array<{ text: string; echo: boolean }>) => string[]
    ): number;

    // Channel management
    ssh2_channel_open_session(session: LIBSSH2_SESSION): LIBSSH2_CHANNEL;
    ssh2_channel_direct_tcpip(
      session: LIBSSH2_SESSION,
      host: number,
      port: number
    ): LIBSSH2_CHANNEL;
    ssh2_channel_request_pty(channel: LIBSSH2_CHANNEL, term: string): number;
    ssh2_channel_request_pty_size(channel: LIBSSH2_CHANNEL, width: number, height: number): number;
    ssh2_channel_shell(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_exec(channel: LIBSSH2_CHANNEL, command: string): number;
    ssh2_channel_subsystem(channel: LIBSSH2_CHANNEL, subsystem: string): number;
    ssh2_channel_process_startup(channel: LIBSSH2_CHANNEL, request: string, message: string): number;

    // Channel I/O
    ssh2_channel_read(channel: LIBSSH2_CHANNEL, buf: number, buflen: number): number;
    ssh2_channel_read_stderr(channel: LIBSSH2_CHANNEL, buf: number, buflen: number): number;
    ssh2_channel_write(channel: LIBSSH2_CHANNEL, buf: number, buflen: number): number;
    ssh2_channel_write_stderr(channel: LIBSSH2_CHANNEL, buf: number, buflen: number): number;
    ssh2_channel_flush(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_flush_stderr(channel: LIBSSH2_CHANNEL): number;

    // Channel status
    ssh2_channel_eof(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_send_eof(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_wait_eof(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_wait_closed(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_get_exit_status(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_get_exit_signal(channel: LIBSSH2_CHANNEL): string;

    // Channel cleanup
    ssh2_channel_close(channel: LIBSSH2_CHANNEL): number;
    ssh2_channel_free(channel: LIBSSH2_CHANNEL): void;

    // Port forwarding
    ssh2_channel_forward_listen(session: LIBSSH2_SESSION, host: string, port: number): LIBSSH2_LISTENER;
    ssh2_channel_forward_accept(listener: LIBSSH2_LISTENER): LIBSSH2_CHANNEL;
    ssh2_channel_forward_cancel(listener: LIBSSH2_LISTENER): number;

    // SFTP
    ssh2_sftp_init(session: LIBSSH2_SESSION): LIBSSH2_SFTP;
    ssh2_sftp_shutdown(sftp: LIBSSH2_SFTP): number;
    ssh2_sftp_open(sftp: LIBSSH2_SFTP, filename: string, flags: number, mode: number): LIBSSH2_SFTP_HANDLE;
    ssh2_sftp_close(handle: LIBSSH2_SFTP_HANDLE): number;
    ssh2_sftp_read(handle: LIBSSH2_SFTP_HANDLE, buffer: number, buffer_maxlen: number): number;
    ssh2_sftp_write(handle: LIBSSH2_SFTP_HANDLE, buffer: number, count: number): number;
    ssh2_sftp_seek64(handle: LIBSSH2_SFTP_HANDLE, offset: number): void;
    ssh2_sftp_tell64(handle: LIBSSH2_SFTP_HANDLE): number;
    ssh2_sftp_stat(sftp: LIBSSH2_SFTP, path: string): SftpAttributes;
    ssh2_sftp_lstat(sftp: LIBSSH2_SFTP, path: string): SftpAttributes;
    ssh2_sftp_fstat(handle: LIBSSH2_SFTP_HANDLE): SftpAttributes;
    ssh2_sftp_setstat(sftp: LIBSSH2_SFTP, path: string, attrs: SftpAttributes): number;
    ssh2_sftp_mkdir(sftp: LIBSSH2_SFTP, path: string, mode: number): number;
    ssh2_sftp_rmdir(sftp: LIBSSH2_SFTP, path: string): number;
    ssh2_sftp_unlink(sftp: LIBSSH2_SFTP, filename: string): number;
    ssh2_sftp_rename(sftp: LIBSSH2_SFTP, source: string, dest: string): number;
    /** Patched wrapper: flags are LIBSSH2_SFTP_RENAME_* and lengths are byte lengths. */
    ssh2_sftp_rename_ex(sftp: LIBSSH2_SFTP, source: string, sourceLength: number, dest: string, destLength: number, flags: number): number;
    /** Patched wrapper for posix-rename@openssh.com overwrite semantics. */
    ssh2_sftp_posix_rename_ex(sftp: LIBSSH2_SFTP, source: string, sourceLength: number, dest: string, destLength: number): number;

    // Known hosts
    ssh2_knownhost_init(session: LIBSSH2_SESSION): LIBSSH2_KNOWNHOSTS;
    ssh2_knownhost_free(hosts: LIBSSH2_KNOWNHOSTS): void;
    ssh2_knownhost_readfile(hosts: LIBSSH2_KNOWNHOSTS, filename: string): number;
    ssh2_knownhost_writefile(hosts: LIBSSH2_KNOWNHOSTS, filename: string, type: number): number;
    ssh2_knownhost_check(
      hosts: LIBSSH2_KNOWNHOSTS,
      host: string,
      key: Uint8Array,
      typemask: number
    ): { result: number; knownhost: any };

    // Debugging and tracing
    ssh2_trace(session: LIBSSH2_SESSION, bitmask: number): void;
    ssh2_trace_sethandler(session: LIBSSH2_SESSION, handler: (message: string) => void): void;
  }

  // Combined module type
  export type SSH2WASMModule = LibSSH2Module & LibSSH2Functions;

  // Factory function type
  export interface LibSSH2ModuleFactory {
    (options?: ModuleOptions): Promise<SSH2WASMModule>;
  }

  // Default export is the factory function
  const createLibSSH2Module: LibSSH2ModuleFactory;
  export default createLibSSH2Module;
}
