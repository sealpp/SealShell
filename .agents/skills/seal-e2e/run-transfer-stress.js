const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '../../..');
const { chromium } = require(path.join(REPO, 'shell/node_modules/playwright'));
const PYTHON = path.join(REPO, 'node/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HOST = process.env.SEAL_E2E_HOST || '127.0.0.1';
const SIZE = Number(process.env.SEAL_STRESS_MIB || 128) * 1024 * 1024;
const DIRECTION = process.env.SEAL_STRESS_DIRECTION || 'upload';
const STREAM = process.env.SEAL_STRESS_STREAM !== '0';
const WORKERS = process.env.SEAL_STRESS_WORKERS !== '0';
const SLOW = process.env.SEAL_STRESS_SLOW === '1';
const fixtureParent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(fixtureParent, 'seal-transfer-stress-'));
const artifacts = path.join(os.tmpdir(), 'seal-e2e/transfer-stress');
const children = [];
fs.mkdirSync(artifacts, { recursive: true });
const remote = path.join(fixture, 'remote');
fs.mkdirSync(remote);
const controlPath = path.join(fixture, 'sftp-control.json');
const statePath = path.join(fixture, 'sftp-state.json');
fs.writeFileSync(controlPath, '{}');
for (const folder of ['upload', 'copy', 'cancel-upload', 'cancel-remote', 'slow']) fs.mkdirSync(path.join(remote, folder));
const downloads = path.join(fixture, 'downloads');
fs.mkdirSync(downloads);
fs.mkdirSync(path.join(downloads, 'cancel'));
const input = path.join(fixture, 'large.bin');
const fd = fs.openSync(input, 'w');
const block = crypto.randomBytes(1024 * 1024);
for (let offset = 0; offset < SIZE; offset += block.length) {
  block.writeUInt32LE(offset / block.length, 0);
  fs.writeSync(fd, block, 0, Math.min(block.length, SIZE - offset));
}
fs.closeSync(fd);
if (DIRECTION === 'download') fs.copyFileSync(input, path.join(remote, 'large.bin'));
fs.writeFileSync(path.join(fixture, 'slow.bin'), block.subarray(0, 2 * 1024 * 1024));

function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', data => process.stderr.write(data));
  return child;
}
function ready(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Service startup timed out')), 20000);
    child.stdout.on('data', data => { output += data; const match = output.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited: ${code}`)); });
  });
}
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function state() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } }

(async () => {
  let browser;
  let deadline;
  const samples = [];
  try {
    const ssh = start(PYTHON, ['.agents/skills/seal-e2e/mock-ssh-server.py'], { MOCK_SFTP_ROOT: remote, MOCK_SFTP_CONTROL_PATH: controlPath, MOCK_SSH_STATE_PATH: statePath });
    const port = Number(await ready(ssh, /MOCK_SSH_PORT=(\d+)/));
    const node = start(PYTHON, ['-m', 'seal.main'], { SEAL_HOST: HOST, SEAL_TRUST_PATH: path.join(fixture, 'trust.json') });
    const pin = await ready(node, /pairing code: (\d{6})/);
    const vite = start(process.execPath, ['shell/node_modules/vite/bin/vite.js', '--host', HOST, '--port', '8081', '--strictPort', '--config', 'shell/vite.config.ts', 'shell']);
    await ready(vite, /(?:Local|Network):\s+(http:\/\/[^\s]+\/)/);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('PAGE ERROR', error.message));
    await page.exposeFunction('sampleTransfer', sample => { samples.push(sample); console.log(JSON.stringify(sample)); });
    await page.goto(`http://${HOST}:8081`);
    await page.getByPlaceholder('000000').fill(pin);
    await page.locator('.workbench-dialog-content .workbench-dialog-button--primary').click();
    await page.getByRole('dialog', { name: '配对 Node', exact: true }).waitFor({ state: 'hidden' });
    await Promise.race([
      page.evaluate(async ({ input, port, size, direction, stream }) => {
        const { Libssh2Session } = await import('/src/services/ssh/libssh2-runtime.ts');
        const { NodeFileBackend } = await import('/src/services/files/node-backend.ts');
        const session = new Libssh2Session();
        const local = new NodeFileBackend();
        let reader;
        let writer;
        let remoteReader;
        let remoteWriter;
        const started = performance.now();
        const stats = { closeCalls: 0, closeAgain: 0 };
        try {
          await session.connect({ host: '127.0.0.1', port, username: 'root', password: 'test', onHostKey: async key => {
            const { saveKnownHost } = await import('/src/services/storage.ts');
            const publicKey = btoa(String.fromCharCode(...key));
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
            await saveKnownHost({ host: '127.0.0.1', port, publicKey, fingerprint: 'SHA256:' + btoa(String.fromCharCode(...hash)).replace(/=+$/, '') });
            return true;
          } });
          await session.initSftp();
          for (const name of ['ssh2_sftp_close', 'ssh2_sftp_close_handle']) {
            const close = session.module[name];
            if (close) session.module[name] = handle => { stats.closeCalls++; const result = close(handle); if (result === -37) stats.closeAgain++; return result; };
          }
          await local.connect();
          if (direction === 'download') writer = await local.openWriter(input + '.download');
          else reader = await local.openReader(input);
          if (stream) {
            if (direction === 'download') remoteReader = await session.openReader('/large.bin');
            else remoteWriter = await session.openWriter('/large.bin');
          }
          let nextSample = 0;
          for (let offset = 0; offset < size;) {
            const data = direction === 'download'
              ? await (remoteReader ? remoteReader.read(offset, Math.min(256 * 1024, size - offset)) : session.readPath('/large.bin', offset, Math.min(256 * 1024, size - offset)))
              : await reader.read(offset, Math.min(256 * 1024, size - offset));
            const count = data.byteLength;
            if (!count) throw new Error('Unexpected EOF');
            if (writer) await writer.write(offset, data);
            else if (remoteWriter) await remoteWriter.write(offset, data);
            else await session.writePath('/large.bin', data, offset);
            offset += count;
            if (offset >= nextSample) {
              await window.sampleTransfer({ bytes: offset, wasmBytes: session.module.HEAPU8.length, elapsedMs: Math.round(performance.now() - started), ...stats });
              nextSample += 8 * 1024 * 1024;
            }
          }
          await window.sampleTransfer({ completed: true, wasmBytes: session.module.HEAPU8.length, ...stats });
        } catch (error) {
          await window.sampleTransfer({ error: error.message, wasmBytes: session.module?.HEAPU8.length, elapsedMs: Math.round(performance.now() - started), ...stats });
          throw error;
        } finally {
          await reader?.close();
          await writer?.close();
          await remoteReader?.close();
          await remoteWriter?.close();
          await local.disconnect();
          await session.close();
          await window.sampleTransfer({ phase: 'native-closed', wasmBytes: session.module.HEAPU8.length, ...stats });
        }
      }, { input, port, size: SIZE, direction: DIRECTION, stream: STREAM }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Transfer exceeded 180 seconds')), 180000); }),
    ]);
    const digest = async file => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    };
    const output = DIRECTION === 'download' ? input + '.download' : path.join(remote, 'large.bin');
    if (await digest(input) !== await digest(output)) throw new Error('Transferred content hash mismatch');
    console.log('PASS complete file SHA-256');
    clearTimeout(deadline);
    if (STREAM && Math.max(...samples.map(sample => sample.wasmBytes || 0)) > 64 * 1024 * 1024) throw new Error('WASM memory exceeded bounded transfer budget');

    if (WORKERS) {
      deadline = setTimeout(() => { console.error('Worker stress scenarios exceeded 5 minutes'); void browser.close(); }, 300000);
      await page.evaluate(async ({ port, input, downloads, localDirectory }) => {
        const { store } = await import('/src/stores/app.ts');
        const { connectFileEndpoint } = await import('/src/services/files/connect.ts');
        const { registerFileSession } = await import('/src/services/sftp/file-tabs.ts');
        const { transferFileEntries } = await import('/src/services/files/transfers.ts');
        const { transferRuntime, cancelTransfer } = await import('/src/services/sftp/transfer-runtime.ts');
        const connection = { host: '127.0.0.1', port, username: 'root', password: 'test' };
        const backends = [];
        for (const [id, kind, cwd] of [['local-source','local',localDirectory],['local-target','local',downloads],['remote-source','sftp','/'],['remote-target','sftp','/upload']]) {
          const endpoint = kind === 'local' ? {kind,nodeId:''} : {kind,hostId:'stress-host'};
          const backend = await connectFileEndpoint(endpoint, connection);
          backends.push(backend);
          registerFileSession(id, backend);
          const entries = id.endsWith('source') ? [await backend.stat(kind === 'local' ? input : '/large.bin')] : [];
          store.tabs.push({ id,kind:'file',endpoint,hostId:'stress-host',label:id,state:'online',error:'',sessionId:id,terminalId:'',telemetry:null,encoding:'utf-8',cwd,
            file:{cwd,defaultPath:cwd,history:[cwd],historyIndex:0,entries,selectedPaths:[],sortKey:'name',sortDirection:'asc',showHidden:false,loading:false,error:''} });
        }
        window.transferStress = {
          result: null,
          async run(source, target, paths, directory) {
            this.result = null;
            try { await transferFileEntries(source,target,paths,directory); this.result = {ok:true}; }
            catch(error) { this.result = {ok:false,error:error.message}; }
          },
          cancel() { const task=transferRuntime.tasks.findLast(task=>task.state==='running'); if(!task) throw new Error('No running transfer'); cancelTransfer(task.id); },
          latest() { return transferRuntime.tasks.at(-1); },
          async close() { for(const backend of backends) await backend.disconnect(); },
        };
      }, { port, input, downloads, localDirectory: fixture });
      const baselineWorkers = page.workers().length;
      for (const [direction, source, target, paths, directory, file] of [
        ['upload','local-source','remote-target',[input],'/upload',path.join(remote,'upload/large.bin')],
        ['download','remote-source','local-target',['/large.bin'],downloads,path.join(downloads,'large.bin')],
        ['remote-copy','remote-source','remote-target',['/large.bin'],'/copy',path.join(remote,'copy/large.bin')],
      ]) {
        const startTime = Date.now();
        await page.evaluate(({ source,target,paths,directory }) => window.transferStress.run(source,target,paths,directory), {source,target,paths,directory});
        const result = await page.evaluate(() => window.transferStress.result);
        if (!result.ok) throw new Error(`${direction}: ${result.error}`);
        if (await digest(input) !== await digest(file)) throw new Error(`${direction}: file hash mismatch`);
        await until(() => page.workers().length === baselineWorkers, `${direction}: transfer workers retained`);
        console.log(JSON.stringify({ phase:direction,bytes:SIZE,elapsedMs:Date.now()-startTime,workers:page.workers().length,server:state() }));
      }

      const retained = [];
      for (const [direction, source, target, paths, directory, delayKind] of [
        ['upload','local-source','remote-target',[input],'/cancel-upload','write'],
        ['download','remote-source','local-target',['/large.bin'],path.join(downloads,'cancel'),'read'],
        ['remote-copy','remote-source','remote-target',['/large.bin'],'/cancel-remote','write'],
      ]) {
        fs.writeFileSync(controlPath, JSON.stringify({[delayKind+'DelayMs']:3000}));
        const before = state()['sftp_'+delayKind+'s'] || 0;
        await page.evaluate(args => { void window.transferStress.run(...args); }, [source,target,paths,directory]);
        await until(() => (state()['sftp_'+delayKind+'s'] || 0) > before, 'Stalled transfer did not reach '+delayKind);
        const cancelTime = Date.now();
        await page.evaluate(() => window.transferStress.cancel());
        await until(() => page.evaluate(() => !!window.transferStress.result), 'Cancellation did not settle', 5000);
        const cancelled = await page.evaluate(() => window.transferStress.latest());
        if (cancelled.state !== 'cancelled') throw new Error('Cancellation state: '+JSON.stringify(cancelled));
        await until(() => page.workers().length === baselineWorkers, 'Cancelled workers retained');
        console.log(JSON.stringify({phase:'cancel-'+direction,elapsedMs:Date.now()-cancelTime,workers:page.workers().length,orphanPath:cancelled.orphanPath,server:state()}));
        fs.writeFileSync(controlPath, '{}');
        if (cancelled.orphanPath) {
          // A server still executing its request can hold a Windows file open.
          // The UI must retain the exact cleanup path while PWA resources end.
          const file = path.resolve(remote, '.' + cancelled.orphanPath);
          if (!file.startsWith(remote + path.sep) || !path.basename(file).startsWith('.sealshell-')) throw new Error('Invalid retained temporary path');
          retained.push(file);
        }
        await until(() => state().sftp_active === 0, 'Server did not release cancelled file handles');
        const folder = direction === 'download' ? path.join(downloads,'cancel') : path.join(remote,directory.slice(1));
        const leftovers = fs.readdirSync(folder).map(name=>path.join(folder,name));
        if (leftovers.some(file=>!retained.includes(file))) throw new Error('Unreported temporary file after cancellation');
      }
      for (const file of retained) {
        if (!fs.existsSync(file)) throw new Error('Retained path does not exist');
        fs.unlinkSync(file);
      }

      if (SLOW) {
        fs.writeFileSync(controlPath, JSON.stringify({writeDelayMs:2000}));
        const startTime = Date.now();
        await page.evaluate(({ file }) => window.transferStress.run('local-source','remote-target',[file],'/slow'), {file:path.join(fixture,'slow.bin')});
        const result = await page.evaluate(() => window.transferStress.result);
        if (!result.ok) throw new Error(`Slow transfer: ${result.error}`);
        if (Date.now()-startTime < 60000) throw new Error('Slow scenario did not run longer than one minute');
        if (await digest(path.join(fixture,'slow.bin')) !== await digest(path.join(remote,'slow/slow.bin'))) throw new Error('Slow transfer hash mismatch');
        console.log(JSON.stringify({phase:'slow-transfer',elapsedMs:Date.now()-startTime,server:state()}));
        fs.writeFileSync(controlPath, '{}');
      }
      await page.evaluate(() => window.transferStress.close());
      await until(() => page.workers().length === 0, 'SFTP workers remained after closing all endpoints');
      await until(() => state().sftp_active === 0, 'Remote handles remained after closing all endpoints');
      console.log('PASS all transfer workers and remote handles released');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    fs.writeFileSync(path.join(artifacts, 'samples.json'), JSON.stringify(samples, null, 2));
    await browser?.close();
    for (const child of children.reverse()) if (child.pid && child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.filter(child => child.pid).map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    if (path.dirname(fs.realpathSync(fixture)) !== fixtureParent || !path.basename(fixture).startsWith('seal-transfer-stress-')) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})();
