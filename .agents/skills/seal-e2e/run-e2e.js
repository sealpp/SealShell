const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { confirmReload } = require('./close-protection');

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
const NATIVE_SHELL = process.env.SEAL_E2E_ZSH || process.env.SEAL_E2E_BASH;

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
      ...(process.env.SEAL_E2E_ZSH ? { MOCK_SSH_ZSH: process.env.SEAL_E2E_ZSH } : {}),
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
    await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      window.sealE2eStore = store;
    });

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
        // Let local fitting finish before SSH can open its PTY. This models
        // a slow handshake or a user taking time to confirm the host key.
        await page.waitForFunction(() => window.sealE2eStore.tabs[0]?.viewportSize?.columns > 80);
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
    const initialTerminalSize = await page.evaluate(() => window.sealE2eStore.tabs[0].viewportSize);
    await waitForMockSshState(state => {
      const size = state.shell_sizes?.['1'];
      return size?.[0] === initialTerminalSize.columns && size?.[1] === initialTerminalSize.rows;
    }, `the initial PTY to match xterm (${initialTerminalSize.columns}x${initialTerminalSize.rows}) without a browser resize`);
    const firstSize = readMockSshState().shell_initial_sizes?.['1'];
    if (firstSize?.[0] !== initialTerminalSize.columns || firstSize?.[1] !== initialTerminalSize.rows) {
      throw new Error(`shell started at ${JSON.stringify(firstSize)}, expected ${initialTerminalSize.columns}x${initialTerminalSize.rows}`);
    }
    console.log(`shell starts at the fitted ${initialTerminalSize.columns}x${initialTerminalSize.rows} before its first output`);

    // The actual PWA/WASM exec path uses a separate connection and releases it.
    if (NATIVE_SHELL) await page.waitForFunction(() => !!window.sealE2eStore.tabs[0]?.cwd);
    if (NATIVE_SHELL) fs.mkdirSync(path.join(trustDirectory, 'remote', 'project one'), { recursive: true });
    const beforeRecommendation = readMockSshState();
    const recommendationFacts = await page.evaluate(async native => {
      const { probeDirectory } = await import('/src/services/terminalSuggestions/context.ts');
      const tab = window.sealE2eStore.tabs[0];
      return probeDirectory(tab.sessionId, native ? tab.cwd : '/workspace', new AbortController().signal);
    }, !!NATIVE_SHELL);
    if (!recommendationFacts.directories.includes(recommendationFacts.cwd + '/project one')) throw new Error('recommendation context missing');
    await waitForMockSshState(state => state.active_connections === beforeRecommendation.active_connections
      && state.connections === beforeRecommendation.connections + 1 && state.shell === beforeRecommendation.shell,
    'recommendation probe connection to close without creating an interactive shell');
    if (readMockSshState().recommendation_probe !== 1) throw new Error('recommendation probe did not use fixed exec');
    console.log('recommendation context uses an isolated WASM SSH connection and releases it');

    const sourceDirectory = NATIVE_SHELL
      ? path.join(trustDirectory, 'remote', "中文 path", "a'b;$(touch sentinel) #%=back").replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
      : "/workspace/中文 path/a'b;$(touch sentinel) #%=back";
    if (NATIVE_SHELL) fs.mkdirSync(path.join(trustDirectory, 'remote', "中文 path", "a'b;$(touch sentinel) #%=back"), { recursive: true });

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
    if (NATIVE_SHELL) {
      const directory = path.join(trustDirectory, 'remote', 'codes', 'demo_linux');
      fs.mkdirSync(directory, { recursive: true });
      fs.mkdirSync(path.join(trustDirectory, 'remote', 'codes', 'destination'), { recursive: true });
      fs.mkdirSync(path.join(trustDirectory, 'remote', 'demo'), { recursive: true });
      fs.mkdirSync(path.join(trustDirectory, 'nearby-data', 'abdemo'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'entry.txt'), 'path-fixture-ok\n');
      const target = loginDirectory + '/codes/demo_linux';
      let modelCalls = 0;
      await page.route('https://path-model.invalid/**', route => {
        modelCalls++;
        const body = JSON.parse(route.request().postDataJSON().messages[1].content);
        if (body.input !== 'cd demolinux' || !body.facts.directories.includes(target)) throw new Error('model did not receive the current terminal directory tree');
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          suggestions: [{ command: `ls '${target}'` }, { command: `cd -- '${target}'` }],
        }) } }] }) });
      });
      await page.evaluate(async () => {
        const { commandSuggestions, saveSuggestionPreferences, rememberSuggestionCommand } = await import('/src/services/terminalSuggestions/runtime.ts');
        const { isShellPrompt } = await import('/src/services/terminalSuggestions/commandLine.ts');
        window.sealRecommendationState = commandSuggestions;
        window.sealIsShellPrompt = isShellPrompt;
        await saveSuggestionPreferences(true, true, { ...commandSuggestions.recommendations,
          cloud: false, remoteContext: true, baseUrl: 'https://path-model.invalid', model: 'controlled-response' }, 'synthetic-key');
        await rememberSuggestionCommand(window.sealE2eStore.tabs[0].hostId, 'cd /archive/demolinux', { cwd: window.sealE2eStore.tabs[0].cwd });
        await rememberSuggestionCommand(window.sealE2eStore.tabs[0].hostId, 'cd /archive/abdemo', { cwd: '/another-session' });
      });
      const waitForPrompt = () => page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent).filter(text => text.trim());
        return window.sealIsShellPrompt(rows[rows.length - 1]);
      });
      const candidates = page.getByRole('listbox', { name: '命令候选' }).getByRole('option');
      const nearbyTarget = loginDirectory.slice(0, loginDirectory.lastIndexOf('/')) + '/nearby-data/abdemo';
      await page.locator('.xterm-helper-textarea').focus();
      await waitForPrompt();
      // No preceding listing or usable history: discover a peer's child, not a local typo.
      await page.keyboard.type('cd abdemo');
      await candidates.filter({ has: page.getByText(`cd -- '${nearbyTarget}'`, { exact: true }) }).waitFor();
      if (await candidates.first().getAttribute('data-source') !== 'directory') throw new Error('nearby target was supplied by history');
      if ((await candidates.locator('code').allTextContents()).some(command => command.includes('/archive/') || command.endsWith("/demo'"))) throw new Error('history or a weak typo displaced the discovered target');
      await candidates.first().click();
      if (readMockSshState().shell_cwds['1'] !== loginDirectory) throw new Error('nearby path acceptance executed before Enter');
      await page.keyboard.press('Enter');
      await waitForSourceDirectory(nearbyTarget);
      await sendSourceCommand(`cd -- '${loginDirectory}'`);
      await waitForSourceDirectory(loginDirectory);
      await waitForPrompt();
      await page.evaluate(() => { window.sealRecommendationState.recommendations.cloud = true; });
      await page.keyboard.type('cd demolinux');
      await candidates.filter({ has: page.getByText(`cd -- '${target}'`, { exact: true }) }).waitFor();
      if (await candidates.first().getAttribute('data-source') !== 'ai' || modelCalls !== 1) throw new Error('path input bypassed AI generation');
      const navigation = await candidates.locator('code').allTextContents();
      if (navigation.some(command => !command.startsWith('cd '))) throw new Error(`navigation intent changed: ${navigation}`);
      await candidates.first().click();
      await page.waitForTimeout(200);
      if (readMockSshState().shell_cwds['1'] !== loginDirectory) throw new Error('path acceptance executed before Enter');
      await page.keyboard.press('Enter');
      await waitForSourceDirectory(target);
      await waitForMockSshState(state => state.shell_cwds['1'] === target, 'the real shell to enter the corrected directory');
      await page.evaluate(() => { window.sealRecommendationState.recommendations.cloud = false; });
      await waitForPrompt();
      await page.keyboard.type('ls -la ../demo_li');
      await candidates.filter({ has: page.getByText(`ls -la -- '${target}'`, { exact: true }) }).waitFor();
      await candidates.first().click();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('entry.txt'));
      await waitForPrompt();
      await page.keyboard.type('cat entry.tx');
      await candidates.filter({ has: page.getByText(`cat -- '${target}/entry.txt'`, { exact: true }) }).waitFor();
      await candidates.first().click();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('path-fixture-ok'));
      await waitForPrompt();
      // sort has no command profile: command -v and filesystem evidence infer the operand.
      await page.keyboard.type('sort -r entry.tx');
      await candidates.filter({ has: page.getByText(`sort -r '${target}/entry.txt'`, { exact: true }) }).waitFor();
      await candidates.first().click();
      await page.keyboard.press('Enter');
      await waitForPrompt();
      await page.keyboard.type('grep -n path-fixture entry.tx');
      await candidates.filter({ has: page.getByText(`grep -n path-fixture '${target}/entry.txt'`, { exact: true }) }).waitFor();
      if (!(await candidates.first().textContent()).includes('grep -n')) throw new Error('an alternative displaced the requested command');
      await candidates.first().click();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('1:path-fixture-ok'));
      await waitForPrompt();
      await page.keyboard.type('cp entry.txt ../dest');
      const destination = loginDirectory + '/codes/destination';
      await candidates.filter({ has: page.getByText(`cp entry.txt '${destination}'`, { exact: true }) }).waitFor();
      await candidates.first().click();
      if (fs.existsSync(path.join(trustDirectory, 'remote', 'codes', 'destination', 'entry.txt'))) throw new Error('copy acceptance executed before Enter');
      await page.keyboard.press('Enter');
      await waitForPrompt();
      if (fs.readFileSync(path.join(trustDirectory, 'remote', 'codes', 'destination', 'entry.txt'), 'utf8') !== 'path-fixture-ok\n') throw new Error('copy completion changed the source or destination');
      if (modelCalls !== 1) throw new Error('local completion unexpectedly called the model');
      await page.screenshot({ path: path.join(TMP_DIR, 'path-completion.png') });
      await sendSourceCommand(`cd -- '${loginDirectory}'`);
      await waitForSourceDirectory(loginDirectory);
      await page.evaluate(() => { window.sealRecommendationState.recommendations.cloud = false; });
      console.log('real recommendations: cold directory tree reaches the model, AI source preserves cd, local mode remains available, acceptance without execution');
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
      const size = await page.evaluate(() => {
        const store = window.sealE2eStore;
        return store.tabs.find(tab => tab.id === store.activeTerminalTabId).viewportSize;
      });
      const firstSize = readMockSshState().shell_initial_sizes?.[shellNumber];
      if (firstSize?.[0] !== size.columns || firstSize?.[1] !== size.rows) {
        throw new Error(`duplicated shell started at ${JSON.stringify(firstSize)}, expected ${size.columns}x${size.rows}`);
      }
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

    const beforeBatch = readMockSshState().shell;
    const batchIds = await page.evaluate(async () => {
      const { addTab } = await import('/src/services/ws.ts');
      return Array.from({ length: 3 }, () => addTab(window.sealE2eStore.hosts[0], 'test').id);
    });
    await page.waitForFunction(ids => ids.every(id => window.sealE2eStore.tabs.find(tab => tab.id === id)?.state === 'online'), batchIds);
    const batchSize = await page.evaluate(ids => window.sealE2eStore.tabs.find(tab => tab.id === ids[0]).viewportSize, batchIds);
    const batchState = await waitForMockSshState(state => state.shell === beforeBatch + 3, 'all batch shells to start');
    for (let number = beforeBatch + 1; number <= beforeBatch + 3; number++) {
      const size = batchState.shell_initial_sizes[number];
      if (size?.[0] !== batchSize.columns || size?.[1] !== batchSize.rows) {
        throw new Error(`batch shell ${number} started at ${JSON.stringify(size)}, expected ${batchSize.columns}x${batchSize.rows}`);
      }
    }
    await page.evaluate(async ids => (await import('/src/services/ws.ts')).closeTabs(ids), batchIds);
    console.log('PASS batch shells start with their shared viewport while background tabs remain detached');

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

    const shellCount = readMockSshState().shell;
    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    await waitForMetrics();
    const firstTelemetryState = await waitForMockSshState(state => state.stat >= 1, 'the first sample');
    const secondTelemetryState = await waitForMockSshState(state => state.stat > firstTelemetryState.stat, 'the second sample');
    if (secondTelemetryState.probe !== 1 || secondTelemetryState.shell !== shellCount || secondTelemetryState.connections !== firstTelemetryState.connections) {
      throw new Error(`monitor must retain one independent connection without opening a shell: ${JSON.stringify(secondTelemetryState)}`);
    }
    await page.locator('.xterm-screen').last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    if (await page.locator('.workspace-category-view.active .workspace-instance').count() !== 1) throw new Error('duplicate monitor from the terminal menu');
    const monitorButton = page.getByRole('button', { name: '性能监测 1', exact: true });
    await monitorButton.click();
    await page.locator('.workspace-panel').waitFor({ state: 'hidden' });
    const hiddenSamples = readMockSshState().stat;
    await waitForMockSshState(state => state.stat > hiddenSamples, 'continuous hidden sampling');
    await monitorButton.click();
    await waitForMetrics();
    console.log('PASS dedicated SSH connection, no shell, both menu entries deduplicate, hidden sampling continues');

    await addHost('B');
    await page.locator('.conn-item').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    await page.waitForFunction(() => {
      const store = window.sealE2eStore;
      return store.tabs.filter(tab => tab.kind === 'monitor').length === 2 && store.tabs.filter(tab => tab.kind === 'monitor').every(tab => tab.monitor.telemetry);
    });
    const savedHost = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return JSON.parse(JSON.stringify(store.hosts[0]));
    });
    const ids = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      const { createHost, closeTabs, deleteHosts } = await import('/src/services/ws.ts');
      const monitors = store.tabs.filter(tab => tab.kind === 'monitor');
      closeTabs(store.tabs.filter(tab => tab.kind === 'terminal').map(tab => tab.id));
      await createHost({ ...JSON.parse(JSON.stringify(store.hosts[0])), name: 'A edited', port: 1 });
      await deleteHosts([store.hosts[1].id]);
      return monitors.map(tab => ({ id: tab.id, sampledAt: tab.monitor.telemetry.sampledAt }));
    });
    await page.waitForFunction(previous => {
      const store = window.sealE2eStore;
      return previous.every(item => store.tabs.find(tab => tab.id === item.id)?.monitor.telemetry?.sampledAt > item.sampledAt);
    }, ids);
    await waitForMockSshState(state => state.active_connections === 2, 'only two independent monitors after terminals close');
    console.log('PASS both same-address profiles continue after terminal closure, profile edits and deletion');

    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    const reusedId = await page.evaluate(async () => (await import('/src/stores/app.ts')).store.activeMonitorTabId);
    if (reusedId !== ids[0].id) throw new Error('editing a profile replaced its existing monitor');
    await page.evaluate(async ids => (await import('/src/services/ws.ts')).closeTabs(ids.map(item => item.id)), ids);
    await waitForMockSshState(state => state.active_connections === 0, 'monitor connections released');
    const closedSamples = readMockSshState().stat;
    await page.waitForTimeout(2200);
    if (readMockSshState().stat !== closedSamples) throw new Error('closed monitors continued sampling');
    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    await page.waitForFunction(() => {
      const store = window.sealE2eStore;
      return store.tabs.some(tab => tab.kind === 'monitor' && tab.monitor.port === 1 && tab.state === 'error');
    });
    await page.evaluate(async original => {
      const { store } = await import('/src/stores/app.ts');
      const { closeTabs, createHost } = await import('/src/services/ws.ts');
      closeTabs(store.tabs.map(tab => tab.id));
      await createHost(original);
    }, savedHost);
    await page.locator('.conn-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click();
    await waitForMetrics();
    if (await page.locator('.terminal-tab').count()) throw new Error('standalone monitor opened a terminal');
    await page.screenshot({ path: path.join(TMP_DIR, 'monitoring.png') });
    console.log('PASS close releases connections, reopen uses latest config, monitor starts without terminals');

    // Dismissing the browser close prompt must leave live SSH and telemetry intact.
    const closeDialog = page.waitForEvent('dialog', { timeout: 10000 });
    await page.close({ runBeforeUnload: true });
    const confirmation = await closeDialog;
    if (confirmation.type() !== 'beforeunload') throw new Error('expected a browser exit confirmation');
    await confirmation.dismiss();
    if (page.isClosed()) throw new Error('cancelling exit closed the page');
    const samplesBeforeExit = readMockSshState().stat;
    await page.waitForFunction(() => {
      const store = window.sealE2eStore;
      return store.tabs.filter(tab => tab.kind === 'terminal').every(tab => tab.state === 'online');
    });
    const monitorDeadline = Date.now() + 15000;
    while (readMockSshState().stat <= samplesBeforeExit) {
      if (Date.now() > monitorDeadline) throw new Error('monitoring did not resume after cancelled exit');
      await page.waitForTimeout(100);
    }
    console.log('PASS cancelled browser exit preserves standalone monitoring');

    await confirmReload(page);
    await page.locator('.connections-header').getByText('会话', { exact: true }).waitFor();
    if (await page.locator('.conn-item').count() !== 1) {
      throw new Error('PWA host records did not survive a reload');
    }

    await waitForMockSshState(state => state.active_connections === 0, 'refresh releases monitor connections');
    if (await page.locator('.workspace-instance').count()) throw new Error('monitor survived a refresh');
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

    console.log('E2E test passed: PWA terminals and independent monitoring lifecycles');
  } catch (error) {
    console.error('terminal state:', await page?.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts');
      return store.tabs.map(({ id, kind, hostId, cwd, initialCwd, state, error }) => ({ id, kind, hostId, cwd, initialCwd, state, error }));
    }).catch(() => undefined));
    await page?.screenshot({ path: path.join(TMP_DIR, 'failure.png') });
    console.error('Test failed:', error.stack);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
    const children = [sshProc, nodeProc].filter(proc => proc?.pid);
    for (const proc of children) if (proc.exitCode === null) {
      if (process.platform === 'win32' && proc === sshProc && NATIVE_SHELL) {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else proc.kill();
    }
    await Promise.all(children.map(proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve))));
    // Windows may release terminated shell file handles just after process exit.
    await fs.promises.rm(trustDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log('cleaned up');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
