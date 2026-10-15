const { spawn } = require('child_process');
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '../../..');
const { chromium } = require(path.join(REPO, 'shell/node_modules/playwright'));
const TEST_HOST = process.env.SEAL_E2E_HOST || '127.0.0.1';
const SSH_HOST = process.env.SEAL_E2E_SSH_HOST;
const SSH_PORT = process.env.SEAL_E2E_SSH_PORT || '22';
const SSH_USER = process.env.SEAL_E2E_SSH_USER;
const SSH_PASSWORD = process.env.SEAL_E2E_SSH_PASSWORD;
const PYTHON = process.env.SEAL_PYTHON || path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;

function start(command, args, env, processes) {
  const proc = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(proc);
  proc.stderr.on('data', data => process.stderr.write(data));
  return proc;
}

function line(proc, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 20000);
    proc.stdout.on('data', data => {
      output += data;
      const match = output.match(pattern);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Process exited ${code}: ${output}`)); });
  });
}

async function main() {
  assert(SSH_HOST && SSH_USER && SSH_PASSWORD, 'Set SEAL_E2E_SSH_HOST, SEAL_E2E_SSH_USER and SEAL_E2E_SSH_PASSWORD for an isolated SSH fixture');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ssh-directory-'));
  const remoteRoot = `/tmp/sealshell-directory-${crypto.randomBytes(8).toString('hex')}`;
  const sourceDirectory = `${remoteRoot}/中文 path/a'b;$(touch sentinel) #%=back`;
  const processes = [];
  let browser, page;
  try {
    const node = start(PYTHON, ['-m', 'seal.main'], { SEAL_TRUST_PATH: path.join(fixture, 'trust.json'), SEAL_HOST: TEST_HOST }, processes);
    const pin = await line(node, /pairing code: (\d{6})/);
    const vite = start(process.execPath, ['shell/node_modules/vite/bin/vite.js', '--host', TEST_HOST, '--port', '8081', '--strictPort', '--config', 'shell/vite.config.ts', 'shell'], {}, processes);
    await line(vite, /(?:Local|Network):\s+(http:\/\/[^\s]+\/)/);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://${TEST_HOST}:8081`);
    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await page.getByRole('dialog', { name: '配对 Node', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.conn-list').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建连接', exact: true }).click();
    await page.locator('#host-name').fill('directory-e2e');
    await page.locator('#host-address').fill(SSH_HOST);
    await page.getByPlaceholder('port').fill(SSH_PORT);
    await page.getByPlaceholder('username').fill(SSH_USER);
    await page.locator('input[type="password"]').fill(SSH_PASSWORD);
    await page.locator('.workbench-dialog-content').getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#host-key-accept').click();
    await page.evaluate(async () => { window.directoryStore = (await import('/src/stores/app.ts')).store; });
    await page.waitForFunction(() => window.directoryStore.tabs[0]?.state === 'online' && !!window.directoryStore.tabs[0]?.cwd);
    const { sourceId, loginDirectory } = await page.evaluate(() => ({ sourceId: window.directoryStore.tabs[0].id, loginDirectory: window.directoryStore.tabs[0].cwd }));

    async function send(id, command) {
      await page.evaluate(async ({ id, command }) => {
        const { sendTerminalInput } = await import('/src/services/ws.ts');
        const tab = window.directoryStore.tabs.find(tab => tab.id === id);
        sendTerminalInput(tab.sessionId, new TextEncoder().encode(`${command}\r`));
      }, { id, command });
    }
    async function waitDirectory(id, directory) {
      await page.waitForFunction(({ id, directory }) => window.directoryStore.tabs.find(tab => tab.id === id)?.cwd === directory, { id, directory });
    }
    async function actualDirectory(id, directory) {
      // The echoed command contains no expected path. Only pwd's real output
      // can satisfy this check; copying the frontend cwd field cannot pass it.
      const marker = `PWD_${crypto.randomBytes(4).toString('hex')}`;
      await send(id, `printf '\\n${marker}:%s:END\\n' "$(builtin pwd -P)"`);
      await page.waitForFunction(text => Array.from(document.querySelectorAll('.xterm-rows')).some(rows => rows.textContent.includes(text)), `${marker}:${directory}:END`);
    }
    await send(sourceId, `mkdir -p -- ${quote(sourceDirectory)}; cd -- ${quote(sourceDirectory)}`);
    await waitDirectory(sourceId, sourceDirectory);
    await actualDirectory(sourceId, sourceDirectory);
    async function duplicate(trigger, expectedDirectory) {
      await trigger();
      await page.waitForFunction(({ sourceId, expectedDirectory }) => {
        const store = window.directoryStore;
        const tab = store.tabs.find(tab => tab.id === store.activeTerminalTabId);
        return tab?.id !== sourceId && tab?.state === 'online' && tab.cwd === expectedDirectory;
      }, { sourceId, expectedDirectory });
      const id = await page.evaluate(() => window.directoryStore.activeTerminalTabId);
      await actualDirectory(id, expectedDirectory);
      await page.locator('.terminal-tab-close').nth(1).click();
      await page.locator('.terminal-tab').nth(1).waitFor({ state: 'detached' });
    }
    await duplicate(() => page.locator('.terminal-tab-label').first().dblclick(), sourceDirectory);
    console.log('PASS double-click: new shell pwd matches the source directory');
    await duplicate(async () => {
      await page.locator('.xterm-screen:visible').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^新建终端/ }).click();
    }, sourceDirectory);
    await duplicate(async () => {
      await page.locator('.xterm-screen:visible').click();
      await page.keyboard.press('Control+Backquote');
    }, sourceDirectory);
    console.log('PASS context menu and keyboard: literal Unicode and shell metacharacters survive');

    for (const savedPassword of [undefined, 'wrong-password']) {
      await send(sourceId, `cd -- ${quote(sourceDirectory)}`);
      await waitDirectory(sourceId, sourceDirectory);
      await page.evaluate(async password => {
        const { saveCredentialRecord } = await import('/src/services/vault.ts');
        await saveCredentialRecord(window.directoryStore.hosts[0].id, { password });
      }, savedPassword);
      await duplicate(async () => {
        await page.locator('.terminal-tab-label').first().dblclick();
        const login = page.getByRole('dialog', { name: '登录到 directory-e2e', exact: true });
        await login.waitFor();
        await send(sourceId, `cd -- ${quote(loginDirectory)}`);
        await waitDirectory(sourceId, loginDirectory);
        await page.locator('#login-password').fill(SSH_PASSWORD);
        await login.getByRole('button', { name: '登录', exact: true }).click();
      }, sourceDirectory);
    }
    console.log('PASS missing credentials and authentication retry preserve the original directory snapshot');
    await page.evaluate(async password => {
      const { saveCredentialRecord } = await import('/src/services/vault.ts');
      const store = window.directoryStore;
      await saveCredentialRecord(store.hosts[0].id, { password });
      store.tabs.find(tab => tab.id === store.activeTerminalTabId).cwd = undefined;
    }, SSH_PASSWORD);
    await duplicate(() => page.locator('.terminal-tab-label').first().dblclick(), loginDirectory);
    console.log('PASS unknown directory keeps the normal login directory');
    const cleanupMarker = `CLEAN_${crypto.randomBytes(4).toString('hex')}`;
    await send(sourceId, `command rm -r -- ${quote(remoteRoot)} && printf '${cleanupMarker}:%s\\n' done`);
    await page.waitForFunction(text => document.querySelector('.xterm-rows')?.textContent.includes(text), `${cleanupMarker}:done`);
    await page.locator('.terminal-tab-close').first().click();
    await page.locator('.terminal-tab').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('PASS real SSH directory inheritance; fixture removed and sessions closed');
  } catch (error) {
    console.error('Terminal state:', await page?.evaluate(() => ({
      tabs: window.directoryStore?.tabs.map(({ state, cwd, error }) => ({ state, cwd, error })),
      screen: Array.from(document.querySelectorAll('.xterm-rows')).map(rows => rows.textContent),
    })).catch(() => undefined));
    throw error;
  } finally {
    await browser?.close();
    for (const proc of processes) if (proc.exitCode === null) proc.kill();
    await Promise.all(processes.map(proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve))));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
