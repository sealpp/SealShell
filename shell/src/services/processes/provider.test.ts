import { describe, expect, it } from 'vitest'
import { parseProcessSnapshot, processTargets, signalCommand, LinuxProcessProvider } from './provider'

function sample(up = 10, ticks = 100, started = 2, boot = 'boot') {
  return ['SEAL_PROCESS_V2\t' + boot + '\t100\t' + up + '\t1700000000',
    '10\t1\t1000\tuser\tS\t1024\t' + started + '\t' + ticks + '\t2\tparent\tcommand %2509 with spaces',
    '11\t10\t1000\tuser\tR\t2048\t3\t500\t1\tchild\tchild',
    '12\t11\t1000\tuser\tS\t0\t4\t0\t1\tleaf\tleaf',
    'SEAL_PROCESS_END\t3\n'].join('\n')
}
describe('Linux process snapshots', () => {
  it('keeps argument boundaries, whitespace, empty arguments and literal percent escapes', () => {
    const raw = sample().replace('command %2509 with spaces', '/usr/bin/node%00/目录 with space/node_modules/vite/bin/vite.js%00line%0Anext%00literal %2500%00%00')
    const row = parseProcessSnapshot(raw).rows[0]
    expect(row.argv).toEqual(['/usr/bin/node', '/目录 with space/node_modules/vite/bin/vite.js', 'line\nnext', 'literal %00', ''])
    expect(row.command).toBe(row.argv.join(' '))
    expect(parseProcessSnapshot(sample().replace('command %2509 with spaces', '[parent]')).rows[0].argv).toEqual([])
  })
  it('uses interval CPU with a single-core scale and preserves process identity', () => {
    const first = parseProcessSnapshot(sample())
    expect(first.rows[0].cpu).toBeNull()
    expect(first.rows[0].command).toBe('command %09 with spaces')
    const next = parseProcessSnapshot(sample(12, 700), first)
    expect(next.rows[0].cpu).toBe(300)
    expect(next.rows[0].startedAt).toBe(1700000000020)
    expect(parseProcessSnapshot(sample(12, 700, 8), first).rows[0].cpu).toBeNull()
    expect(parseProcessSnapshot(sample(12, 700, 2, 'new-boot'), first).rows[0].cpu).toBeNull()
  })
  it('rejects partial snapshots and duplicate identities before they can form a tree action', () => {
    expect(() => parseProcessSnapshot(sample().replace('SEAL_PROCESS_END\t3', ''))).toThrow('不完整')
    expect(() => parseProcessSnapshot(sample().replace('11\t10', '10\t10'))).toThrow('无效')
  })
  it('separates selected processes from descendants and orders overlapping trees once', () => {
    const { rows } = parseProcessSnapshot(sample())
    const keys = [rows[0].key, rows[1].key]
    expect(processTargets(rows, keys, 'selected').map(row => row.pid)).toEqual([10, 11])
    expect(processTargets(rows, keys, 'tree').map(row => row.pid)).toEqual([12, 11, 10])
    expect(() => processTargets(rows, ['boot:10:99'], 'tree')).toThrow('身份变化')
    const plan = processTargets(rows, keys, 'tree')
    rows[2].name = 'changed'
    expect(plan[0].name).toBe('leaf')
  })
  it('rejects unsafe targets and signal input before constructing remote commands', () => {
    const row = parseProcessSnapshot(sample()).rows[0]
    expect(() => signalCommand('boot', [{ ...row, pid: -1 }], 'TERM')).toThrow()
    expect(() => signalCommand('boot', [{ ...row, pid: 1 }], 'TERM')).toThrow()
    expect(() => signalCommand('boot\ninjection', [row], 'TERM')).toThrow()
  })
  it('reports mixed outcomes and missing replies per target without claiming everything succeeded', async () => {
    const { rows } = parseProcessSnapshot(sample())
    const provider = new LinuxProcessProvider({
      exec: async () => ({ stdout: new TextEncoder().encode('10\tsent\n11\tchanged\n'), stderr: new Uint8Array(), exitCode: 0 }),
      close: async () => undefined,
    })
    expect((await provider.signal('boot', rows, 'TERM')).map(row => row.status)).toEqual(['sent', 'changed', 'failed'])
  })
})
