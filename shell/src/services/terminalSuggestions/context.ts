import { getSshSession } from '../ssh'
import { connectSsh } from '../ssh/connection'
import { shellQuote, commandName, parentPath } from './paths'
export { shellQuote } from './paths'

export interface DirectoryFacts {
  cwd: string
  home?: string
  directories: string[]
  files: string[]
  scripts: string[]
  tools: string[]
  limited?: boolean
}

/** Fixed read-only operations; quoted user text is a path or command-v lookup, never executable code. */
export function directoryProbe(cwd: string, executable?: string): string {
  if (!cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)) throw new Error('当前目录不可用')
  if (executable && commandName(executable) !== executable) throw new Error('命令名称不可用')
  return `# sealshell-recommendation-context
test "$(uname -s)" = Linux || exit 2
cd -- ${shellQuote(cwd)} || exit 1
printf 'cwd\\0%s\\0' "$PWD"
[ -d "$HOME" ] && printf 'home\\0%s\\0' "$HOME"
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
for t in python python3 conda uv npm pnpm yarn cmake make ninja docker ss journalctl ls eza exa grep rg ${executable ? shellQuote(executable) : ''}; do
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
      if (kind === 'home' && value.startsWith('/')) facts.home = value
      if (kind === 'dir' && facts.directories.length < 240) facts.directories.push(value)
      if (kind === 'file' && facts.files.length < 240) facts.files.push(value)
      if (kind === 'tool') facts.tools.push(value)
      if (kind === 'limited' && value === 'yes') facts.limited = true
      if (kind === 'done' && value === 'yes') done = true
    }
  }
  if (!done || !facts.cwd.startsWith('/')) throw new Error('目录探测未完成')
  facts.directories = [...new Set(facts.directories)]
  facts.tools = [...new Set(facts.tools)]
  return facts
}

/** Collect a bounded directory snapshot for AI without filtering by the input name. */
export function nearbyPathProbe(cwd: string, roots: readonly string[]): string {
  if (!cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)
    || roots.length > 12 || roots.some(root => !root.startsWith('/') || /[\x00-\x1f\x7f]/.test(root)
      || root !== cwd && parentPath(root) !== cwd && parentPath(root) !== parentPath(cwd))) throw new Error('路径查找范围不可用')
  return `# sealshell-recommendation-context tree
test "$(uname -s)" = Linux || exit 2
printf 'cwd\\0%s\\0' ${shellQuote(cwd)}
total=0
for root in ${roots.map(shellQuote).join(' ')}; do
  case "$root" in /proc|/sys|/dev|/run) continue;; esac
  [ ! -L "$root" ] && [ -d "$root" ] && [ -r "$root" ] && [ -x "$root" ] || continue
  for kind in dir file; do
    count=0
    for p in "\${root%/}"/* "\${root%/}"/.[!.]*; do
      [ -e "$p" ] || continue
      if [ -d "$p" ]; then [ "$kind" = dir ] || continue; else [ "$kind" = file ] || continue; fi
      count=$((count+1)); if [ "$count" -gt 16 ]; then printf 'limited\\0yes\\0'; break; fi
      total=$((total+1)); if [ "$total" -gt 240 ]; then printf 'limited\\0yes\\0'; break 3; fi
      printf '%s\\0%s\\0' "$kind" "$p"
    done
  done
done
printf 'done\\0yes\\0'`
}

async function probeFacts(sessionId: string, script: string, signal: AbortSignal): Promise<DirectoryFacts> {
  const info = getSshSession(sessionId)
  if (!info) throw new Error('SSH 会话不可用')
  const connection = await connectSsh(info, signal)
  try {
    const result = await connection.worker.exec(script, { timeoutMs: 3000, maxOutputBytes: 48 * 1024 })
    signal.throwIfAborted()
    if (result.exitCode !== 0) throw new Error('目录探测不可用')
    return parseDirectoryFacts(new TextDecoder().decode(result.stdout))
  } finally { await connection.close() }
}

export function probeDirectory(sessionId: string, cwd: string, signal: AbortSignal, executable?: string): Promise<DirectoryFacts> {
  return probeFacts(sessionId, directoryProbe(cwd, executable), signal)
}

export function probeNearbyPaths(sessionId: string, cwd: string, roots: string[], signal: AbortSignal): Promise<DirectoryFacts> {
  return probeFacts(sessionId, nearbyPathProbe(cwd, roots), signal)
}
