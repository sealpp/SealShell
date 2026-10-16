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
    const ssh = start(PYTHON, ['.agents/skills/seal-e2e/mock-ssh-server.py'], { MOCK_SSH_FORWARDING: '1', MOCK_SSH_STATE_PATH: path.join(fixture, 'state.json') });
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
    assert.deepEqual(errors, []);
    console.log('PASS real WASM direct-tcpip, parallel multi-block transfers, half-close, occupied port fallback and cleanup');
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
