import createCoreModule from './libssh2-core.js'

// The checked-in upstream WASM exposes the base rename entry point. These
// pointer-compatible helpers keep the application API stable while CI builds
// the native overwrite extension from patches/rename-ex.patch.
export default async function createSealShellLibssh2(options = {}) {
  const module = await createCoreModule(options)
  for (const name of [
    'ssh2_init', 'ssh2_exit', 'ssh2_version', 'ssh2_session_init', 'ssh2_session_free',
    'ssh2_session_callback_set_custom', 'ssh2_session_handshake_custom', 'ssh2_session_disconnect',
    'ssh2_session_set_blocking', 'ssh2_session_last_errno', 'ssh2_session_last_error',
    'ssh2_userauth_password', 'ssh2_channel_open_session', 'ssh2_channel_direct_tcpip', 'ssh2_channel_free', 'ssh2_channel_close',
    'ssh2_channel_wait_closed', 'ssh2_channel_eof', 'ssh2_channel_send_eof', 'ssh2_channel_request_pty',
    'ssh2_channel_request_pty_size', 'ssh2_channel_shell', 'ssh2_channel_exec', 'ssh2_channel_subsystem',
    'ssh2_channel_read', 'ssh2_channel_read_stderr', 'ssh2_channel_write', 'ssh2_channel_write_stderr',
    'ssh2_channel_flush', 'ssh2_channel_get_exit_status', 'ssh2_sftp_init', 'ssh2_sftp_shutdown',
    'ssh2_sftp_open', 'ssh2_sftp_opendir', 'ssh2_sftp_close_handle', 'ssh2_sftp_read', 'ssh2_sftp_write',
    'ssh2_sftp_readdir', 'ssh2_sftp_seek64', 'ssh2_sftp_tell64', 'ssh2_sftp_stat', 'ssh2_sftp_setstat',
    'ssh2_sftp_mkdir', 'ssh2_sftp_rmdir', 'ssh2_sftp_unlink', 'ssh2_sftp_rename', 'ssh2_sftp_symlink',
    'ssh2_sftp_readlink', 'ssh2_sftp_realpath',
  ]) {
    if (!module[name] && module[`_${name}`]) module[name] = module[`_${name}`]
  }
  if (!module.ssh2_sftp_rename_ex) {
    module.ssh2_sftp_rename_ex = (sftp, source, _sourceLength, dest, _destLength, _flags) => module.ssh2_sftp_rename(sftp, source, dest)
  }
  if (!module.ssh2_sftp_posix_rename_ex) {
    module.ssh2_sftp_posix_rename_ex = (sftp, source, _sourceLength, dest, _destLength) => module.ssh2_sftp_rename(sftp, source, dest)
  }
  module.__sealshellPatchedPosixRename = false
  return module
}
