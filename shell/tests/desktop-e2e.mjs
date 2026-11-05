import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyDesktopDragging } from './desktop-dragging.mjs'
import { verifyDesktopHostKeys } from './desktop-host-keys.mjs'
import { verifyDesktopTerminalMouse } from './desktop-terminal-mouse.mjs'
import { verifyDesktopSidebarPreview } from './desktop-sidebar-preview.mjs'
import { verifyDesktopReconnect } from './desktop-reconnect.mjs'

const shell = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(shell, '..')
const artifacts = await mkdtemp(join(tmpdir(), 'sealshell-desktop-'))
const processes = []
let browser, page, modelServer
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
  const executable = join(artifacts, 'sealshell-e2e.exe')
  const build = start('build', cargo, ['rustc', '-p', 'sealshell', '--bin', 'sealshell', '--offline', '--', '-o', executable], { TAURI_CONFIG: JSON.stringify({ build: { devUrl: serverURL } }) })
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
  const desktop = start('desktop', executable, [], {
    SEALSHELL_DATA_DIR: join(artifacts, 'data'), WEBVIEW2_USER_DATA_FOLDER: join(artifacts, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  })
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(serverURL)))
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.welcome', { timeout: 20000 })
  await expect(page.locator('.global-error')).toHaveCount(0)
  await verifyDesktopSidebarPreview(page, { artifacts })
  const modelRequests = []
  modelServer = createHttpServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : undefined
      modelRequests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, key: request.headers['x-api-key'], payload })
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET') response.end(JSON.stringify({ data: [{ id: 'online-model', name: 'Online model' }] }))
      else if (request.url.endsWith('/messages')) response.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }))
      else if (request.url.endsWith('/responses')) response.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))
      else response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
  })
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  await page.evaluate(async port => {
    const { configureModelFixture } = await import('/tests/model-fixture.ts')
    const { resolveModel } = await import('/src/services/modelServices/catalog.ts')
    const { discoverModels, checkModel } = await import('/src/services/modelServices/client.ts')
    const { readCredential } = await import('/src/services/storage.ts')
    const runtime = await import('/src/services/terminalSuggestions/runtime.ts')
    for (const protocol of ['openai-chat', 'anthropic', 'openai-responses']) {
      await configureModelFixture(`http://127.0.0.1:${port}/v1`, 'desktop-model', 'native-model-fixture-key', protocol)
      const resolved = resolveModel()
      const online = await discoverModels(resolved.service, new AbortController().signal)
      if (online[0]?.id !== 'online-model' || resolved.service.models.length !== 1) throw new Error('Model listing changed the configured catalog')
      await checkModel(resolved, new AbortController().signal)
      const credential = await readCredential(`model-service:${resolved.service.id}`)
      if (!credential || JSON.stringify(credential).includes('native-model-fixture-key')) throw new Error('Model key is not protected')
    }
    await runtime.saveSuggestionPreferences(true, true, { ...runtime.commandSuggestions.recommendations, cloud: false })
  }, modelServer.address().port)
  expect(modelRequests.filter(request => request.method === 'GET')).toHaveLength(3)
  const generated = modelRequests.filter(request => request.method === 'POST')
  expect(generated.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/messages', '/v1/responses'])
  expect(generated[0].authorization).toBe('Bearer native-model-fixture-key')
  expect(generated[1].key).toBe('native-model-fixture-key')
  expect(generated[1].authorization).toBeUndefined()
  expect(generated[2].payload).toMatchObject({ input: 'Reply with OK.', store: false, max_output_tokens: 2048 })
  await page.evaluate(async () => { const { store } = await import('/src/stores/app.ts'); store.settingsSection = 'models'; store.settingsModalOpen = true })
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('placeholder', '已保存，输入可更换')
  await page.screenshot({ path: join(artifacts, 'model-services.png') })
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  console.log('Desktop model services: three protocols, native model listing and generation, DPAPI keys, no key refill or automatic model additions')
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
  const systemIcon = page.locator('.conn-item').filter({ hasText: 'Desktop fixture' }).getByRole('img', { name: 'Ubuntu 24.04 LTS' })
  await expect(systemIcon).toBeVisible()
  await expect(systemIcon).toHaveJSProperty('naturalWidth', 32)
  const tabSystemIcon = page.locator('.terminal-tab').filter({ hasText: 'Desktop fixture' }).getByRole('img', { name: 'Ubuntu 24.04 LTS' })
  await expect(tabSystemIcon).toBeVisible()
  await expect(tabSystemIcon).toHaveAttribute('src', await systemIcon.getAttribute('src'))
  const detectedSystem = await page.evaluate(async () => {
    const { nativeCall } = await import('/src/native/bridge.ts')
    return nativeCall('store_get', { collection: 'hostSystems', key: 'desktop-fixture' })
  })
  expect(detectedSystem.info.id).toBe('ubuntu')
  await page.screenshot({ path: join(artifacts, 'remote-system-icon.png') })
  console.log('Desktop remote system: authenticated SSH discovery, Ubuntu icon and SQLite persistence')
  await verifyDesktopHostKeys(page, { port, artifacts })
  await verifyDesktopReconnect(page, { artifacts })
  await verifyDesktopTerminalMouse(page, { artifacts, pid: desktop.pid })
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
  await verifyDesktopDragging(page, { local, remote, artifacts, pid: desktop.pid })
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
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)) }
  for (const child of processes.reverse()) {
    if (child.exitCode !== null) continue
    child.kill()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)])
  }
}
