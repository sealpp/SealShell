import { describe, expect, it } from 'vitest'
import { detectEditorLanguage } from './language'

const definitions = [
  { id: 'javascript', extensions: ['.js'] },
  { id: 'typescript', extensions: ['.ts', '.tsx'] },
  { id: 'test', extensions: ['.test.ts'] },
  { id: 'dockerfile', filenames: ['Dockerfile'] },
  { id: 'shell', filenames: ['.bashrc'], firstLine: '^#!.*\\bsh\\b' },
  { id: 'python', extensions: ['.py'], firstLine: '^#!.*\\bpython[0-9.]*\\b' },
]
describe('editor language detection', () => {
  it('recognizes complete names and longest extensions across both path conventions', () => {
    expect(detectEditorLanguage(definitions, 'C:\\app\\Dockerfile', '')).toBe('dockerfile')
    expect(detectEditorLanguage(definitions, '/app/client.TEST.TS', '')).toBe('test')
    expect(detectEditorLanguage(definitions, '/app/.bashrc', '')).toBe('shell')
    expect(detectEditorLanguage(definitions, '/app/view.tsx', '')).toBe('typescript')
  })
  it('uses a shebang for extensionless scripts and falls back to plain text', () => {
    expect(detectEditorLanguage(definitions, '/usr/bin/setup', '#!/usr/bin/env python3\nprint(1)')).toBe('python')
    expect(detectEditorLanguage(definitions, '/app/README', 'just text\n#!/bin/sh')).toBe('plaintext')
    expect(detectEditorLanguage(definitions, '/app/test.py', '#!/bin/sh')).toBe('python')
  })
})
