import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { ZSH_STARTUP_COMMAND } from './zsh-integration'

const zsh = process.env.SEAL_E2E_ZSH ?? '/bin/zsh'
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seal-zsh-'))
  const config = join(root, 'config')
  const redirected = join(root, 'redirected')
  const temporary = join(root, 'temporary')
  for (const dir of [config, redirected, temporary]) mkdirSync(dir)
  const env = { ...process.env, PATH: `${dirname(zsh)}${delimiter}${process.env.PATH}`, ZDOTDIR: posix(config), TMPDIR: posix(temporary), TERM: 'dumb' }
  return { root, config, redirected, temporary, env }
}

it.skipIf(!existsSync(zsh))('loads zsh login files in order, follows ZDOTDIR and preserves hooks, status and history', () => {
  const test = fixture()
  try {
    const directory = join(test.root, "中文 a'b;$(touch sentinel) %20")
    mkdirSync(directory)
    writeFileSync(join(test.config, '.zshenv'), `print startup:env; ZDOTDIR=${quote(posix(test.redirected))}\n`)
    writeFileSync(join(test.redirected, '.zprofile'), 'print startup:profile\n')
    const rc = `print startup:rc
HISTFILE=${quote(posix(join(test.root, 'history')))}
HISTSIZE=100
SAVEHIST=100
PROMPT='original prompt> '
precmd() { print original-status:$? }
original_precmd() { print original-hook }
original_chpwd() { print original-directory:$PWD }
precmd_functions=(original_precmd)
chpwd_functions=(original_chpwd)
`
    writeFileSync(join(test.redirected, '.zshrc'), rc)
    writeFileSync(join(test.redirected, '.zlogin'), 'print startup:login\n')
    const output = execFileSync(zsh, ['-f', '-c', ZSH_STARTUP_COMMAND], {
      env: test.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      input: `false\ncd -- ${quote(posix(directory))}\nprintf 'config:%s\\nprompt:%s\\n' "$ZDOTDIR" "$PROMPT"\nexit\n`,
    })
    expect(output).toMatch(/startup:env\nstartup:profile\nstartup:rc\nstartup:login\n/)
    expect(output).toContain('original-status:1')
    expect(output).toContain('original-hook')
    expect(output).toContain(`original-directory:${posix(directory)}`)
    expect(output).toContain(`\x1b]1337;CurrentDir=${posix(directory)}\x07`)
    expect(output).toContain(`config:${posix(test.redirected)}`)
    expect(output).toContain('prompt:original prompt> ')
    const history = readFileSync(join(test.root, 'history'), 'utf8')
    expect(history).toContain('false')
    expect(history).not.toContain('__seal')
    expect(readFileSync(join(test.redirected, '.zshrc'), 'utf8')).toBe(rc)
    expect(readdirSync(test.temporary)).toEqual([])
    expect(existsSync(join(test.root, 'sentinel'))).toBe(false)
  } finally {
    rmSync(test.root, { recursive: true, force: true })
  }
})

it.skipIf(!existsSync(zsh))('cleans up the bootstrap when a user startup file exits early', () => {
  const test = fixture()
  try {
    writeFileSync(join(test.config, '.zshrc'), 'exit 23\n')
    expect(() => execFileSync(zsh, ['-f', '-c', ZSH_STARTUP_COMMAND], {
      env: test.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow()
    expect(readdirSync(test.temporary)).toEqual([])
  } finally {
    rmSync(test.root, { recursive: true, force: true })
  }
})
