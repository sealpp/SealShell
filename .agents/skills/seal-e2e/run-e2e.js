const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO = path.resolve(__dirname, '../../..');
const SHELL_NODE_MODULES = path.join(REPO, 'shell/node_modules');
if (fs.existsSync(SHELL_NODE_MODULES)) {
  module.paths.unshift(SHELL_NODE_MODULES);
}

const { chromium } = require('playwright');

const PYTHON = process.env.SEAL_PYTHON || path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const MOCK_SSH_SCRIPT = path.join(__dirname, 'mock-ssh-server.py');
const TMP_DIR = path.join(os.tmpdir(), 'seal-e2e');
const MOCK_SSH_STATE_PATH = path.join(TMP_DIR, 'mock-ssh-state.json');
const PWA_URL = process.env.PWA_URL || 'http://127.0.0.1:8081';

function waitForLine(proc, regex) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    const timer = setTimeout(() => reject(new Error(`${proc.spawnfile} startup timed out`)), 15000);
    const onLine = (line) => {
      process.stdout.write(`[${proc.spawnfile}] ${line}\n`);
      const match = line.match(regex);
      if (match) {
        clearTimeout(timer);
        rl.off('line', onLine);
        resolve(match[1]);
      }
    };
    rl.on('line', onLine);
    proc.stderr.on('data', (data) => process.stderr.write(`[${proc.spawnfile} stderr] ${data}`));
    proc.once('error', (error) => { clearTimeout(timer); reject(error); });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${proc.spawnfile} exited with ${code}`)); });
  });
}

function startProcess(command, args, env = {}) {
  return spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readMockSshState() {
  return JSON.parse(fs.readFileSync(MOCK_SSH_STATE_PATH, 'utf8'));
}

async function waitForMockSshState(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = readMockSshState();
      if (predicate(state)) return state;
    } catch {
      // The server may not have accepted its first shell yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mock SSH state did not reach ${description}: ${JSON.stringify(readMockSshState())}`);
}

function generatePythonBindings() {
  const result = spawnSync(PYTHON, [path.join(REPO, 'node/scripts/generate_proto.py')], {
    cwd: path.join(REPO, 'node'),
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`failed to generate Python protobuf bindings: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

async function main() {
  generatePythonBindings();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(MOCK_SSH_STATE_PATH, { force: true });
  const trustDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-e2e-trust-'));
  let sshProc, nodeProc, browser, context, page;
  const browserErrors = [];
  try {
    sshProc = startProcess(PYTHON, [MOCK_SSH_SCRIPT], {
      MOCK_SSH_STATE_PATH,
      MOCK_SFTP_ROOT: path.join(trustDirectory, 'remote'),
      MOCK_SSH_REPORT_CWD: '1',
      MOCK_SSH_PASSWORD: 'test',
      ...(process.env.SEAL_E2E_BASH ? { MOCK_SSH_BASH: process.env.SEAL_E2E_BASH } : {}),
    });
    const sshPort = await waitForLine(sshProc, /MOCK_SSH_PORT=(\d+)/);
    console.log('mock SSH port:', sshPort);

    nodeProc = startProcess(PYTHON, ['-m', 'seal.main'], {
      SEAL_TRUST_PATH: path.join(trustDirectory, 'trust.json'),
      SEAL_PORT: '17373',
      SEAL_HOST: new URL(PWA_URL).hostname,
    });
    const pin = await waitForLine(nodeProc, /pairing code: (\d{6})/);
    console.log('node pairing pin:', pin);

    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    context = await browser.newContext();
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        browserErrors.push(message.text());
        console.error('browser:', message.text());
      }
    });
    page.on('pageerror', (error) => { browserErrors.push(error.message); console.error('page error:', error.message); });

    await page.goto(PWA_URL);

    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await page.getByRole('dialog', { name: '配对 Node', exact: true }).waitFor({ state: 'hidden' });

    let hostKeyPromptSeen = false;

    async function addHost(label) {
      const expectedTabCount = await page.locator('.terminal-tab').count() + 1;
      await page.locator('.conn-list').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建连接', exact: true }).click();
      await page.locator('#host-name').fill(label);
      await page.locator('#host-address').fill('127.0.0.1');
      await page.getByPlaceholder('port').fill(sshPort);
      await page.getByPlaceholder('username').fill('root');
      await page.locator('input[type="password"]').fill('test');
      const dialog = page.locator('.workbench-dialog-content');
      await dialog.getByRole('button', { name: '登录', exact: true }).click();
      try {
        const hostKeyAccept = page.locator('#host-key-accept');
        await hostKeyAccept.waitFor({ state: 'visible', timeout: 5000 });
        hostKeyPromptSeen = true;
        await hostKeyAccept.click();
        await page.waitForTimeout(1200);
      } catch {
        // The target may already be in PWA KnownHosts.
      }
      await page.waitForFunction(
        (expected) => {
          const tabs = document.querySelectorAll('.terminal-tab');
          return tabs.length >= expected && tabs[tabs.length - 1].querySelector('.dot.online') !== null;
        },
        expectedTabCount,
        { timeout: 20000 },
      );
      console.log(`host ${label} online`);
    }

    async function waitForMetrics() {
      await page.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll('[data-metric-value]'));
          const gauges = document.querySelectorAll('[data-metric-kind="gauge"] .metric-gauge-chart');
          const processCard = document.querySelector('[data-metric-id="process.count"][data-metric-kind="stat"]');
          return cards.length === 4
            && cards.every((element) => {
              const value = element.getAttribute('data-metric-value');
              return value && !value.includes('--');
            })
            && gauges.length === 3
            && processCard !== null;
        },
        null,
        { timeout: 30000 },
      );
    }

    await addHost('A');
    if (!hostKeyPromptSeen) throw new Error('first SSH connection did not request host-key confirmation');

    const sourceDirectory = process.env.SEAL_E2E_BASH
      ? path.join(trustDirectory, 'remote', "中文 path", "a'b;$(touch sentinel) #%=back").replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
      : "/workspace/中文 path/a'b;$(touch sentinel) #%=back";
    if (process.env.SEAL_E2E_BASH) fs.mkdirSync(path.join(trustDirectory, 'remote', "中文 path", "a'b;$(touch sentinel) #%=back"), { recursive: true });
    await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      window.sealE2eStore = store;
    });

    const sourceTabId = await page.evaluate(() => window.sealE2eStore.activeTerminalTabId);
    const initialState = await waitForMockSshState(state => !!state.shell_cwds?.['1'], 'the initial shell directory');
    const loginDirectory = initialState.shell_cwds['1'];
    async function waitForSourceDirectory(directory) {
      await page.waitForFunction(({ id, directory }) => window.sealE2eStore.tabs.find(tab => tab.id === id)?.cwd === directory,
        { id: sourceTabId, directory });
    }
    async function sendSourceCommand(command) {
      await page.evaluate(async ({ id, command }) => {
        const { sendTerminalInput } = await import('/src/services/ws.ts');
        const source = window.sealE2eStore.tabs.find(tab => tab.id === id);
        sendTerminalInput(source.sessionId, new TextEncoder().encode(`${command}\r`));
      }, { id: sourceTabId, command });
    }
    async function duplicate(trigger, expectedDirectory) {
      const shellNumber = readMockSshState().shell + 1;
      await trigger();
      await waitForMockSshState(state => state.shell_cwds?.[shellNumber] === expectedDirectory, 'the duplicated shell to enter the source directory');
      await page.waitForFunction(expected => {
        const store = window.sealE2eStore;
        const tab = store.tabs.find(tab => tab.id === store.activeTerminalTabId);
        return tab?.state === 'online' && tab.cwd === expected;
      }, expectedDirectory);
      await page.locator('.terminal-tab-close').nth(1).click();
      await page.locator('.terminal-tab').nth(1).waitFor({ state: 'detached' });
    }

    await page.locator('.xterm-screen').click();
    await page.keyboard.type(`cd -- '${sourceDirectory.replace(/'/g, "'\\''")}'`);
    await page.keyboard.press('Enter');
    await waitForSourceDirectory(sourceDirectory);
    await duplicate(() => page.locator('.terminal-tab-label').first().dblclick(), sourceDirectory);
    await duplicate(async () => {
      await page.locator('.xterm-screen').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^新建终端/ }).click();
    }, sourceDirectory);
    await duplicate(async () => {
      await page.locator('.xterm-screen').click();
      await page.keyboard.press('Control+Backquote');
    }, sourceDirectory);
    if (fs.existsSync(path.join(trustDirectory, 'remote', 'sentinel'))) throw new Error('directory was interpreted as a shell command');
    console.log('double-click, context menu and keyboard preserve the literal source directory');

    // Keep the original snapshot even if the source changes while login is open.
    for (const savedPassword of [undefined, 'wrong-password']) {
      await sendSourceCommand(`cd -- '${sourceDirectory.replace(/'/g, "'\\''")}'`);
      await waitForSourceDirectory(sourceDirectory);
      await page.evaluate(async password => {
        const { saveCredentialRecord } = await import('/src/services/vault.ts');
        await saveCredentialRecord(window.sealE2eStore.hosts[0].id, { password });
      }, savedPassword);
      await duplicate(async () => {
        await page.locator('.terminal-tab-label').first().dblclick();
        await page.getByRole('dialog', { name: '登录到 A', exact: true }).waitFor();
        await sendSourceCommand("cd -- '/'");
        await waitForSourceDirectory('/');
        await page.locator('#login-password').fill('test');
        await page.getByRole('dialog', { name: '登录到 A', exact: true }).getByRole('button', { name: '登录', exact: true }).click();
      }, sourceDirectory);
    }
    console.log('directory snapshots survive missing credentials and authentication retry');
    await page.evaluate(async () => {
      const { saveCredentialRecord } = await import('/src/services/vault.ts');
      const store = window.sealE2eStore;
      await saveCredentialRecord(store.hosts[0].id, { password: 'test' });
      store.tabs.find(tab => tab.id === store.activeTerminalTabId).cwd = undefined;
    });
    await duplicate(() => page.locator('.terminal-tab-label').first().dblclick(), loginDirectory);
    console.log('unknown source directory keeps the normal login directory');

    const credentialStore = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('seal-shell');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('credentials', 'readonly');
        const read = transaction.objectStore('credentials').getAll();
        read.onerror = () => reject(read.error);
        read.onsuccess = () => resolve(JSON.stringify(read.result));
      };
    }));
    if (credentialStore.includes('test')) {
      throw new Error('PWA credential store contains plaintext password');
    }

    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.waitForSelector('[role="menu"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 5000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });
    await page.locator('.xterm-screen').last().click({ button: 'right' });
    await page.waitForSelector('[role="menu"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 5000 });
    console.log('host and terminal context menus open and dismiss');

    const monitorButton = page.getByRole('button', { name: '系统监控', exact: true });
    await monitorButton.click();
    await waitForMetrics();
    const firstTelemetryState = await waitForMockSshState(
      (state) => state.stat >= 1,
      'the first telemetry sample',
    );
    if (firstTelemetryState.exec < 2 || firstTelemetryState.probe !== 1) {
      throw new Error(`expected direct exec probe and sample: ${JSON.stringify(firstTelemetryState)}`);
    }
    const secondTelemetryState = await waitForMockSshState(
      (state) => state.stat > firstTelemetryState.stat,
      'a second telemetry sample',
    );
    if (secondTelemetryState.probe !== 1 || secondTelemetryState.exec <= firstTelemetryState.exec) {
      throw new Error(`expected another direct exec sample without repeating the probe: ${JSON.stringify(secondTelemetryState)}`);
    }
    const firstValues = await page.locator('[data-metric-value]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-metric-value')),
    );
    console.log('first tab values:', firstValues);

    await monitorButton.click();
    await page.waitForFunction(
      () => document.querySelector('.secondary-sidebar')?.classList.contains('collapsed'),
      null,
      { timeout: 5000 },
    );
    // Allow an in-flight sample to finish, then verify polling stays stopped.
    await page.waitForTimeout(1000);
    const closedMonitorSamples = readMockSshState().stat;
    await page.waitForTimeout(2500);
    if (readMockSshState().stat !== closedMonitorSamples) throw new Error('telemetry kept polling while the monitor was closed');
    await monitorButton.click();
    await waitForMetrics();
    const reopenedMonitorState = readMockSshState();
    if (reopenedMonitorState.probe !== 1) {
      throw new Error(`reopening the monitor repeated the OS probe: ${JSON.stringify(reopenedMonitorState)}`);
    }

    await addHost('B');
    const tabs = await page.locator('.terminal-tab').all();
    if (tabs.length < 2) throw new Error('expected two tabs');
    await tabs[0].click();
    await waitForMetrics();

    const finalValues = await page.locator('[data-metric-value]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-metric-value')),
    );
    console.log('values after tab switch:', finalValues);
    if (finalValues.some((value) => value.includes('--'))) {
      throw new Error('metrics still showing -- after tab switch');
    }

    await page.reload();
    await page.locator('.connections-header').getByText('会话', { exact: true }).waitFor();
    if (await page.locator('.conn-item').count() !== 2) {
      throw new Error('PWA host records did not survive a reload');
    }

    const expectedReloadTabCount = await page.locator('.terminal-tab').count() + 1;
    await page.locator('.conn-item').first().hover();
    await page.locator('.conn-item').first().locator('.conn-btn').click();
    await page.waitForFunction(
      (expected) => {
        const tabs = document.querySelectorAll('.terminal-tab');
        return tabs.length >= expected && tabs[tabs.length - 1].querySelector('.dot.online') !== null;
      },
      expectedReloadTabCount,
      { timeout: 20000 },
    );
    if (await page.locator('.workbench-dialog-content').count() !== 0) {
      throw new Error('saved credential connection unexpectedly opened a login dialog');
    }
    console.log('saved SSH credential auto-loaded after reload');
    if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join('\n')}`);

    console.log('E2E test passed: PWA protocol client and PWA-owned telemetry follow active-tab lifecycle');
  } catch (error) {
    console.error('terminal state:', await page?.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.map(({ id, cwd, initialCwd, state }) => ({ id, cwd, initialCwd, state }));
    }).catch(() => undefined));
    await page?.screenshot({ path: path.join(TMP_DIR, 'failure.png') });
    console.error('Test failed:', error.stack);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
    const children = [sshProc, nodeProc].filter(proc => proc?.pid);
    for (const proc of children) if (proc.exitCode === null) {
      if (process.platform === 'win32' && proc === sshProc && process.env.SEAL_E2E_BASH) {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else proc.kill();
    }
    await Promise.all(children.map(proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve))));
    fs.rmSync(trustDirectory, { recursive: true, force: true });
    console.log('cleaned up');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
