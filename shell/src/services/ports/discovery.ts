import { normalizeTarget } from '../transport/types'

export const DISCOVER_PORTS = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'

function canonicalHost(host: string): string {
  return ['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost'].includes(host) ? 'localhost' : host.toLowerCase()
}
export function endpointId(host: string, port: number): string { return `${canonicalHost(host)}:${port}` }

export function parsePortTarget(value: string): { host: string; port: number } {
  const text = value.trim()
  const match = /^(?:\[([^\]]+)\]:|([^:\s]+):)?(\d+)$/.exec(text)
  if (!match) throw new Error('请输入端口或地址:端口，例如 3000、10.0.0.8:5432。')
  const target = normalizeTarget({ host: match[1] || match[2] || 'localhost', port: Number(match[3]) })
  return { host: canonicalHost(target.host), port: target.port }
}

/** Linux procfs uses native little-endian words for both IPv4 and IPv6. */
function procAddress(value: string): string {
  const bytes = value.match(/.{8}/g)!.flatMap(word => word.match(/../g)!.reverse())
  if (bytes.length === 4) return bytes.map(byte => parseInt(byte, 16)).join('.')
  const words = bytes.join('').match(/.{4}/g)!.map(word => parseInt(word, 16).toString(16))
  return new URL(`http://[${words.join(':')}]`).hostname.slice(1, -1)
}

export function parseListeningPorts(output: string): Array<{ host: string; port: number }> {
  const ports = new Map<string, { host: string; port: number }>()
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A') continue
    const match = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(fields[1])
    if (!match) continue
    const host = canonicalHost(procAddress(match[1]))
    const port = parseInt(match[2], 16)
    if (port) ports.set(endpointId(host, port), { host, port })
  }
  return [...ports.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
}
