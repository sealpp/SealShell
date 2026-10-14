export interface FilePaths {
  normalize(path: string, cwd?: string): string
  parent(path: string): string
  basename(path: string): string
  join(parent: string, name: string): string
  equal(a: string, b: string): boolean
  descendant(path: string, parent: string): boolean
}

export function createFilePaths(windows = false): FilePaths {
  const rootOf = (path: string): string => {
    if (!windows) return '/'
    const drive = /^[a-z]:\//i.exec(path)?.[0]
    if (drive) return drive[0].toUpperCase() + drive.slice(1)
    const unc = /^\/\/[^/]+\/[^/]+\/?/.exec(path)?.[0]
    if (unc) return unc.replace(/\/?$/, '/')
    throw new Error('请输入盘符绝对路径或 UNC 共享路径')
  }
  const normalize = (path: string, cwd = windows ? 'C:\\' : '/'): string => {
    let value = path || cwd
    if (windows) value = value.replace(/\\/g, '/')
    const base = windows ? cwd.replace(/\\/g, '/') : cwd
    if (windows ? !/^(?:[a-z]:\/|\/\/)/i.test(value) : !value.startsWith('/')) {
      if (windows && /^[a-z]:/i.test(value)) throw new Error('盘符路径必须包含根目录分隔符')
      if (windows && value.startsWith('/')) value = rootOf(base) + value.slice(1)
      else value = base.replace(/\/$/, '') + '/' + value
    }
    const root = rootOf(value)
    const parts: string[] = []
    for (const part of value.slice(root.length).split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    const normalized = root + parts.join('/')
    return windows ? normalized.replace(/\//g, '\\') : normalized
  }
  const key = (path: string): string => {
    const result = normalize(path)
    return windows ? result.toLowerCase() : result
  }
  const separator = windows ? '\\' : '/'
  return {
    normalize,
    parent(path) { return normalize('..', normalize(path)) },
    basename(path) { const normalized = normalize(path); return normalized.split(separator).pop() || normalized },
    join(parent, name) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || (windows && /[\\:]/.test(name))) throw new Error('文件名无效')
      return normalize(normalize(parent).replace(/[\\/]$/, '') + separator + name)
    },
    equal(a, b) { return key(a) === key(b) },
    descendant(path, parent) { return key(path).startsWith(key(parent).replace(/[\\/]$/, '') + separator) },
  }
}

export const posixPaths = createFilePaths()
