import { getSshSession } from '../ssh'
import { connectSsh } from '../ssh/connection'
import { matchesQuery, type CommandSuggestion } from './model'

export interface DirectoryFacts {
  cwd: string
  directories: string[]
  files: string[]
  scripts: string[]
  tools: string[]
}

export const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`

/** Fixed read-only operations. User/model text can only occupy a quoted path. */
export function directoryProbe(cwd: string): string {
  if (!cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)) throw new Error('当前目录不可用')
  return `# sealshell-recommendation-context
test "$(uname -s)" = Linux || exit 2
cd -- ${shellQuote(cwd)} || exit 1
printf 'cwd\\0%s\\0' "$PWD"
n=0
for p in "$PWD"/* "$PWD"/.[!.]*; do
  [ -e "$p" ] || continue
  n=$((n+1)); [ "$n" -le 80 ] || break
  if [ -d "$p" ]; then printf 'dir\\0%s\\0' "$p"; else printf 'file\\0%s\\0' "$p"; fi
done
parent=$(dirname -- "$PWD")
n=0
for p in "$parent"/*; do
  [ -d "$p" ] || continue
  n=$((n+1)); [ "$n" -le 40 ] || break
  printf 'dir\\0%s\\0' "$p"
done
for t in python python3 conda uv npm pnpm yarn cmake make ninja docker ss journalctl; do
  command -v "$t" >/dev/null 2>&1 && printf 'tool\\0%s\\0' "$t"
done
if [ -f package.json ] && [ ! -L package.json ]; then
  printf 'package\\0'; head -c 8192 package.json; printf '\\0'
fi
printf 'done\\0yes\\0'`
}

export function parseDirectoryFacts(output: string): DirectoryFacts {
  const fields = output.split('\0')
  const facts: DirectoryFacts = { cwd: '', directories: [], files: [], scripts: [], tools: [] }
  let done = false
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const kind = fields[i], value = fields[i + 1]!
    if (kind === 'package') {
      try {
        const config = JSON.parse(value)
        if (config.scripts && typeof config.scripts === 'object') facts.scripts = Object.keys(config.scripts).filter(name => /^[\w:.-]{1,80}$/.test(name)).slice(0, 40)
      } catch { /* A truncated or invalid manifest supplies no script facts. */ }
    } else if (!/[\x00-\x1f\x7f]/.test(value) && value.length <= 2048) {
      if (kind === 'cwd') facts.cwd = value
      if (kind === 'dir' && facts.directories.length < 120) facts.directories.push(value)
      if (kind === 'file' && facts.files.length < 80) facts.files.push(value)
      if (kind === 'tool') facts.tools.push(value)
      if (kind === 'done' && value === 'yes') done = true
    }
  }
  if (!done || !facts.cwd.startsWith('/')) throw new Error('目录探测未完成')
  facts.directories = [...new Set(facts.directories)]
  return facts
}

export async function probeDirectory(sessionId: string, cwd: string, signal: AbortSignal): Promise<DirectoryFacts> {
  const info = getSshSession(sessionId)
  if (!info) throw new Error('SSH 会话不可用')
  const connection = await connectSsh(info, signal)
  try {
    const result = await connection.worker.exec(directoryProbe(cwd), { timeoutMs: 3000, maxOutputBytes: 48 * 1024 })
    signal.throwIfAborted()
    if (result.exitCode !== 0) throw new Error('目录探测不可用')
    return parseDirectoryFacts(new TextDecoder().decode(result.stdout))
  } finally { await connection.close() }
}

export function pathSuggestions(query: string, facts: DirectoryFacts): CommandSuggestion[] {
  const match = /^(cd|ls|cat|less|tail -f)\s+(.*)$/.exec(query)
  if (!match) return []
  const verb = match[1]!, fragment = match[2]!.replace(/^['"]|['"]$/g, '')
  const paths = verb === 'cd' ? facts.directories : verb === 'ls' ? [...facts.directories, ...facts.files] : facts.files
  return paths.filter(path => !fragment || matchesQuery(path, fragment)).slice(0, 8)
    .map(path => ({ command: `${verb} -- ${shellQuote(path)}`, source: 'directory', priority: 2, uses: 0, lastUsed: 0 }))
}
