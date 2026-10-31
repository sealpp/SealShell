import { nativeCall } from '../native/bridge'
import { store, type HostProfile } from '../stores/app'

export interface HostSystem {
  id: string
  target: { address: string; port: number; username: string }
  info: { family: string; id: string; name: string }
}

const icons = import.meta.glob<string>('../assets/system-icons/*.svg', { eager: true, query: '?url', import: 'default' })
const distroIcons = new Map(Object.entries({
  ubuntu: 'ubuntu', debian: 'debian', centos: 'centos', fedora: 'fedora',
  arch: 'archlinux', manjaro: 'manjaro', opensuse: 'opensuse', 'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse', sles: 'opensuse', sled: 'opensuse',
  rocky: 'rocky-linux', almalinux: 'almalinux', alpine: 'alpine-linux', kali: 'kalilinux',
  linuxmint: 'linux-mint', nixos: 'nixos', gentoo: 'gentoo', raspbian: 'raspberrypi',
  openwrt: 'openwrt', alinux: 'alibabacloudlinux', anolis: 'anolisos', deepin: 'deepin',
  kylin: 'kylin', openeuler: 'openeuler', tencentos: 'tencentos', tlinux: 'tencentos',
  uos: 'uos', amzn: 'aws',
}))

export function hostSystem(host: HostProfile): HostSystem | undefined {
  const record = store.hostSystems[host.id]
  return record && record.target.address === host.address && record.target.port === host.port
    && record.target.username === host.username ? record : undefined
}

export function systemIcon(info: HostSystem['info']): string | undefined {
  const key = info.family === 'linux' ? distroIcons.get(info.id) ?? 'linux'
    : info.family === 'macos' ? 'apple' : info.family === 'windows' ? 'windows' : undefined
  return key ? icons[`../assets/system-icons/${key}.svg`] : undefined
}

export async function loadHostSystems(): Promise<void> {
  const records = await nativeCall<HostSystem[]>('store_list', { collection: 'hostSystems' })
  store.hostSystems = Object.fromEntries(records.map(record => [record.id, record]))
}

export async function detectHostSystem(hostId: string, sessionId: string): Promise<void> {
  try {
    const record = await nativeCall<HostSystem | null>('ssh_detect_system', { id: sessionId, hostId })
    if (record && store.hosts.some(host => host.id === hostId)) store.hostSystems[hostId] = record
  } catch (error) {
    console.warn('Remote system detection unavailable', error)
  }
}
