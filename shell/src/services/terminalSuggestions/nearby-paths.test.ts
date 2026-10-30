import { expect, it } from 'vitest'
import { nearbyPathProbe, parseDirectoryFacts } from './context'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const gitExec = process.platform === 'win32' ? execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim() : ''
const bash = process.env.SEAL_E2E_BASH ?? (gitExec ? resolve(gitExec, '../../../bin/bash.exe') : '/bin/bash')
it.skipIf(!existsSync(bash))('collects bounded AI directory snapshots without name filtering or recursion', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'seal-nearby-'))
  try {
    const cwd = join(fixture, 'home'), peer = join(fixture, 'data')
    mkdirSync(cwd); mkdirSync(peer); mkdirSync(join(peer, 'abdemo'))
    mkdirSync(join(peer, 'demo_linux'))
    mkdirSync(join(peer, "odd'$(touch sentinel)"))
    mkdirSync(join(peer, 'hidden', 'abdemo'), { recursive: true })
    for (let i = 0; i < 70; i++) mkdirSync(join(cwd, `abdemo-${i}`))
    const path = (value: string) => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    const read = () => {
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'uname() { printf Linux; };\n' + nearbyPathProbe(path(cwd), [path(cwd), path(peer)])],
        { cwd: fixture, encoding: 'utf8', timeout: 10000, windowsHide: true })
      expect(result.status, result.stderr).toBe(0)
      return parseDirectoryFacts(result.stdout)
    }
    const tree = read()
    expect(tree.directories).toContain(path(peer) + '/demo_linux')
    expect(tree.directories).not.toContain(path(peer) + '/hidden/abdemo')
    expect(tree.limited).toBe(true)
    expect(tree.directories).toContain(path(peer) + "/odd'$(touch sentinel)")
    expect(existsSync(join(fixture, 'sentinel'))).toBe(false)
    expect(() => nearbyPathProbe(path(cwd), ['/unrelated/deep/root'])).toThrow('范围')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
