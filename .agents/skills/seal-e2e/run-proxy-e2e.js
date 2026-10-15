const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { confirmReload } = require('./close-protection');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '../../..');
const TEST_HOST = process.env.SEAL_E2E_HOST || '127.0.0.1';
const { chromium } = require(path.join(REPO, 'shell/node_modules/playwright'));
const PYTHON = process.env.SEAL_PYTHON || path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-proxy-e2e-'));
const artifacts = path.join(os.tmpdir(), 'seal-e2e/proxy');
const remote = path.join(fixture, 'remote');
const local = path.join(fixture, 'local');
const statePath = path.join(fixture, 'proxy.json');
const processes = [];
for (const directory of [artifacts, remote, local]) fs.mkdirSync(directory, { recursive: true });
const payload = crypto.randomBytes(512 * 1024 + 37);
fs.writeFileSync(path.join(remote, 'large.bin'), payload);
fs.writeFileSync(path.join(local, 'upload.bin'), payload);
fs.writeFileSync(path.join(remote, 'note.txt'), 'proxy editor fixture');

function start(command, args, env = {}) {
  const proc = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  processes.push(proc);
  proc.stderr.on('data', data => process.stderr.write(data));
  return proc;
}
function line(proc, expression) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 20000);
    proc.stdout.on('data', data => { output += data; const match = output.match(expression); if (match) { clearTimeout(timer); resolve(match[1]); } });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Process exited ${code}: ${output}`)); });
  });
}
async function until(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
const proxyState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

(async () => {
  let browser, page;
  const errors = [];
  try {
    const ssh = start(PYTHON, [path.join(__dirname, 'mock-ssh-server.py')], { MOCK_SFTP_ROOT: remote });
    const sshPort = Number(await line(ssh, /MOCK_SSH_PORT=(\d+)/));
    const proxies = start(PYTHON, [path.join(__dirname, 'mock-proxy-server.py')], { MOCK_PROXY_TARGET_PORT: String(sshPort), MOCK_PROXY_STATE_PATH: statePath });
    const ports = JSON.parse(await line(proxies, /MOCK_PROXY_PORTS=(.+)/));
    const node = start(PYTHON, ['-m', 'seal.main'], { SEAL_TRUST_PATH: path.join(fixture, 'trust.json'), SEAL_HOST: TEST_HOST });
    const pin = await line(node, /pairing code: (\d{6})/);
    const vite = start(process.execPath, ['shell/node_modules/vite/bin/vite.js', '--host', TEST_HOST, '--port', '8081', '--strictPort', '--config', 'shell/vite.config.ts', 'shell']);
    await line(vite, /(?:Local|Network):\s+(http:\/\/[^\s]+\/)/);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
    await page.goto(`http://${TEST_HOST}:8081`);
    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await page.getByRole('dialog', { name: '配对 Node', exact: true }).waitFor({ state: 'hidden' });

    await page.locator('.workbench-menu-trigger').click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '代理服务器', exact: true }).click();
    await settings.getByRole('button', { name: '添加代理', exact: true }).click();
    await settings.getByLabel('代理名称', { exact: true }).fill('Proxy fixture');
    await settings.getByLabel('代理地址', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('代理端口', { exact: true }).fill(String(ports.http));
    await settings.getByLabel('需要认证').check();
    await settings.getByLabel('代理用户名', { exact: true }).fill('proxy-user');
    await settings.getByLabel('代理密码', { exact: true }).fill('proxy-pass');
    await until(async () => await settings.locator('.proxy-editor [role="status"]').textContent() === '已自动保存', 'proxy autosave did not complete');
    await page.screenshot({ path: path.join(artifacts, 'settings.png') });
    const profileId = await page.evaluate(async () => (await import('/src/stores/app.ts')).store.proxies[0].id);
    await settings.getByRole('button', { name: '测试代理', exact: true }).click();
    const testDialog = page.getByRole('dialog', { name: '测试代理', exact: true });
    await testDialog.getByLabel('测试目标地址').fill('internal.proxy.test');
    await testDialog.getByLabel('测试目标端口').fill(String(sshPort));
    await testDialog.getByRole('button', { name: '开始测试', exact: true }).click();
    await testDialog.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    await testDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    assert.equal(proxyState().connections[0].host, 'internal.proxy.test');
    console.log('PASS authenticated HTTP test and proxy-side DNS');

    await page.locator('.conn-list').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建连接', exact: true }).click();
    const hostDialog = page.getByRole('dialog', { name: '新建连接', exact: true });
    await page.locator('#host-name').fill('Proxied server');
    await page.locator('#host-address').fill('internal.proxy.test');
    await page.locator('#host-port').fill(String(sshPort));
    await page.locator('#host-username').fill('root');
    await page.locator('#host-password').fill('test');
    await hostDialog.getByLabel('使用代理').check();
    await hostDialog.getByRole('tab', { name: '从列表选择' }).click();
    await hostDialog.getByLabel('代理服务器', { exact: true }).selectOption(profileId);
    await page.screenshot({ path: path.join(artifacts, 'host.png') });
    await hostDialog.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#host-key-accept').click();
    await page.locator('.terminal-tab .dot.online').waitFor({ timeout: 30000 });
    const original = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return { hostId: store.hosts[0].id, tabId: store.activeTerminalTabId };
    });
    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    await until(async () => await page.locator('[data-metric-value]').evaluateAll(items => items.length === 4 && items.every(item => !item.getAttribute('data-metric-value').includes('--'))), 'proxied telemetry did not produce metrics');
    await page.getByRole('button', { name: '性能监测 1', exact: true }).click();
    assert(proxyState().connections.filter(item => item.protocol === 'http').length >= 3);
    console.log('PASS SSH terminal and independent telemetry through HTTP');

    await page.evaluate(async ({ profileId }) => {
      const { store } = await import('/src/stores/app.ts');
      const { saveProxyProfile } = await import('/src/services/proxy/profiles.ts');
      await saveProxyProfile({ ...store.proxies.find(item => item.id === profileId), port: 1 });
    }, { profileId });
    const fileId = await page.evaluate(async ({ hostId, tabId }) => {
      const { store } = await import('/src/stores/app.ts');
      const { createFileTab } = await import('/src/services/sftp/file-tabs.ts');
      return createFileTab(store.hosts.find(item => item.id === hostId), tabId).id;
    }, original);
    await until(async () => await page.evaluate(async id => (await import('/src/stores/app.ts')).store.tabs.find(item => item.id === id)?.state === 'online', fileId), 'SFTP did not inherit the original route');
    await page.evaluate(async id => (await import('/src/services/ws.ts')).closeTab(id), original.tabId);
    const editorId = await page.evaluate(async fileId => {
      const { store } = await import('/src/stores/app.ts');
      const { openEditorTab } = await import('/src/services/sftp/editor-tabs.ts');
      const file = store.tabs.find(item => item.id === fileId);
      const editor = await openEditorTab(fileId, file.file.entries.find(item => item.name === 'note.txt'));
      return editor.id;
    }, fileId);
    await page.locator('.editor-panel .cm-content').waitFor();
    await page.evaluate(async id => {
      const { store } = await import('/src/stores/app.ts');
      const { saveEditorTab } = await import('/src/services/sftp/editor-tabs.ts');
      const editor = store.tabs.find(item => item.id === id);
      editor.editor.content = 'edited over the captured proxy route'; editor.editor.dirty = true;
      await saveEditorTab(id);
    }, editorId);
    assert.equal(fs.readFileSync(path.join(remote, 'note.txt'), 'utf8'), 'edited over the captured proxy route');
    const localId = await page.evaluate(async () => (await import('/src/services/sftp/file-tabs.ts')).createLocalFileTab().id);
    await until(async () => await page.evaluate(async id => (await import('/src/stores/app.ts')).store.tabs.find(item => item.id === id)?.state === 'online', localId), 'local file session not ready');
    await page.evaluate(async ({ localId, directory, fileId }) => {
      const { navigateFileTab } = await import('/src/services/sftp/file-tabs.ts');
      const { transferFileEntries } = await import('/src/services/files/transfers.ts');
      await navigateFileTab(localId, directory);
      await transferFileEntries(fileId, localId, ['/large.bin']);
      await transferFileEntries(localId, fileId, [directory.replaceAll('\\', '/') + '/upload.bin']);
    }, { localId, directory: local, fileId });
    assert.deepEqual(fs.readFileSync(path.join(local, 'large.bin')), payload);
    assert.deepEqual(fs.readFileSync(path.join(remote, 'upload.bin')), payload);
    const monitoringContinues = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.find(tab => tab.kind === 'monitor').monitor.telemetry.sampledAt;
    });
    await until(async () => await page.evaluate(async previous => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.find(tab => tab.kind === 'monitor').monitor.telemetry.sampledAt > previous;
    }, monitoringContinues), 'monitor stopped after proxy edits or terminal closure');
    console.log('PASS original monitor route and inherited file routes survive proxy edits and terminal closure');

    const count = proxyState().connections.length;
    const failedTab = await page.evaluate(async id => {
      const { store } = await import('/src/stores/app.ts');
      const { connectHost } = await import('/src/services/ws.ts');
      await connectHost(store.hosts.find(item => item.id === id)); return store.activeTerminalTabId;
    }, original.hostId);
    await until(async () => await page.evaluate(async id => (await import('/src/stores/app.ts')).store.tabs.find(item => item.id === id)?.state === 'error', failedTab), 'new connection did not use the updated failing proxy');
    await page.getByRole('button', { name: '编辑代理配置', exact: true }).first().waitFor();
    assert.equal(proxyState().connections.length, count);
    await page.evaluate(async id => (await import('/src/services/ws.ts')).closeTab(id), failedTab);
    console.log('PASS latest route on new connections, no direct fallback, and editing entry');

    await page.evaluate(async ({ profileId, port }) => {
      const { store } = await import('/src/stores/app.ts');
      const { saveProxyProfile } = await import('/src/services/proxy/profiles.ts');
      await saveProxyProfile({ ...store.proxies.find(item => item.id === profileId), type: 'socks5', port });
    }, { profileId, port: ports.socks5 });
    await page.evaluate(async id => {
      const { store } = await import('/src/stores/app.ts');
      await (await import('/src/services/ws.ts')).connectHost(store.hosts.find(item => item.id === id));
    }, original.hostId);
    await page.locator('.terminal-tab .dot.online').waitFor({ timeout: 30000 });
    assert(proxyState().connections.some(item => item.protocol === 'socks5' && item.authenticated && item.host === 'internal.proxy.test'));
    const beforeFork = proxyState().connections.length;
    await page.evaluate(async id => {
      const backend = (await import('/src/services/sftp/file-tabs.ts')).getFileBackend(id);
      const fork = await backend.fork(); await fork.list('/'); await fork.disconnect();
    }, fileId);
    assert(proxyState().connections.slice(beforeFork).every(item => item.protocol === 'http'));
    console.log('PASS authenticated SOCKS5 and existing HTTP file-route isolation');

    const checks = await page.evaluate(async ({ httpPort, socksPort, sshPort }) => {
      const { RoutedTransport } = await import('/src/services/transport/routed-transport.ts');
      const results = [];
      for (const type of ['http', 'socks5']) for (const mode of ['none', 'bad-password', 'denied-target']) {
        const route = new RoutedTransport();
        try {
          await route.connect(mode === 'denied-target' ? 'denied.proxy.test' : '127.0.0.1', sshPort,
            { type, host: '127.0.0.1', port: type === 'http' ? httpPort : socksPort, authentication: mode === 'bad-password' ? 'password' : 'none', username: 'proxy-user', password: 'wrong' });
          results.push({ type, mode, result: 'connected' });
        } catch (error) { results.push({ type, mode, result: error.code, stage: error.stage }); }
        finally { await route.close(); }
      }
      return results;
    }, { httpPort: ports.http, socksPort: ports.socks5, sshPort });
    for (const result of checks) {
      if (result.mode === 'none') assert.equal(result.result, 'connected');
      else { assert.equal(result.result, 'PROXY_ERROR'); assert.equal(result.stage, result.mode === 'bad-password' ? 'authenticate' : 'target'); }
    }
    assert.equal(proxyState().authentication_failures, 2);
    assert.equal(proxyState().target_failures, 2);
    console.log('PASS both protocols without authentication, rejected credentials, and denied targets');

    await page.locator('.conn-list').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建连接', exact: true }).click();
    await page.locator('#host-name').fill('Inline proxy server');
    await page.locator('#host-address').fill('internal.proxy.test');
    await page.locator('#host-port').fill(String(sshPort));
    await page.locator('#host-password').fill('test');
    await hostDialog.getByLabel('使用代理').check();
    await hostDialog.getByLabel('代理地址', { exact: true }).fill('127.0.0.1');
    await hostDialog.getByLabel('代理端口', { exact: true }).fill(String(ports.http));
    await hostDialog.getByLabel('需要认证').check();
    await hostDialog.getByLabel('代理用户名', { exact: true }).fill('proxy-user');
    await hostDialog.getByLabel('代理密码', { exact: true }).fill('proxy-pass');
    await page.screenshot({ path: path.join(artifacts, 'host-inline.png') });
    await hostDialog.getByRole('button', { name: '登录', exact: true }).click();
    await until(async () => await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.find(item => item.id === store.activeTerminalTabId)?.state === 'online';
    }), 'inline authenticated proxy connection failed');
    const inlineId = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      const { loadCredentialRecord, saveCredentialRecord } = await import('/src/services/vault.ts');
      const host = store.hosts.find(item => item.name === 'Inline proxy server');
      const credential = await loadCredentialRecord(host.id);
      if (credential.password !== 'test' || credential.inlineProxyPassword !== 'proxy-pass') throw new Error('new host did not retain both credentials');
      await saveCredentialRecord(host.id, { ...credential, inlineProxyPassword: 'wrong' });
      await (await import('/src/services/ws.ts')).connectHost(host);
      return { hostId: host.id, tabId: store.activeTerminalTabId };
    });
    await until(async () => await page.evaluate(async id => (await import('/src/stores/app.ts')).store.tabs.find(item => item.id === id)?.state === 'error', inlineId.tabId), 'inline proxy rejection was not reported');
    assert.equal(await page.evaluate(async () => (await import('/src/stores/app.ts')).store.loginDialogOpen), false);
    await page.locator('.shell-terminal:visible').getByRole('button', { name: '编辑代理配置', exact: true }).click();
    const editHost = page.getByRole('dialog', { name: '编辑主机', exact: true });
    await editHost.waitFor();
    assert.equal(await editHost.locator('#host-name').inputValue(), 'Inline proxy server');
    await editHost.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(async ({ hostId, tabId }) => {
      const { loadCredentialRecord, saveCredentialRecord } = await import('/src/services/vault.ts');
      await saveCredentialRecord(hostId, { ...await loadCredentialRecord(hostId), inlineProxyPassword: 'proxy-pass' });
      (await import('/src/services/ws.ts')).closeTab(tabId);
    }, inlineId);
    console.log('PASS inline encrypted credentials and proxy-authentication editing without SSH login prompts');

    await confirmReload(page);
    await until(async () => await page.evaluate(async () => (await import('/src/stores/app.ts')).store.nodeConnected), 'Node automatic authentication after reload failed');
    assert.equal(await page.locator('.terminal-tab').count(), 0);
    await page.evaluate(async id => {
      const { store } = await import('/src/stores/app.ts');
      await (await import('/src/services/ws.ts')).connectHost(store.hosts.find(item => item.id === id));
    }, original.hostId);
    await page.locator('.terminal-tab .dot.online').waitFor({ timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log('PASS encrypted proxy/SSH credentials and shared reference survive refresh');
    console.log('proxy E2E passed');
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(-4500));
    }
    console.error(error); process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const proc of processes.reverse()) if (proc.pid && proc.exitCode === null) proc.kill('SIGTERM');
    await Promise.all(processes.filter(proc => proc.pid).map(proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve))));
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith('seal-proxy-e2e-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})();
