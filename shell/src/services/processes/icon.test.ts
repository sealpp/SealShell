import { expect, it } from 'vitest'
import { processIconKind } from './icon'

it('uses an explicit application even when the kernel process name is shortened', () => {
  expect(processIconKind({ name: 'clickhouse-serv', argv: ['/opt/clickhouse-server', '--config-file=x'] })).toBe('clickhouse')
  expect(processIconKind({ name: 'node', argv: ['/usr/bin/node', '/opt/node_modules/@openai/codex/bin/codex.js'] })).toBe('codex')
  expect(processIconKind({ name: 'npm run dev', argv: ['npm run dev'] })).toBe('npm')
})

it('uses exact package entries across paths with spaces, pnpm stores and bin links', () => {
  for (const entry of ['/srv/中文 project/node_modules/vite/bin/vite.js', '/srv/node_modules/.pnpm/vite@6/node_modules/vite/bin/vite.js', './node_modules/.bin/vite']) {
    expect(processIconKind({ name: 'node', argv: ['/usr/bin/node', '--require', './hooks.js', '--inspect=9229', entry] })).toBe('vite')
  }
  expect(processIconKind({ name: 'node', argv: ['node', '--', '/srv/node_modules/typescript/bin/tsc'] })).toBe('typescript')
})

it('does not confuse arguments, eval, preload hooks or a similarly named package with the executed app', () => {
  const vite = '/srv/node_modules/vite/bin/vite.js'
  for (const args of [['server.js', vite], ['-e', 'console.log("vite")', vite], ['--require', vite, 'server.js'], ['--unknown-option', vite], ['/srv/not_node_modules/vite/bin/vite.js'], ['/srv/node_modules/vite/bin/vite.js.backup'], ['/srv/node_modules/.bin/vite/other']]) {
    expect(processIconKind({ name: 'node', argv: ['node', ...args] })).toBe('node')
  }
  expect(processIconKind({ name: 'bash', argv: ['bash', '-c', 'node ' + vite] })).toBe('shell')
  expect(processIconKind({ name: 'custom-worker', argv: ['custom-worker', '--tool=codex', '--manager=npm'] })).toBe('process')
})

it('falls back to the runtime or generic icon when the command line is unavailable', () => {
  expect(processIconKind({ name: 'python3.12', argv: [] })).toBe('python')
  expect(processIconKind({ name: 'node-worker', argv: [] })).toBe('process')
})

it('recognizes AI CLI entry points without treating model names or generic agents as applications', () => {
  expect(processIconKind({ name: 'node', argv: ['node', '/srv/node_modules/@anthropic-ai/claude-code/cli.js'] })).toBe('claude')
  expect(processIconKind({ name: 'node', argv: ['node', '/srv/node_modules/@google/gemini-cli/bundle/gemini.js'] })).toBe('gemini')
  expect(processIconKind({ name: 'node', argv: ['node', '/srv/node_modules/@anthropic-ai/claude-code-helper/cli.js'] })).toBe('node')
  expect(processIconKind({ name: 'node', argv: ['node', 'agent.js', '--model=claude', '--provider=gemini'] })).toBe('node')
  expect(processIconKind({ name: 'agent', argv: ['/home/user/.local/bin/agent', '--model=claude'] })).toBe('process')
  expect(processIconKind({ name: 'cursor-agent', argv: ['/home/user/.local/bin/cursor-agent'] })).toBe('cursor')
})

it('identifies Python AI console scripts and explicit modules, not eval code or script arguments', () => {
  expect(processIconKind({ name: 'python3.12', argv: ['python3.12', '-u', '-m', 'aider'] })).toBe('aider')
  expect(processIconKind({ name: 'python', argv: ['python', '/srv/project with spaces/.venv/bin/vibe'] })).toBe('mistral')
  for (const args of [['-c', 'import aider'], ['agent.py', '-m', 'aider'], ['-m', 'aider_helper'], ['--unknown-flag', '-m', 'aider'], ['/srv/project/aider']]) {
    expect(processIconKind({ name: 'python', argv: ['python', ...args] })).toBe('python')
  }
})
