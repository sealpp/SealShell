import type { ProcessRow } from './types'

export type ProcessIconKind = 'process' | 'shell' | 'node' | 'python' | 'java' | 'php' | 'deno' | 'docker' | 'mysql' | 'nginx' | 'redis' | 'postgresql' | 'system' | 'clickhouse' | 'codex' | 'pyrefly' | 'devin' | 'npm' | 'pnpm' | 'yarn' | 'vite' | 'typescript' | 'nextjs'

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
  ['clickhouse', 'clickhouse'], ['clickhouse-server', 'clickhouse'], ['clickhouse-client', 'clickhouse'],
  ['codex', 'codex'], ['pyrefly', 'pyrefly'], ['devin', 'devin'],
  ['npm', 'npm'], ['npx', 'npm'], ['pnpm', 'pnpm'], ['pnpx', 'pnpm'], ['yarn', 'yarn'],
])

const runtimes = new Set<ProcessIconKind>(['shell', 'node', 'python', 'java', 'php', 'deno'])
const nodeEntries = new Map<string, ProcessIconKind>([
  ['npm/bin/npm-cli.js', 'npm'], ['npm/bin/npx-cli.js', 'npm'],
  ['pnpm/bin/pnpm.cjs', 'pnpm'], ['pnpm/bin/pnpx.cjs', 'pnpm'],
  ['yarn/bin/yarn.js', 'yarn'],
  ['@openai/codex/bin/codex.js', 'codex'],
  ['vite/bin/vite.js', 'vite'],
  ['typescript/bin/tsc', 'typescript'], ['typescript/bin/tsserver', 'typescript'], ['typescript/lib/tsserver.js', 'typescript'],
  ['next/dist/bin/next', 'nextjs'],
])
const binEntries = new Map<string, ProcessIconKind>([
  ['npm', 'npm'], ['npx', 'npm'], ['pnpm', 'pnpm'], ['pnpx', 'pnpm'], ['yarn', 'yarn'],
  ['codex', 'codex'], ['vite', 'vite'], ['tsc', 'typescript'], ['tsserver', 'typescript'], ['next', 'nextjs'],
])
const nodeFlags = new Set(['--enable-source-maps', '--no-warnings', '--trace-warnings', '--experimental-strip-types'])
const nodeValueFlags = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--inspect-port'])
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function programKind(name: string): ProcessIconKind | undefined {
  const known = programs.get(name)
  if (known) return known
  if (/^python(?:[23](?:\.\d+)*t?)?$/.test(name)) return 'python'
  if (/^php(?:-fpm)?(?:\d+(?:\.\d+)*)?$/.test(name)) return 'php'
  // npm replaces its process title (and argv) with e.g. "npm run dev".
  const launcher = /^(npm|pnpm|yarn) /.exec(name)?.[1]
  return launcher ? programs.get(launcher) : undefined
}

/** Only consume known Node flags; eval, stdin and unknown options keep the runtime icon. */
function nodeEntry(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return argv[i + 1]
    if (!arg.startsWith('-')) return arg
    if (nodeFlags.has(arg) || /^--(?:inspect|inspect-brk)(?:=.+)?$/.test(arg) || /^--(?:max-old-space-size|stack-size)=\d+$/.test(arg)) continue
    if (nodeValueFlags.has(arg)) { if (!argv[++i]) return; continue }
    if (/^--(?:require|import|loader|experimental-loader|inspect-port)=.+$/.test(arg)) continue
    return
  }
}

function entryKind(entry: string): ProcessIconKind | undefined {
  const marker = 'node_modules/'
  const start = entry.lastIndexOf('/' + marker)
  const packagePath = start >= 0 ? entry.slice(start + marker.length + 1)
    : entry.startsWith(marker) ? entry.slice(marker.length)
    : entry.startsWith('/usr/share/nodejs/') ? entry.slice('/usr/share/nodejs/'.length) : undefined
  if (packagePath) return packagePath.startsWith('.bin/') ? binEntries.get(packagePath.slice(5)) : nodeEntries.get(packagePath)
  if (/^\/usr\/(?:local\/)?bin\/[^/]+$/.test(entry)) return binEntries.get(basename(entry))
}

/** Icons identify this process, never its parent, arbitrary arguments or package manager. */
export function processIconKind({ name, argv }: Pick<ProcessRow, 'name' | 'argv'>): ProcessIconKind {
  const executable = basename(argv[0] ?? '')
  const candidates = [programKind(executable), programKind(name)]
  for (const kind of candidates) if (kind && !runtimes.has(kind)) return kind
  if (executable === 'node' || executable === 'nodejs') {
    const entry = nodeEntry(argv)
    const kind = entry && entryKind(entry)
    if (kind) return kind
  }
  return candidates.find(kind => kind !== undefined) ?? 'process'
}
