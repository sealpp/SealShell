import { describe, expect, it } from 'vitest'
import { initialDirectoryCommand, parseTerminalDirectory } from './terminalDirectory'

describe('reported terminal directories', () => {
  it('decodes OSC 7 file URIs exactly once', () => {
    expect(parseTerminalDirectory(7, 'file://remote/work/%E4%B8%AD%E6%96%87%20%23%25%3B%27')).toBe("/work/中文 #%;'")
    expect(parseTerminalDirectory(7, 'file://remote/work/%2520')).toBe('/work/%20')
    expect(parseTerminalDirectory(7, '/work/raw%20path')).toBe('/work/raw%20path')
    expect(parseTerminalDirectory(7, 'file://remote/')).toBe('/')
  })

  it('reads iTerm2 literal paths and VS Code escaped properties', () => {
    expect(parseTerminalDirectory(1337, String.raw`CurrentDir=/work/a=b;%20\x20`)).toBe(String.raw`/work/a=b;%20\x20`)
    expect(parseTerminalDirectory(633, String.raw`P;Cwd=/work/中文\x20a=b\x3b\x5c;nonce`)).toBe('/work/中文 a=b;\\')
  })

  it('ignores other properties, relative paths, invalid URIs and control characters', () => {
    for (const [code, value] of [
      [7, 'https://remote/work'], [7, 'file://remote/%zz'], [7, 'file://remote/%0aexit'],
      [7, '/work\u001bexit'], [7, 'relative'], [1337, 'CurrentDir=~/work'], [1337, 'SetMark'],
      [633, 'P;Cwd=/work\\x0dexit'], [633, 'P;Other=/work'],
    ] as const) expect(parseTerminalDirectory(code, value)).toBeUndefined()
  })
})

describe('initial shell directory', () => {
  it('quotes shell metacharacters as one literal argument', () => {
    expect(initialDirectoryCommand("/中文 path/a'b;$(touch sentinel)`exit`%20\\")).toBe(" cd -- '/中文 path/a'\\''b;$(touch sentinel)`exit`%20\\'\r")
    expect(initialDirectoryCommand('/')).toBe(" cd -- '/'\r")
  })

  it('does not send a command for an unknown, relative or control-containing directory', () => {
    for (const value of [undefined, '', 'relative', '~/work', '/work\nexit', '/work\r', '/work\u0000', '/work\u001b']) {
      expect(initialDirectoryCommand(value)).toBeUndefined()
    }
  })
})
