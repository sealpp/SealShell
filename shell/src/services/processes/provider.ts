import collectScript from './collect.sh?raw'
import type { MonitorConnection } from '../monitoring/connection'
import type { ProcessOutcome, ProcessRow, ProcessScope, ProcessSignal, ProcessSnapshot } from './types'

export const PROCESS_COLLECT_COMMAND = collectScript
const decoder = new TextDecoder()
const unescape = (value: string) => value.replace(/%(25|09|0D|0A)/g, (_, code) => ({ '25': '%', '09': '\t', '0D': '\r', '0A': '\n' })[code as '25'])
const keyFor = (boot: string, pid: number, started: number) => boot + ':' + pid + ':' + started

export function parseProcessSnapshot(text: string, previous?: ProcessSnapshot): ProcessSnapshot {
  const lines = text.trimEnd().split('\n')
  const [magic, bootId, hzText, upText, bornText] = lines.shift()!.split('\t')
  const hz = Number(hzText), uptime = Number(upText), born = Number(bornText)
  if (magic !== 'SEAL_PROCESS_V1' || !/^[a-zA-Z0-9-]+$/.test(bootId) || !(hz > 0) || !(uptime >= 0) || !(born > 0)) throw new Error('进程采集响应无效')
  const footer = lines.pop()?.split('\t')
  if (footer?.[0] !== 'SEAL_PROCESS_END' || Number(footer[1]) !== lines.length) throw new Error('进程列表不完整，已拒绝使用')
  const baseline = previous?.bootId === bootId && previous.hz === hz && uptime > previous.uptime ? previous : undefined
  const old = new Map(baseline?.rows.map(row => [row.key, row]))
  const seen = new Set<number>()
  const rows = lines.map(line => {
    const fields = line.split('\t')
    const [pid, ppid, uid, rss, startTicks, cpuTicks, threads] = [0, 1, 2, 5, 6, 7, 8].map(i => Number(fields[i]))
    if (fields.length !== 11 || ![pid, ppid, uid, rss, startTicks, cpuTicks, threads].every(n => Number.isSafeInteger(n) && n >= 0) || pid < 1 || seen.has(pid)) throw new Error('进程记录无效')
    seen.add(pid)
    const key = keyFor(bootId, pid, startTicks)
    const before = old.get(key)
    const cpu = before && baseline && cpuTicks >= before.cpuTicks ? (cpuTicks - before.cpuTicks) / hz / (uptime - baseline.uptime) * 100 : null
    return { key, pid, ppid, uid, user: fields[3], state: fields[4], rss, startTicks, startedAt: (born + startTicks / hz) * 1000, cpuTicks, threads, name: unescape(fields[9]), command: unescape(fields[10]), cpu }
  })
  return { bootId, hz, uptime, rows }
}

/** Descendants first; deduplicate overlapping roots and tolerate orphaned rows. */
export function processTargets(rows: ProcessRow[], selectedKeys: string[], scope: ProcessScope): ProcessRow[] {
  const byKey = new Map(rows.map(row => [row.key, row]))
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) { const items = children.get(row.ppid) ?? []; items.push(row); children.set(row.ppid, items) }
  const visited = new Set<string>(), targets: ProcessRow[] = []
  const visit = (row: ProcessRow) => {
    if (visited.has(row.key)) return
    visited.add(row.key)
    if (scope === 'tree') for (const child of children.get(row.pid) ?? []) visit(child)
    targets.push({ ...row })
  }
  for (const key of selectedKeys) {
    const row = byKey.get(key)
    if (!row) throw new Error('所选进程已退出或身份变化，请重新选择')
    if (row.pid <= 1) throw new Error('不能结束系统初始化进程')
    visit(row)
  }
  if (!targets.length) throw new Error('请先选择进程')
  return targets
}

export function signalCommand(bootId: string, targets: ProcessRow[], signal: ProcessSignal): string {
  if (!/^[a-zA-Z0-9-]+$/.test(bootId) || !['TERM', 'KILL'].includes(signal)) throw new Error('进程操作参数无效')
  for (const row of targets) if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || !Number.isSafeInteger(row.startTicks) || row.startTicks < 0) throw new Error('进程身份无效')
  return [
    '# SEAL_PROCESS_SIGNAL_V1', 'LC_ALL=C; export LC_ALL',
    'boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1',
    'while read -r pid expected; do',
    '  if [ "$boot" != "' + bootId + '" ]; then printf "%s\\tchanged\\n" "$pid"; continue; fi',
    '  if [ ! -d "/proc/$pid" ]; then printf "%s\\tgone\\n" "$pid"; continue; fi',
    '  actual=$(awk \'{s=s (s ? "\\n" : "") $0} END{sub(/^.*\\) /,"",s); split(s,a," "); print a[20]}\' "/proc/$pid/stat" 2>/dev/null)',
    '  if [ -z "$actual" ]; then printf "%s\\tdenied\\n" "$pid"; continue; fi',
    '  if [ "$actual" != "$expected" ]; then printf "%s\\tchanged\\n" "$pid"; continue; fi',
    '  if err=$(kill -' + signal + ' "$pid" 2>&1); then status=sent',
    '  elif [ ! -d "/proc/$pid" ]; then status=gone',
    '  else case "$err" in *permitted*|*Permission*) status=denied ;; *) status=failed ;; esac; fi',
    '  printf "%s\\t%s\\n" "$pid" "$status"',
    "done <<'SEAL_PROCESS_TARGETS'",
    ...targets.map(row => row.pid + ' ' + row.startTicks),
    'SEAL_PROCESS_TARGETS',
  ].join('\n')
}

export class LinuxProcessProvider {
  private previous?: ProcessSnapshot
  constructor(private readonly connection: MonitorConnection) {}
  resetBaseline(): void { this.previous = undefined }
  async sample(): Promise<ProcessSnapshot> {
    const result = await this.connection.exec(PROCESS_COLLECT_COMMAND, { timeoutMs: 15000, maxOutputBytes: 8 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr).trim() || 'Linux 进程采集失败（需要 /proc、GNU ps、awk 和 getconf）')
    const snapshot = parseProcessSnapshot(decoder.decode(result.stdout), this.previous)
    this.previous = snapshot
    return snapshot
  }
  async signal(bootId: string, targets: ProcessRow[], signal: ProcessSignal): Promise<ProcessOutcome[]> {
    const result = await this.connection.exec(signalCommand(bootId, targets, signal), { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr).trim() || '结束进程命令未完成')
    const statuses = new Map(decoder.decode(result.stdout).trim().split('\n').map(line => { const [pid, status] = line.split('\t'); return [pid, status] as const }))
    return targets.map(row => {
      const status = statuses.get(String(row.pid))
      return { key: row.key, pid: row.pid, name: row.name, status: ['sent', 'gone', 'changed', 'denied'].includes(status ?? '') ? status as ProcessOutcome['status'] : 'failed' }
    })
  }
}
