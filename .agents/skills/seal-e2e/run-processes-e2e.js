const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert/strict');
const REPO = path.resolve(__dirname, '../../..');
const { chromium } = require(path.join(REPO, 'shell/node_modules/playwright'));
const HOST = process.env.SEAL_E2E_HOST || '127.0.0.1';
const DOCKER_HOST = process.env.SEAL_PROCESS_DOCKER_HOST;
if (!DOCKER_HOST) throw new Error('Set SEAL_PROCESS_DOCKER_HOST to an authorized SSH host with Docker.');
const image = process.env.SEAL_PROCESS_DOCKER_IMAGE || 'mcr.microsoft.com/playwright:v1.62.0-noble';
const container = 'seal-process-e2e-' + crypto.randomBytes(5).toString('hex');
const password = crypto.randomBytes(18).toString('hex');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-process-e2e-'));
const artifacts = path.join(os.tmpdir(), 'seal-e2e/processes');
fs.mkdirSync(artifacts, { recursive: true });
const processes = [];
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function remote(args, input) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', DOCKER_HOST, args.map(quote).join(' ')],
    { input, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
function start(command, args, env = {}) {
  const proc = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  processes.push(proc);
  proc.stderr.on('data', data => process.stderr.write(data));
  return proc;
}
function line(proc, expression) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Service startup timed out')), 20000);
    proc.stdout.on('data', chunk => { output += chunk; const found = output.match(expression); if (found) { clearTimeout(timeout); resolve(found[1]); } });
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error('Service exited: ' + code)); });
  });
}
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
const processFixture = `
import ctypes, os, signal, subprocess, sys, time
role = sys.argv[1]
ctypes.CDLL(None).prctl(15, role.encode(), 0, 0, 0)
with open('/tmp/' + role + '.pid', 'w') as file: file.write(str(os.getpid()))
if role == 'seal-root':
    subprocess.Popen([sys.executable, __file__, 'seal-child'])
elif role == 'seal-child':
    subprocess.Popen([sys.executable, __file__, 'seal-leaf'])
elif role == 'seal-stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True: time.sleep(1)
`;

(async () => {
  let browser, page;
  const errors = [];
  try {
    console.log('Preparing a disposable Linux SSH fixture');
    remote(['docker', 'run', '--init', '-d', '--name', container, '-p', '127.0.0.1::22', image, 'sleep', 'infinity']);
    remote(['docker', 'exec', container, 'sh', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server procps python3 >/tmp/install.log 2>&1']);
    remote(['docker', 'exec', '-i', container, 'sh', '-c', 'useradd -m -s /bin/bash sealproc && chpasswd && mkdir -p /run/sshd && /usr/sbin/sshd'], 'sealproc:' + password + '\n');
    remote(['docker', 'exec', '-i', container, 'sh', '-c', 'cat > /tmp/process-fixture.py'], processFixture);
    const literalArgs = ['argument with spaces', 'line\nnext', 'literal %00', ''];
    for (const role of ['seal-root', 'seal-stubborn', 'seal-denied']) remote(['docker', 'exec', '-d', '-u', role === 'seal-denied' ? 'root' : 'sealproc', container, 'python3', '/tmp/process-fixture.py', role, ...literalArgs]);
    const mappedPort = Number(remote(['docker', 'port', container, '22/tcp']).trim().split(':').pop());
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const localPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    start('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:' + localPort + ':127.0.0.1:' + mappedPort, DOCKER_HOST]);
    await until(() => new Promise(resolve => { const socket = net.connect(localPort, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }), 'SSH tunnel failed');
    const python = process.env.SEAL_PYTHON || path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const node = start(python, ['-m', 'seal.main'], { SEAL_TRUST_PATH: path.join(fixture, 'trust.json'), SEAL_HOST: HOST });
    const pin = await line(node, /pairing code: (\d{6})/);
    const vite = start(process.execPath, ['shell/node_modules/vite/bin/vite.js', '--force', '--host', HOST, '--port', '8081', '--strictPort', '--config', 'shell/vite.config.ts', 'shell']);
    await line(vite, /(?:Local|Network):\s+(http:\/\/[^\s]+\/)/);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://' + HOST + ':8081');
    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await until(() => page.evaluate(async () => (await import('/src/stores/app.ts')).store.nodeConnected), 'Node authentication failed');
    await page.evaluate(async ({ port, password }) => {
      const { store } = await import('/src/stores/app.ts');
      store.hosts.push({ id:'process-fixture', name:'Linux 进程测试', address:'127.0.0.1', port, username:'sealproc', folderId:null });
      await (await import('/src/services/vault.ts')).saveCredentialRecord('process-fixture', {password});
    }, { port: localPort, password });
    await page.locator('.conn-item').filter({ hasText: 'Linux 进程测试' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开进程管理', exact: true }).click();
    await page.locator('#host-key-accept').click();
    await until(() => page.evaluate(async () => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process')?.processes.rows.some(row => row.name === 'seal-root')), 'Real Linux collection failed');
    const collectedArgs = await page.evaluate(async () => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.rows.find(row => row.name === 'seal-root').argv);
    assert.deepEqual(collectedArgs.slice(3), literalArgs);
    console.log('PASS real /proc collection preserves spaces, newlines, percent escapes and empty arguments');
    async function choose(name) {
      await page.getByRole('searchbox', { name: '搜索进程' }).fill(name);
      await page.locator('.process-row').filter({ hasText: name }).first().click();
    }
    async function act(name) {
      await page.getByRole('button', { name: /结束操作/ }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      await page.getByRole('button', { name: '确认' + name, exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await choose('seal-denied');
    await act('结束进程');
    assert.match(await page.locator('.process-results').innerText(), /权限不足/);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    console.log('PASS real non-root permission failure preserves the process connection');
    await choose('seal-stubborn');
    await act('结束进程');
    await until(() => page.evaluate(async () => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.rows.some(r => r.name === 'seal-stubborn' && r.state !== 'Z')), 'TERM unexpectedly killed the resistant fixture');
    await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      const runtime = await import('/src/services/processes/runtime.ts');
      const tab = store.tabs.find(t => t.kind === 'process');
      const row = tab.processes.rows.find(row => row.name === 'seal-stubborn');
      const plan = await runtime.prepareProcessAction(tab.id, [row.key], 'KILL', 'selected');
      plan.targets[0].startTicks += 1;
      await runtime.executeProcessAction(tab.id, plan);
      if (tab.processes.outcomes[0].status !== 'changed') throw new Error('Stale identity was not rejected');
    });
    console.log('PASS signal checks process start identity on the real Linux server');
    await choose('seal-stubborn');
    await act('强制结束进程');
    await until(() => page.evaluate(async () => !(await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.rows.some(r => r.name === 'seal-stubborn' && r.state !== 'Z')), 'KILL did not end the resistant fixture');
    await choose('seal-root');
    await page.getByRole('button', { name: /结束操作/ }).click();
    await page.getByRole('menuitem', { name: '结束进程树', exact: true }).click();
    await page.getByRole('dialog', { name: '结束进程树', exact: true }).waitFor();
    assert.equal(await page.locator('.process-confirm-list>div').count(), 3);
    await page.getByRole('button', { name: '确认结束进程树', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await until(() => page.evaluate(async () => !(await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.rows.some(r => ['seal-root','seal-child','seal-leaf'].includes(r.name) && r.state !== 'Z')), 'Process tree did not terminate');
    console.log('PASS TERM/KILL and descendant-first tree operations through PWA/WASM and Node');
    await page.getByRole('searchbox', { name: '搜索进程' }).fill('');
    await page.screenshot({ path: path.join(artifacts, 'processes.png') });
    const before = await page.evaluate(async () => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.sampledAt);
    await page.getByRole('button', { name: '进程管理 1', exact: true }).click();
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(async () => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.sampledAt), before);
    await page.getByRole('button', { name: '进程管理 1', exact: true }).click();
    await until(() => page.evaluate(async previous => (await import('/src/stores/app.ts')).store.tabs.find(t => t.kind === 'process').processes.sampledAt > previous, before), 'Reveal did not refresh');
    await page.locator('.workspace-category-view.active .workspace-instance-close').click();
    await until(() => /sealproc:/.test(remote(['docker','exec',container,'ps','-eo','args='])) === false, 'SSH session was not released');
    assert.deepEqual(errors, []);
    console.log('PASS hidden polling, immediate reveal and SSH cleanup');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const proc of processes.reverse()) if (proc.exitCode === null) proc.kill('SIGTERM');
    await Promise.all(processes.map(proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve))));
    try { remote(['docker', 'rm', '-f', container]); } catch {}
    fs.rmSync(fixture, { recursive: true, force: true });
    console.log('Cleaned up process fixture and local services');
  }
})();
