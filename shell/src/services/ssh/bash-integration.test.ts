import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import integration from './bash-integration.sh?raw'

const gitExecPath = process.platform === 'win32'
  ? execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim()
  : ''
const bash = process.env.SEAL_E2E_BASH ?? (gitExecPath ? resolve(gitExecPath, '../../../bin/bash.exe') : '/bin/bash')

it.skipIf(!existsSync(bash))('preserves Bash scalar/array prompt hooks, prompt text and command exit status', () => {
  for (const setup of [
    `PROMPT_COMMAND='printf "original:%s\\n" "$?"'`,
    `PROMPT_COMMAND=('printf "original:%s\\n" "$?"' 'printf "array-kept\\n"')`,
  ]) {
    const script = `${setup}
PS1='original prompt'
${integration}
false
eval "\${PROMPT_COMMAND[0]}"
for hook in "\${PROMPT_COMMAND[@]:1}"; do eval "$hook"; done
printf 'prompt:%s\\n' "$PS1"
`
    const output = execFileSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', windowsHide: true })
    expect(output).toMatch(/\x1b\]1337;CurrentDir=\/[^\x07]*\x07original:1\n/)
    expect(output).toContain('prompt:original prompt\n')
    if (setup.includes('array-kept')) expect(output).toContain('array-kept\n')
  }
})
