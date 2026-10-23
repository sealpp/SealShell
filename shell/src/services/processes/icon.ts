export type ProcessIconKind = 'process' | 'shell' | 'node' | 'python' | 'java' | 'php' | 'deno' | 'docker' | 'mysql' | 'nginx' | 'redis' | 'postgresql' | 'system'

const programs = new Map<string, ProcessIconKind>([
  ...['sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'ksh', 'csh', 'tcsh', 'ssh', 'sshd', 'sshd-session'].map(name => [name, 'shell'] as const),
  ['node', 'node'], ['nodejs', 'node'],
  ['java', 'java'], ['deno', 'deno'],
  ['docker', 'docker'], ['dockerd', 'docker'],
  ['mysql', 'mysql'], ['mysqld', 'mysql'],
  ['nginx', 'nginx'],
  ['redis-server', 'redis'], ['redis-sentinel', 'redis'], ['redis-cli', 'redis'],
  ['postgres', 'postgresql'], ['postmaster', 'postgresql'],
  ['systemd', 'system'], ['init', 'system'],
])

/** Match the collected process name only; arguments and parentage do not identify an application. */
export function processIconKind(name: string): ProcessIconKind {
  const known = programs.get(name)
  if (known) return known
  if (/^python(?:[23](?:\.\d+)*t?)?$/.test(name)) return 'python'
  if (/^php(?:-fpm)?(?:\d+(?:\.\d+)*)?$/.test(name)) return 'php'
  return 'process'
}
