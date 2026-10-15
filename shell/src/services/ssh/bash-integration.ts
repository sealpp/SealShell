import integration from './bash-integration.sh?raw'

export const BASH_VERSION_PROBE = `printf 'SEAL_BASH_VERSION=%s\\n' "$BASH_VERSION"`

// Match an interactive SSH login's profiles. Bash ignores --init-file with -l,
// so load the login profiles here, as VS Code's Bash integration does.
const initScript = `if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile; fi
${integration}`

// Process substitution supplies the init script without writing remote files or
// typing setup commands into the interactive shell/history.
export const BASH_STARTUP_COMMAND = `exec "$BASH" --init-file <(printf '%s' '${initScript.replace(/'/g, "'\\''")}') -i`
