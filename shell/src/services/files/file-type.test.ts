import { describe, expect, it } from 'vitest'
import { fileType } from './file-type'

const file = (name: string) => fileType({ name, kind: 'file' })

describe('file type hints', () => {
  it('uses filesystem kinds before names, including links whose target is not known', () => {
    expect(fileType({ name: 'backup.zip', kind: 'directory' })).toBe('directory')
    expect(fileType({ name: 'photo.png', kind: 'symlink' })).toBe('symlink')
    expect(fileType({ name: 'service.json', kind: 'unknown' })).toBe('unknown')
  })

  it('prefers full names and bounded filename families over extensions', () => {
    expect(file('package.json')).toBe('dependency')
    expect(file('CMakeLists.txt')).toBe('build')
    expect(file('docker-compose.yaml')).toBe('docker')
    expect(file('Dockerfile.production')).toBe('docker')
    expect(file('.env.production.local')).toBe('config')
    expect(file('dockerfile-notes.txt')).toBe('text')
    expect(file('my.env.json')).toBe('json')
    expect(file('README.md')).toBe('markdown')
    expect(file('README')).toBe('text')
  })

  it('matches the longest known extension, ignoring case only for display', () => {
    expect(file('client.D.TS')).toBe('typescript-declaration')
    expect(file('client.test.TS')).toBe('typescript')
    expect(file('backup.TAR.GZ')).toBe('archive')
    expect(file('dump.sql.gz')).toBe('archive')
    expect(file('照片.JPG')).toBe('image')
    expect(file('.hidden.config.json')).toBe('json')
  })

  it('does not infer types from arbitrary dotfiles, inner suffixes or extensionless names', () => {
    for (const name of ['.json', '.secret', 'json', 'run', 'photo.jpg.backup', 'archive.zip.part', 'file.', '__proto__', 'constructor']) {
      expect(file(name)).toBe('file')
    }
    expect(file('.gitignore')).toBe('git')
    expect(file('.bashrc')).toBe('shell')
  })
})
