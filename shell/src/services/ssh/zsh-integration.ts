import integration from './zsh-integration.zsh?raw'

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// Zsh has no --init-file. Redirect its user startup files for this session,
// preserving the normal global/user startup order and any user ZDOTDIR changes.
const restoreUserDirectory = `if (( __SEAL_ZDOTDIR_SET )); then
  ZDOTDIR=$__SEAL_ZDOTDIR
else
  unset ZDOTDIR
fi`

const startupFiles = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
const writeStartupFiles = startupFiles.map((name, index) => {
  const script = `${restoreUserDirectory}
if [[ -r \${ZDOTDIR-$HOME}/${name} ]]; then . "\${ZDOTDIR-$HOME}/${name}"; fi
${index === startupFiles.length - 1 ? `unset __SEAL_ZDOTDIR_SET __SEAL_ZDOTDIR __SEAL_INIT_DIR
${integration}` : `__SEAL_ZDOTDIR_SET=\${+ZDOTDIR}
__SEAL_ZDOTDIR=\${ZDOTDIR-}
ZDOTDIR=$__SEAL_INIT_DIR`}`
  return `builtin printf '%s' ${quote(script)} > "$__seal_dir/${name}" || return`
}).join('\n')

const cleanup = `command rm -f -- ${startupFiles.map(name => `"$__seal_dir/${name}"`).join(' ')}
command rmdir -- "$__seal_dir"`

// An EXIT trap also runs on SSH hangup; zsh's try/always skips cleanup on SIGHUP.
// The parent owns only these four files. No setup enters terminal input/history.
// Keep the directory in parent scope: EXIT may run after function locals expire.
export const ZSH_STARTUP_COMMAND = `() {
  builtin typeset -g __seal_dir
  __seal_dir=$(command mktemp -d "\${TMPDIR:-/tmp}/sealshell-zsh.XXXXXXXX") || return
  trap ${quote(cleanup)} EXIT
  ${writeStartupFiles}
  __SEAL_ZDOTDIR_SET=\${+ZDOTDIR} __SEAL_ZDOTDIR=\${ZDOTDIR-} __SEAL_INIT_DIR=$__seal_dir ZDOTDIR=$__seal_dir command zsh -il
}`
