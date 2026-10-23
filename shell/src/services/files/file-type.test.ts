import { describe, expect, it } from 'vitest'
import { filePresentation } from './file-type'

const file = (name: string, path = '/fixtures/' + name) => filePresentation({ name, path, kind: 'file' })

describe('file presentation', () => {
  it('keeps format independent of a filename-specific tool icon', () => {
    expect(file('package.json')).toMatchObject({ icon: 'nodejs', typeLabel: 'JSON 文件' })
    expect(file('pnpm-lock.yaml')).toMatchObject({ icon: 'pnpm', typeLabel: 'YAML 文件' })
    expect(file('nginx.conf')).toMatchObject({ icon: 'nginx', typeLabel: '配置文件' })
    expect(file('main.rs')).toMatchObject({ icon: 'rust', typeLabel: 'Rust 源码' })
    expect(file('main.go')).toMatchObject({ icon: 'go', typeLabel: 'Go 源码' })
  })

  it('honors parent-qualified names on POSIX, drive and UNC paths', () => {
    for (const path of ['/home/.config/graphqlrc', 'C:\\Users\\test\\.config\\graphqlrc', '\\\\server\\share\\.config\\graphqlrc']) {
      expect(file('graphqlrc', path).icon).toBe('graphql')
    }
    expect(file('graphqlrc', '/home/other/graphqlrc').icon).toBe('file')
    expect(file('x\\.config\\graphqlrc', '/home/x\\.config\\graphqlrc').icon).toBe('file')
  })

  it('uses exact names and longest extensions, without broad prefixes swallowing archives', () => {
    expect(file('client.D.TS')).toMatchObject({ icon: 'typescript-def', typeLabel: 'TypeScript 声明' })
    expect(file('client.test.TS').icon).toBe('test-ts')
    for (const name of ['Dockerfile.tar.gz', '.env.custom.zip', 'dump.sql.gz']) {
      expect(file(name)).toMatchObject({ icon: 'zip', typeLabel: '压缩包' })
    }
    expect(file('Dockerfile.custom')).toMatchObject({ icon: 'docker' })
    expect(file('照片.JPG')).toMatchObject({ icon: 'image', typeLabel: 'JPEG 图片' })
    expect(file('archive.zip.part')).toMatchObject({ icon: 'file', typeLabel: 'PART 文件' })
  })

  it('uses directory associations only for real directories', () => {
    expect(filePresentation({ name: 'src', path: '/app/src', kind: 'directory' })).toEqual({ icon: 'folder-src', typeLabel: '文件夹' })
    expect(filePresentation({ name: 'backup.zip', path: '/backup.zip', kind: 'directory' })).toEqual({ icon: 'folder', typeLabel: '文件夹' })
    expect(filePresentation({ name: 'workflows', path: '/app/.github/workflows', kind: 'directory' }).icon).toBe('folder-gh-workflows')
    expect(file('src').icon).toBe('file')
  })

  it('decorates links without changing their type or guessing directory targets', () => {
    expect(filePresentation({ name: 'main.rs', path: '/main.rs', kind: 'symlink' })).toEqual({ icon: 'rust', typeLabel: '符号链接', decoration: '⤷' })
    expect(filePresentation({ name: 'src', path: '/src', kind: 'symlink' })).toEqual({ icon: 'file', typeLabel: '符号链接', decoration: '⤷' })
    expect(filePresentation({ name: 'socket.json', path: '/socket.json', kind: 'unknown' })).toEqual({ icon: 'file', typeLabel: '未知类型', decoration: '?' })
  })

  it('safely falls back for unrecognized names and object property names', () => {
    for (const name of ['.unrecognized', 'run', '__proto__', 'constructor', 'file.']) expect(file(name).icon).toBe('file')
    expect(file('.env').icon).toBe('tune')
    expect(file('.gitignore').icon).toBe('git')
  })
})
