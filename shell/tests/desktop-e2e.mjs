import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const shell = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(shell, '..')
const artifacts = await mkdtemp(join(tmpdir(), 'sealshell-desktop-'))
const processes = []
let browser, page
const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await sleep(100)
  }
  throw new Error(`Timed out: ${last?.message ?? 'condition not reached'}`)
}
async function freePort(port = 0) {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const selected = server.address().port
  await new Promise(resolve => server.close(resolve))
  return selected
}
function start(name, executable, args, env = {}) {
  const child = spawn(executable, args, { cwd: shell, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  const log = createWriteStream(join(artifacts, `${name}.log`))
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  child.on('error', error => errors.push(`${name}: ${error.message}`))
  child.on('close', (code, signal) => { log.end(`\nProcess exited: ${code}, signal: ${signal}\n`) })
  return child
}
try {
  const vitePort = await freePort()
  const serverURL = `http://127.0.0.1:${vitePort}`
  const debugPort = await freePort()
  const cargo = process.env.CARGO ?? join(process.env.USERPROFILE, '.cargo/bin/cargo.exe')
  const build = start('build', cargo, ['build', '-p', 'sealshell', '--offline'], { TAURI_CONFIG: JSON.stringify({ build: { devUrl: serverURL } }) })
  const built = await new Promise(resolve => build.once('exit', resolve))
  if (built !== 0) throw new Error('Desktop build failed; see build.log')
  const remote = join(artifacts, 'remote'), local = join(artifacts, 'local')
  await mkdir(remote); await mkdir(local)
  const payload = '桌面传输 smoke test\n'.repeat(16000)
  await writeFile(join(local, 'sample.txt'), payload)
  let output = ''
  const ssh = start('ssh', process.env.SEAL_PYTHON ?? join(root, '.venv/Scripts/python.exe'), [join(root, '.agents/skills/seal-e2e/mock-ssh-server.py')], {
    PYTHONIOENCODING: 'utf-8', MOCK_SFTP_ROOT: remote, MOCK_SSH_PASSWORD: 'fixture-password', MOCK_SSH_REPORT_CWD: '1', MOCK_SSH_STATE_PATH: join(artifacts, 'ssh-state.json'),
    ...(process.env.SEAL_E2E_BASH ? { MOCK_SSH_BASH: process.env.SEAL_E2E_BASH } : {}),
    ...(process.env.SEAL_E2E_ZSH ? { MOCK_SSH_ZSH: process.env.SEAL_E2E_ZSH } : {}),
  })
  ssh.stdout.on('data', data => { output += data })
  const port = Number(await until(() => /MOCK_SSH_PORT=(\d+)/.exec(output)?.[1]))
  start('vite', process.execPath, [join(shell, 'node_modules/vite/bin/vite.js'), '--port', String(vitePort), '--host', '127.0.0.1'])
  await until(async () => (await fetch(serverURL)).ok)
  start('desktop', join(root, 'target/debug/sealshell.exe'), [], {
    SEALSHELL_DATA_DIR: join(artifacts, 'data'), WEBVIEW2_USER_DATA_FOLDER: join(artifacts, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  })
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(serverURL)))
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.welcome', { timeout: 20000 })
  await expect(page.locator('.global-error')).toHaveCount(0)
  await page.evaluate(async ({ port }) => {
    const { store } = await import('/src/stores/app.ts')
    const ws = await import('/src/services/ws.ts')
    const vault = await import('/src/services/vault.ts')
    await ws.createHost({ id: 'desktop-fixture', name: 'Desktop fixture', address: '127.0.0.1', port, username: 'fixture', folderId: null })
    await vault.saveCredentialRecord('desktop-fixture', { password: 'fixture-password' })
    window.desktopFixture = { store, ws }
  }, { port })
  await page.getByText('Desktop fixture', { exact: true }).dblclick()
  await page.locator('#host-key-accept').click()
  await page.waitForFunction(() => window.desktopFixture.store.tabs.some(tab => tab.kind === 'terminal' && tab.state === 'online'))
  if (process.env.SEAL_E2E_BASH || process.env.SEAL_E2E_ZSH) {
    const directory = join(remote, "目录 a'b;$(touch sentinel) %20")
    await mkdir(directory)
    const cwd = directory.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    await page.evaluate(async cwd => {
      const { store } = window.desktopFixture
      const { sendInput } = await import('/src/services/ssh.ts')
      const quote = value => `'${value.replace(/'/g, "'\\''")}'`
      await sendInput(store.tabs.find(tab => tab.kind === 'terminal').sessionId, new TextEncoder().encode(`cd -- ${quote(cwd)}\npwd\n`))
    }, cwd)
    await page.waitForFunction(cwd => window.desktopFixture.store.tabs.find(tab => tab.kind === 'terminal')?.cwd === cwd, cwd)
    const copied = await page.evaluate(cwd => {
      const { store, ws } = window.desktopFixture
      return ws.addTab(store.hosts[0], 'fixture-password', undefined, { initialCwd: cwd }).id
    }, cwd)
    await page.waitForFunction(({ copied, cwd }) => window.desktopFixture.store.tabs.find(tab => tab.id === copied)?.cwd === cwd, { copied, cwd })
    await page.evaluate(copied => window.desktopFixture.ws.closeTabs([copied]), copied)
    expect(await readFile(join(artifacts, 'ssh-state.json'), 'utf8')).toContain('shell_cwds')
    await page.evaluate(async () => {
      const history = await import('/src/services/terminalSuggestions/runtime.ts')
      await history.clearSuggestionHistory()
      await history.saveSuggestionPreferences(true, true, { ...history.commandSuggestions.recommendations, cloud: false, automatic: true, remoteContext: true })
      window.historyFixture = history
      window.historyPrompt = (await import('/src/services/terminalSuggestions/commandLine.ts')).isShellPrompt
    })
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => window.historyPrompt(row.textContent)))
    const execBeforeHistory = JSON.parse(await readFile(join(artifacts, 'ssh-state.json'), 'utf8')).exec
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('git ')
    await page.waitForTimeout(900)
    await expect(page.getByRole('listbox', { name: '命令候选' })).toHaveCount(0)
    await page.keyboard.press('Control+u')
    // Manual line editing pauses suggestions until the shell confirms a fresh prompt.
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent).filter(text => text.trim())
      return window.historyPrompt(rows.at(-1))
    })
    const promptCount = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].filter(row => window.historyPrompt(row.textContent)).length)
    await page.keyboard.press('Enter')
    await page.waitForFunction(count => [...document.querySelectorAll('.xterm-rows > div')].filter(row => window.historyPrompt(row.textContent)).length > count, promptCount)
    await page.evaluate(() => window.historyFixture.rememberSuggestionCommand('desktop-fixture', 'cd ../local-project'))
    await page.keyboard.type('cd ../loc')
    const historyCandidate = page.getByRole('option').filter({ has: page.getByText('cd ../local-project', { exact: true }) })
    await expect(historyCandidate).toHaveAttribute('data-source', 'history')
    await page.waitForTimeout(900)
    expect(JSON.parse(await readFile(join(artifacts, 'ssh-state.json'), 'utf8')).exec).toBe(execBeforeHistory)
    expect(await page.evaluate(async () => (await import('/src/services/terminalSuggestions/diagnostics.ts')).recentRecommendationTraces())).toEqual([])
    await historyCandidate.click()
    expect(await page.evaluate(() => window.desktopFixture.store.tabs.find(tab => tab.kind === 'terminal').cwd)).toBe(cwd)
    await page.keyboard.press('Control+u')
    await page.keyboard.press('Enter')
    console.log('Desktop history-only suggestions: literal history, no catalog, no context exec or AI request, acceptance without execution')
  }
  await page.evaluate(async () => {
    const { store, ws } = window.desktopFixture
    const terminal = store.tabs.find(tab => tab.kind === 'terminal')
    const { sendInput } = await import('/src/services/ssh.ts')
    await sendInput(terminal.sessionId, new TextEncoder().encode('echo smoke-ok\n'))
    window.desktopFixture.terminal = terminal.id
    const files = await import('/src/services/sftp/file-tabs.ts')
    window.desktopFixture.local = files.createLocalFileTab().id
    window.desktopFixture.remote = files.createFileTab(store.hosts[0], terminal.id, '/').id
  })
  await page.waitForFunction(() => window.desktopFixture.store.tabs.filter(tab => tab.kind === 'file').length === 2 && window.desktopFixture.store.tabs.filter(tab => tab.kind === 'file').every(tab => tab.state === 'online'))
  await page.evaluate(async ({ local }) => {
    const files = await import('/src/services/sftp/file-tabs.ts')
    await files.navigateFileTab(window.desktopFixture.local, local)
    const { transferFileEntries } = await import('/src/services/files/transfers.ts')
    await transferFileEntries(window.desktopFixture.local, window.desktopFixture.remote, [local + '\\sample.txt'])
  }, { local })
  expect(await readFile(join(remote, 'sample.txt'), 'utf8')).toBe(payload)
  await page.evaluate(async () => {
    const { openEditorTab, saveEditorTab } = await import('/src/services/sftp/editor-tabs.ts')
    const { store, remote } = window.desktopFixture
    const tab = store.tabs.find(tab => tab.id === remote)
    const editor = await openEditorTab(remote, tab.file.entries.find(entry => entry.name === 'sample.txt'))
    await new Promise(resolve => { const timer = setInterval(() => { if (editor.state !== 'connecting') { clearInterval(timer); resolve() } }, 25) })
    if (editor.state !== 'online') throw new Error(editor.error)
    editor.editor.content = 'native editor saved\n'; editor.editor.dirty = true
    await saveEditorTab(editor.id)
  })
  expect(await readFile(join(remote, 'sample.txt'), 'utf8')).toBe('native editor saved\n')
  await page.evaluate(async () => {
    const { openMonitor } = await import('/src/services/monitoring/runtime.ts')
    openMonitor('desktop-fixture')
  })
  await page.waitForFunction(() => window.desktopFixture.store.tabs.some(tab => tab.kind === 'monitor' && tab.monitor.telemetry))
  await page.screenshot({ path: join(artifacts, 'desktop.png') })
  await page.evaluate(async () => { const { getCurrentWindow } = await import('/node_modules/@tauri-apps/api/window.js'); await getCurrentWindow().close() })
  await expect(page.getByRole('dialog', { name: '关闭 SealShell' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.global-error')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.welcome')).toBeVisible()
  await expect(page.getByText('Desktop fixture', { exact: true })).toBeVisible()
  const persisted = await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { readCredential } = await import('/src/services/storage.ts')
    const { loadCredentialRecord } = await import('/src/services/vault.ts')
    const { transferRuntime } = await import('/src/services/sftp/transfer-runtime.ts')
    return { tabs: store.tabs.length, tasks: transferRuntime.tasks.length, record: await readCredential('desktop-fixture'), credential: await loadCredentialRecord('desktop-fixture') }
  })
  expect(persisted.tabs).toBe(0); expect(persisted.tasks).toBe(0)
  expect(JSON.stringify(persisted.record)).not.toContain('fixture-password')
  expect(persisted.credential.password).toBe('fixture-password')
  expect(errors).toEqual([])
  console.log(`Desktop E2E passed. Artifacts: ${artifacts}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    await writeFile(join(artifacts, 'failure.html'), await page.content().catch(() => ''))
    await writeFile(join(artifacts, 'errors.json'), JSON.stringify(errors, null, 2))
  }
  console.error(`Desktop E2E failed. Artifacts: ${artifacts}`)
  throw error
} finally {
  if (page) await page.evaluate(async () => { const { nativeCall } = await import('/src/native/bridge.ts'); await nativeCall('runtime_close') }).catch(() => {})
  if (browser) await browser.close().catch(() => {})
  for (const child of processes.reverse()) {
    if (child.exitCode !== null) continue
    child.kill()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)])
  }
}
