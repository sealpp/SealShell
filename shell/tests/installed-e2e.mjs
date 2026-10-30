import { chromium, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const installer = resolve(process.argv[2] ?? join(root, 'target/release/bundle/nsis/SealShell_0.1.0_x64-setup.exe'))
const artifacts = await mkdtemp(join(tmpdir(), 'sealshell-installed-'))
const installDir = join(artifacts, 'application')
const appData = join(process.env.APPDATA, 'app.sealshell.desktop')
const registry = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[bool]((Test-Path -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/SealShell') -or (Test-Path -LiteralPath 'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/SealShell'))"], { encoding: 'utf8', windowsHide: true }).trim()
if (registry !== 'False' || existsSync(appData)) throw new Error('Installer test requires no existing SealShell desktop installation or data; existing files were left untouched.')
const children = []
let installed = false, browser, page
const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value } catch {} await sleep(100) }
  throw new Error('Installed application did not become ready')
}
function start(name, executable, args, env = process.env) {
  const child = spawn(executable, args, { cwd: artifacts, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(artifacts, `${name}.log`))
  child.stdout.pipe(log); child.stderr.pipe(log); children.push(child)
  return child
}
async function exited(child) { return child.exitCode ?? await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }) }
try {
  const setup = start('install', installer, ['/S', '/NS', `/D=${installDir}`])
  expect(await exited(setup)).toBe(0)
  installed = true
  expect(existsSync(join(installDir, 'sealshell.exe'))).toBe(true)
  const remote = join(artifacts, 'remote'); await mkdir(remote)
  let output = ''
  const ssh = start('ssh', process.env.SEAL_PYTHON ?? join(root, '.venv/Scripts/python.exe'), [join(root, '.agents/skills/seal-e2e/mock-ssh-server.py')], {
    ...process.env, MOCK_SFTP_ROOT: remote, MOCK_SSH_PASSWORD: 'fixture-password', PYTHONIOENCODING: 'utf-8',
  })
  ssh.stdout.on('data', data => { output += data })
  const sshPort = Number(await until(() => /MOCK_SSH_PORT=(\d+)/.exec(output)?.[1]))
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const debugPort = server.address().port; await new Promise(resolve => server.close(resolve))
  const app = start('application', join(installDir, 'sealshell.exe'), [], {
    ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
    WEBVIEW2_USER_DATA_FOLDER: join(artifacts, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  })
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost')))
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await expect(page.locator('.welcome')).toBeVisible()
  await expect(page.locator('.global-error')).toHaveCount(0)
  await page.evaluate(async port => {
    const call = (operation, args) => window.__TAURI_INTERNALS__.invoke('native_call', { operation, args })
    const record = await call('credential_protect', { id: 'installed-host', value: { password: 'fixture-password' } })
    await call('store_write', { changes: [
      { collection: 'hosts', key: 'installed-host', value: { id: 'installed-host', name: 'Installed fixture', address: '127.0.0.1', port, username: 'fixture', folderId: null } },
      { collection: 'credentials', key: 'installed-host', value: record },
    ] })
  }, sshPort)
  await page.reload()
  await page.getByText('Installed fixture', { exact: true }).dblclick()
  await page.locator('#host-key-accept').click()
  await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
  await expect(page.locator('.xterm-screen')).toBeVisible()
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo smoke-ok')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('smoke-ok')
  const note = join(artifacts, 'installed-note.txt')
  await writeFile(note, 'installed local file\n')
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await page.getByRole('button', { name: '新建本地窗口并分栏', exact: true }).click()
  await page.getByRole('textbox', { name: '本地路径', exact: true }).fill(artifacts)
  await page.getByRole('textbox', { name: '本地路径', exact: true }).press('Enter')
  await page.getByRole('gridcell', { name: 'installed-note.txt', exact: true }).dblclick()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('installed local file')
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('packaged editor verified')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('packaged editor verified')
  await page.keyboard.press('Control+S')
  await until(async () => (await readFile(note, 'utf8')) === 'packaged editor verified')
  await page.screenshot({ path: join(artifacts, 'installed.png') })
  expect(errors).toEqual([])
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
  await expect(page.getByRole('dialog', { name: '关闭 SealShell' })).toBeVisible()
  await page.getByRole('button', { name: '退出', exact: true }).click()
  expect(await exited(app)).toBe(0)
  console.log(`Installed release passed without development PATH. Artifacts: ${artifacts}`)
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
  console.error(`Installed release failed. Artifacts: ${artifacts}`)
  throw error
} finally {
  await browser?.close().catch(() => {})
  for (const child of children.reverse()) if (child.exitCode === null) { child.kill(); await Promise.race([exited(child), sleep(3000)]) }
  if (installed) {
    const uninstaller = start('uninstall', join(installDir, 'uninstall.exe'), ['/S'])
    await exited(uninstaller)
    await until(() => !existsSync(join(installDir, 'sealshell.exe')))
    console.log('Temporary installation uninstalled.')
  }
  // This path was verified absent before the test; preserve our newly-created
  // fixture data in the test artifacts instead of deleting any user data.
  if (existsSync(appData)) await rename(appData, join(artifacts, 'application-data'))
}
