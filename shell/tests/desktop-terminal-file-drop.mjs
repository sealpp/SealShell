import { expect } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const sourceScript = fileURLToPath(new URL('./desktop-file-drop.ps1', import.meta.url))
const mouseScript = fileURLToPath(new URL('./desktop-mouse.py', import.meta.url))
const python = process.env.SEAL_PYTHON ?? fileURLToPath(new URL('../../.venv/Scripts/python.exe', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function verifyTerminalFileDrop(page, { local, remote, artifacts, pid }) {
  const terminal = page.locator('.main-dock .shell-terminal').first()
  async function directory(path) {
    await page.evaluate(async path => {
      const { store } = window.desktopFixture
      const { sendInput } = await import('/src/services/ssh.ts')
      const tab = store.tabs.find(tab => tab.kind === 'terminal')
      await sendInput(tab.sessionId, new TextEncoder().encode(`cd -- '${path}'\n`))
    }, path)
    await page.waitForFunction(path => window.desktopFixture.store.tabs.find(tab => tab.kind === 'terminal').cwd === path, path)
  }
  async function tasks() {
    return page.evaluate(async () => (await import('/src/services/sftp/transfer-runtime.ts')).transferRuntime.tasks.map(task => ({ ...task })))
  }
  async function drop(paths, preview, screenshot) {
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', sourceScript, '-PathsJson', JSON.stringify(paths), '-TargetPid', String(pid)], { windowsHide: true })
    const closed = new Promise(resolve => helper.once('exit', resolve))
    let output = '', errors = ''
    helper.stdout.on('data', data => { output += data })
    helper.stderr.on('data', data => { errors += data })
    try {
      let source
      const deadline = Date.now() + 25000
      while (!source && Date.now() < deadline && helper.exitCode === null) {
        try { source = JSON.parse(output.trim()) } catch {}
        if (!source) await pause(100)
      }
      if (!source) throw new Error(`Explorer fixture did not become ready: ${errors}`)
      const bounds = await terminal.boundingBox()
      const scale = await page.evaluate(() => devicePixelRatio)
      const gesture = run(python, [mouseScript, '--pid', String(pid), '--source-window', String(source.window),
        '--from', String(source.x), String(source.y), '--to', String(bounds.x + 24), String(bounds.y + bounds.height / 2),
        '--scale', String(scale), '--hold-at-target', '1'], { windowsHide: true })
      const overlay = terminal.locator('.terminal-file-drop')
      await expect(overlay).toContainText(preview)
      if (screenshot) await page.screenshot({ path: join(artifacts, screenshot) })
      await gesture
      await expect(overlay).toHaveCount(0)
    } finally {
      helper.stdin.end('\n')
      await Promise.race([closed, pause(3000)])
      if (helper.exitCode === null) helper.kill()
    }
  }
  const folder = join(local, "drop-folder a'b 中文")
  const file = join(local, 'terminal-drop.txt')
  await mkdir(join(folder, 'nested', 'empty'), { recursive: true })
  await writeFile(join(folder, 'nested', 'content.txt'), 'Explorer folder upload\n')
  await writeFile(file, 'Explorer file upload\n')
  await mkdir(join(remote, 'terminal-drop'))
  await directory('/terminal-drop')
  expect(await page.evaluate(() => window.desktopFixture.store.tabs.some(tab => tab.kind === 'file'))).toBe(false)
  await drop([folder, file], ':/terminal-drop', 'desktop-file-drop-preview.png')
  await expect.poll(() => readFile(join(remote, 'terminal-drop', "drop-folder a'b 中文", 'nested', 'content.txt'), 'utf8')).toBe('Explorer folder upload\n')
  expect(await readFile(join(remote, 'terminal-drop', 'terminal-drop.txt'), 'utf8')).toBe('Explorer file upload\n')
  await access(join(remote, 'terminal-drop', "drop-folder a'b 中文", 'nested', 'empty'))
  expect(await readFile(file, 'utf8')).toBe('Explorer file upload\n')
  await expect.poll(async () => (await tasks()).every(task => task.state === 'completed')).toBe(true)

  await writeFile(join(remote, 'terminal-drop', "drop-folder a'b 中文", 'target-only.txt'), 'must be replaced')
  await writeFile(join(folder, 'nested', 'content.txt'), 'replacement folder\n')
  await drop([folder], ':/terminal-drop')
  const conflict = page.getByRole('dialog', { name: '目标已存在' })
  await expect(conflict).toContainText('永久删除')
  await conflict.getByRole('button', { name: '整目录替换', exact: true }).click()
  await expect.poll(() => readFile(join(remote, 'terminal-drop', "drop-folder a'b 中文", 'nested', 'content.txt'), 'utf8')).toBe('replacement folder\n')
  await expect.poll(async () => { try { await access(join(remote, 'terminal-drop', "drop-folder a'b 中文", 'target-only.txt')); return true } catch { return false } }).toBe(false)

  const count = (await tasks()).length
  await page.evaluate(() => { window.desktopFixture.store.tabs.find(tab => tab.kind === 'terminal').cwd = undefined })
  await drop([file], '无法获取当前终端目录', 'desktop-file-drop-unknown.png')
  expect((await tasks()).length).toBe(count)
  await directory('/missing-drop-directory')
  await drop([file], ':/missing-drop-directory')
  await expect.poll(async () => (await tasks()).some(task => task.state === 'failed')).toBe(true)
  await expect(access(join(remote, 'terminal-drop.txt'))).rejects.toThrow()
  await page.evaluate(async () => {
    const { dismissTransfer, transferRuntime } = await import('/src/services/sftp/transfer-runtime.ts')
    for (const task of [...transferRuntime.tasks]) if (task.state === 'failed') await dismissTransfer(task.id)
  })
  await directory('/')
  console.log('Desktop file drop: real Explorer files/folders, native paths, SFTP without file tabs, empty directories, conflict replacement, unknown/unavailable cwd without fallback')
}
