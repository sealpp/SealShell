import { BASH_STARTUP_COMMAND } from './bash-integration'
import { ZSH_STARTUP_COMMAND } from './zsh-integration'

export const SHELL_VERSION_PROBE = `printf 'SEAL_BASH_VERSION=%s\\nSEAL_ZSH_VERSION=%s\\n' "\${BASH_VERSION-}" "\${ZSH_VERSION-}"`

export function shellStartupCommand(probe: string): string | undefined {
  if (/^SEAL_ZSH_VERSION=\d+\./m.test(probe)) return ZSH_STARTUP_COMMAND
  if (/^SEAL_BASH_VERSION=\d+\./m.test(probe)) return BASH_STARTUP_COMMAND
  return undefined
}
