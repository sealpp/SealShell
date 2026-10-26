const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert/strict');
const REPO = path.resolve(__dirname, '../../..');
const TEST_HOST = process.env.SEAL_E2E_HOST || '127.0.0.1';
const { chromium } = require(path.join(REPO, 'shell/node_modules/playwright'));
const PYTHON = process.env.SEAL_PYTHON || path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const processes = [];
const sockets = new Set();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ports-e2e-'));
const artifacts = path.join(os.tmpdir(), 'seal-e2e/ports');
fs.mkdirSync(artifacts, { recursive: true });
function start(command, args, env = {}) {
  const proc = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(proc);
  proc.stderr.on('data', data => process.stderr.write(data));
  return proc;
}
function line(proc, expression) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 15000);
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
function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    sockets.add(socket);
    const chunks = [];
    socket.setTimeout(20000, () => socket.destroy(new Error('TCP transfer timed out')));
    socket.on('error', reject);
    socket.on('data', data => chunks.push(data));
    socket.on('connect', () => socket.end(payload));
    socket.on('end', () => { try { assert.deepEqual(Buffer.concat(chunks), payload); resolve(); } catch (error) { reject(error); } });
    socket.on('close', () => sockets.delete(socket));
  });
}
(async () => {
  let browser;
  let page;
  const errors = [];
  const echo = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    // Reply after FIN to exercise half-close in both native and SSH streams.
    const chunks = [];
    socket.on('data', data => chunks.push(data));
    socket.on('end', () => socket.end(Buffer.concat(chunks)));
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
    const remotePort = echo.address().port;
    const control = path.join(fixture, 'ports.json');
    fs.writeFileSync(control, JSON.stringify([remotePort, 3000]));
    const ssh = start(PYTHON, ['.agents/skills/seal-e2e/mock-ssh-server.py'], { MOCK_SSH_FORWARDING: '1', MOCK_PORTS_CONTROL_PATH: control, MOCK_SSH_STATE_PATH: path.join(fixture, 'state.json') });
    const sshPort = Number(await line(ssh, /MOCK_SSH_PORT=(\d+)/));
    const node = start(PYTHON, ['-m', 'seal.main'], { SEAL_TRUST_PATH: path.join(fixture, 'trust.json'), SEAL_HOST: TEST_HOST });
    const pin = await line(node, /pairing code: (\d{6})/);
    const vite = start(process.execPath, ['shell/node_modules/vite/bin/vite.js', '--force', '--host', TEST_HOST, '--port', '8081', '--strictPort', '--config', 'shell/vite.config.ts', 'shell']);
    await line(vite, /(?:Local|Network):\s+(http:\/\/[^\s]+\/)/);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
    await page.goto(`http://${TEST_HOST}:8081`);
    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await page.locator('.conn-list').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建连接', exact: true }).click();
    await page.locator('#host-name').fill('ports-host');
    await page.locator('#host-address').fill('127.0.0.1');
    await page.getByPlaceholder('port').fill(String(sshPort));
    await page.getByPlaceholder('username').fill('root');
    await page.locator('input[type="password"]').fill('test');
    await page.locator('.workbench-dialog-content').getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#host-key-accept').click();
    await page.locator('.xterm-screen').waitFor();
    // A second client injects identity and endpoint; the SDK itself has no
    // application imports and can use networking and files on one connection.
    await page.evaluate(async ({ remotePort, endpoint }) => {
      const { readIdentity } = await import('/src/services/storage.ts');
      const identity = await readIdentity();
      const { NativeConnection } = await import('/src/native/connection.ts');
      const { NativeNetwork } = await import('/src/native/network.ts');
      const { NativeFileSystem } = await import('/src/native/filesystem.ts');
      const connection = new NativeConnection({ endpoint, identity: async () => identity });
      const network = new NativeNetwork(connection);
      try {
        await connection.connect();
        const files = new NativeFileSystem(connection);
        const info = await files.request({ case: 'info', value: {} });
        if (info.case !== 'info') throw new Error('Independent native file client failed');
        const socket = await network.open('tcp', '127.0.0.1', remotePort);
        await socket.write(new TextEncoder().encode('independent PWA'));
        await socket.end();
        let output = '';
        for (;;) { const data = await socket.read(); if (!data) break; output += new TextDecoder().decode(data); }
        if (output !== 'independent PWA') throw new Error('Independent native TCP client failed');
      } finally { await connection.close(); }
    }, { remotePort, endpoint: `ws://${TEST_HOST}:17373` });
    console.log('PASS injected-identity SDK client uses TCP and filesystem without application adapters');
    const localPort = await page.evaluate(async ({ sshPort, remotePort }) => {
      const { PortForwarder } = await import('/src/services/ports/forwarder.ts');
      window.forwardErrors = [];
      window.forwarder = new PortForwarder(error => { if (error) window.forwardErrors.push(error.message); });
      return window.forwarder.start({ host: '127.0.0.1', port: sshPort, username: 'root', password: 'test' }, { host: '127.0.0.1', port: remotePort, localPort: remotePort }, '127.0.0.1');
    }, { sshPort, remotePort });
    assert.notEqual(localPort, remotePort, 'occupied local port should fall back');
    await Promise.all(Array.from({ length: 3 }, () => roundTrip(localPort, crypto.randomBytes(1024 * 1024 + 123))));
    assert.deepEqual(await page.evaluate(() => window.forwardErrors), []);
    await page.evaluate(() => window.forwarder.close());
    await until(() => JSON.parse(fs.readFileSync(path.join(fixture, 'state.json'))).active_connections === 1, 'forwarding SSH connection leaked');
    console.log('PASS real WASM direct-tcpip, parallel multi-block transfers, half-close, occupied port fallback and cleanup');

    await page.locator('.xterm-screen').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click();
    const panel = page.locator('.ports-panel:visible');
    const row = panel.locator(`[data-port-id="localhost:${remotePort}"]`);
    await row.waitFor();
    assert.equal(await row.getByRole('checkbox').isChecked(), false);
    assert.equal(await row.getAttribute('data-status'), 'disabled');
    const ids = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return { hostId: store.hosts[0].id, tabId: store.tabs.find(tab => tab.kind === 'port').id };
    });
    await page.getByRole('button', { name: '打开或定位当前终端的端口转发', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '端口转发 1', exact: true }).count(), 1);
    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click();
    assert.equal(await panel.count(), 1);
    await row.getByRole('checkbox').check();
    await until(async () => await row.getAttribute('data-status') === 'active', 'checkbox forwarding failed');
    const portInput = row.getByRole('textbox');
    let actualPort = Number(await portInput.inputValue());
    assert.notEqual(actualPort, remotePort);
    await roundTrip(actualPort, crypto.randomBytes(300000));
    console.log('PASS discovery defaults unchecked, menu/current-terminal deduplication and checkbox forwarding');

    fs.writeFileSync(control, '[]');
    await page.getByRole('button', { name: '端口转发 1', exact: true }).click();
    await until(async () => await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.find(tab => tab.kind === 'port').ports.rows.every(row => !row.listening);
    }), 'hidden discovery did not refresh');
    await roundTrip(actualPort, Buffer.from('hidden forwarding survives disappearance'));
    await page.getByRole('button', { name: '端口转发 1', exact: true }).click();
    assert.equal(await panel.locator('tbody tr').count(), 1, 'unconfigured discovery should disappear');
    assert.match(await row.innerText(), /未发现监听/);
    await portInput.fill('65536'); await portInput.press('Enter');
    assert.equal(Number(await portInput.inputValue()), actualPort);
    await portInput.fill('12345'); await portInput.press('Escape');
    assert.equal(Number(await portInput.inputValue()), actualPort);
    await portInput.fill(String(remotePort)); await panel.locator('.ports-host').click();
    await until(async () => await row.getAttribute('data-status') === 'active', 'blur edit did not restart forwarding');
    actualPort = Number(await portInput.inputValue());
    assert.notEqual(actualPort, remotePort);
    await roundTrip(actualPort, Buffer.from('after blur commit'));
    await panel.getByRole('button', { name: '端口转发设置', exact: true }).click();
    await page.getByRole('switch', { name: '允许其他设备访问', exact: true }).check();
    await until(async () => await page.evaluate(async () => {
      const { readPortBindHost } = await import('/src/services/storage.ts'); return await readPortBindHost() === '0.0.0.0';
    }), 'global listening address was not saved');
    await page.keyboard.press('Escape');
    await until(async () => await row.getAttribute('data-status') === 'active', 'listening scope did not rebind');
    actualPort = Number(await portInput.inputValue());
    await roundTrip(actualPort, Buffer.from('all interfaces binding'));
    await panel.getByRole('button', { name: '端口转发设置', exact: true }).click();
    await page.getByRole('switch', { name: '允许其他设备访问', exact: true }).uncheck();
    await until(async () => await page.evaluate(async () => {
      const { readPortBindHost } = await import('/src/services/storage.ts'); return await readPortBindHost() === '127.0.0.1';
    }), 'loopback listening address was not restored');
    await page.keyboard.press('Escape');
    await until(async () => await row.getAttribute('data-status') === 'active', 'loopback rebind failed');
    actualPort = Number(await portInput.inputValue());
    await panel.getByRole('button', { name: '添加端口转发', exact: true }).first().click();
    await panel.getByRole('textbox', { name: '新的转发目标' }).fill('10.0.0.8:5432');
    await panel.getByRole('button', { name: '转发端口', exact: true }).click();
    const manual = panel.locator('[data-port-id="10.0.0.8:5432"]');
    await until(async () => await manual.getAttribute('data-status') === 'active', 'manual rule did not enable');
    assert.equal(await manual.getByRole('checkbox').isChecked(), true);
    await manual.getByRole('checkbox').uncheck();
    await until(async () => await manual.getAttribute('data-status') === 'disabled', 'uncheck did not stop');
    await page.screenshot({ path: path.join(artifacts, 'ports-panel.png'), fullPage: true });
    console.log('PASS hidden discovery, retained user forwarding, inline validation/blur/Escape and manual immediate enable');

    const held = net.connect({ host: '127.0.0.1', port: actualPort });
    sockets.add(held); held.on('error', () => {});
    await new Promise(resolve => held.once('connect', resolve));
    held.write('active client');
    let heldClosed = false; held.once('close', () => { heldClosed = true; sockets.delete(held); });
    await row.getByRole('checkbox').uncheck();
    await until(() => heldClosed, 'unchecking must end existing clients');
    await row.getByRole('checkbox').check();
    await until(async () => await row.getAttribute('data-status') === 'active', 're-enable failed');
    await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      const { closeTabs } = await import('/src/services/ws.ts');
      await closeTabs(store.tabs.filter(tab => tab.kind === 'terminal').map(tab => tab.id), true);
    });
    actualPort = Number(await portInput.inputValue());
    await roundTrip(actualPort, Buffer.from('terminal independent'));
    await page.evaluate(async id => {
      const { closeTabs } = await import('/src/services/ws.ts');
      await closeTabs([id], true);
    }, ids.tabId);
    await until(() => JSON.parse(fs.readFileSync(path.join(fixture, 'state.json'))).active_connections === 0, 'panel close leaked SSH connections');
    await page.evaluate(async hostId => { const { openPorts } = await import('/src/services/ports/runtime.ts'); openPorts(hostId); }, ids.hostId);
    await until(async () => await row.getAttribute('data-status') === 'active', 'checked rule was not restored');
    assert.equal(await manual.getByRole('checkbox').isChecked(), false);
    actualPort = Number(await portInput.inputValue());
    await roundTrip(actualPort, Buffer.from('restored forwarding'));
    console.log('PASS uncheck closes clients, independent terminal lifetime and persisted checked/unchecked rules');

    await page.evaluate(async ({ hostId, sshPort }) => {
      const { store } = await import('/src/stores/app.ts');
      const { saveHost } = await import('/src/services/storage.ts');
      const host = store.hosts.find(host => host.id === hostId);
      host.port = 1;
      await saveHost(JSON.parse(JSON.stringify(host)));
      const { openPorts } = await import('/src/services/ports/runtime.ts');
      openPorts(hostId);
    }, { hostId: ids.hostId, sshPort });
    await roundTrip(actualPort, Buffer.from('snapshot unchanged after edit'));
    await page.evaluate(async hostId => {
      const { store } = await import('/src/stores/app.ts');
      const { closeTabs } = await import('/src/services/ws.ts');
      await closeTabs(store.tabs.filter(tab => tab.kind === 'port').map(tab => tab.id), true);
      const { openPorts } = await import('/src/services/ports/runtime.ts'); openPorts(hostId);
    }, ids.hostId);
    await until(async () => await row.getAttribute('data-status') === 'failed', 'restored failure was not shown');
    assert.equal(await row.getByRole('checkbox').isChecked(), true);
    assert.equal(await manual.getAttribute('data-status'), 'disabled');
    assert.equal(await page.locator('.workbench-dialog-content:visible').count(), 0, 'failure must not open an error dialog');
    await page.screenshot({ path: path.join(artifacts, 'ports-failure.png'), fullPage: true });
    await page.reload();
    await until(async () => await page.evaluate(async () => { const { store } = await import('/src/stores/app.ts'); return store.nodeConnected; }), 'Node did not reauthenticate');
    assert.equal(await page.locator('.ports-panel').count(), 0, 'refresh should not restore panels');
    await page.evaluate(async ({ hostId, sshPort }) => {
      const { store } = await import('/src/stores/app.ts');
      const { saveHost } = await import('/src/services/storage.ts');
      const host = store.hosts.find(host => host.id === hostId); host.port = sshPort; await saveHost(JSON.parse(JSON.stringify(host)));
      const { openPorts } = await import('/src/services/ports/runtime.ts'); openPorts(hostId);
    }, { hostId: ids.hostId, sshPort });
    await until(async () => await row.getAttribute('data-status') === 'active', 'saved rule after refresh did not restore');
    actualPort = Number(await portInput.inputValue());
    await page.evaluate(async hostId => {
      const { store } = await import('/src/stores/app.ts'); const { deleteHost } = await import('/src/services/storage.ts');
      await deleteHost(hostId); store.hosts = [];
    }, ids.hostId);
    await roundTrip(actualPort, Buffer.from('snapshot survives deletion'));
    await row.getByRole('checkbox').uncheck();
    await until(async () => await row.getAttribute('data-status') === 'disabled', 'delete-preserved rule cannot disable');
    assert.deepEqual(await page.evaluate(async hostId => { const { readPortRules } = await import('/src/services/storage.ts'); return readPortRules(hostId); }, ids.hostId), []);
    assert.deepEqual(errors, []);
    console.log('PASS snapshot edits/deletion, failure red state without dialogs, refresh closes panels and retains rules');
  } catch (error) {
    if (page) console.error('Forwarding state:', await page.evaluate(() => window.forwardErrors).catch(() => []));
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => echo.close(resolve));
    for (const proc of processes.reverse()) {
      if (proc.exitCode !== null || proc.signalCode !== null) continue;
      const exited = new Promise(resolve => proc.once('exit', resolve));
      proc.kill();
      await exited;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
