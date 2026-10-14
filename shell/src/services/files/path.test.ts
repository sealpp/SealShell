import { describe, expect, it } from 'vitest'
import { createFilePaths, posixPaths } from './path'

describe('endpoint path semantics', () => {
  const windows = createFilePaths(true)
  it('preserves spaces and POSIX filename characters', () => {
    expect(posixPaths.join('/tmp', ' name ')).toBe('/tmp/ name ')
    expect(posixPaths.join('/tmp', 'a\\b')).toBe('/tmp/a\\b')
    expect(posixPaths.parent('/tmp/ name ')).toBe('/tmp')
  })
  it('navigates drive roots and relative Windows paths without POSIX prefixes', () => {
    expect(windows.normalize('..\\logs', 'D:\\work\\app')).toBe('D:\\work\\logs')
    expect(windows.parent('D:\\')).toBe('D:\\')
    expect(windows.normalize('C:/Users/a')).toBe('C:\\Users\\a')
    expect(() => windows.normalize('C:relative')).toThrow()
  })
  it('keeps UNC shares as navigation roots', () => {
    expect(windows.parent('\\\\server\\share\\folder')).toBe('\\\\server\\share\\')
    expect(windows.parent('\\\\server\\share\\')).toBe('\\\\server\\share\\')
  })
  it('compares Windows paths without case sensitivity and respects directory boundaries', () => {
    expect(windows.equal('C:\\Work', 'c:\\work')).toBe(true)
    expect(windows.descendant('C:\\Work\\src', 'c:\\work')).toBe(true)
    expect(windows.descendant('C:\\Worker', 'C:\\Work')).toBe(false)
    expect(posixPaths.equal('/A', '/a')).toBe(false)
    expect(posixPaths.descendant('/', '/')).toBe(false)
  })
})
