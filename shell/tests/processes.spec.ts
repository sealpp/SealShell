import { expect, test, type Page } from '@playwright/test'

const connectionMock = `
window.processTest = { samples:0, commands:[], opened:0, closed:0, reuse:false, denied:false, identities:{} };
const f = window.processTest;
export async function connectMonitor(options, signal) {
  f.opened++;
  signal.addEventListener('abort', () => f.closed++, {once:true});
  const result = text => ({stdout:new TextEncoder().encode(text),stderr:new Uint8Array(),exitCode:0});
  return {close:async()=>{},exec:async command => {
    if(command==='uname -s') return result('Linux');
    if(command.includes('SEAL_PROCESS_SIGNAL_V1')) {
      f.commands.push(command);
      const targets=command.split("done <<'SEAL_PROCESS_TARGETS'\\n")[1].split('\\n').filter(line=>/^\\d+ /.test(line));
      return result(targets.map(line=>{const pid=line.split(' ')[0];return pid+'\\t'+(f.reuse&&pid==='10'?'changed':f.denied&&pid==='11'?'denied':'sent')}).join('\\n'));
    }
    f.samples++;
    const rows=[];
    for(let i=10;i<1510;i++) {
      const identity=f.identities[i];
      const name=identity?.name ?? (i===10?'tree-root':i===11?'tree-child':i===12?'tree-leaf':'worker-'+i);
      const parent=i===11?10:i===12?11:1;
      const argv=identity?.argv ?? ['/usr/bin/'+name,'--argument=中文'];
      rows.push([i,parent,1000,'alice','S',1048576,i,100+f.samples*10,2,name,argv.map(arg=>arg.replaceAll('%','%25')).join('%00')+'%00'].join('\\t'));
    }
    return result('SEAL_PROCESS_V2\\tboot\\t100\\t'+(10+f.samples*2)+'\\t1700000000\\n'+rows.join('\\n')+'\\nSEAL_PROCESS_END\\t'+rows.length+'\\n');
  }};
}
`
async function open(page: Page, source = 'host') {
  await page.locator('.test-' + source).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开进程管理', exact: true }).click()
  await expect(page.locator('.process-footer')).toContainText('1500 个进程')
}
async function action(page: Page, name: string) {
  await page.getByRole('button', { name: /结束操作/ }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
  await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await page.route('**/src/services/monitoring/connection.ts', route => route.fulfill({ contentType: 'application/javascript', body: connectionMock }))
  await page.goto('/tests/monitoring-harness.html')
  await page.locator('.test-host').waitFor()
  await page.evaluate(() => { (window as any).monitorFixture.store.nodeConnected = true })
})

test('opens one independent bottom instance, virtualizes the table and keeps details in its pane', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await open(page)
  await expect(page.getByRole('tab', { name: '进程管理', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(await page.locator('.process-row').count()).toBeLessThan(60)
  const nameColumn = page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: '按进程排序', exact: true }) })
  const initialWidth = (await nameColumn.boundingBox())!.width
  const handle = (await page.getByRole('separator', { name: '调整进程列宽', exact: true }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + handle.height / 2)
  await page.mouse.up()
  await expect.poll(async () => (await nameColumn.boundingBox())!.width).toBeGreaterThan(initialWidth + 40)
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('tree-root')
  await page.locator('.process-row').click()
  await expect(page.getByRole('complementary', { name: '进程详情' })).toContainText('/usr/bin/tree-root --argument=中文')
  await open(page, 'terminal')
  await expect(page.getByRole('button', { name: '进程管理 1', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).processTest.opened)).toBe(1)
  expect(errors).toEqual([])
})

test('pauses hidden polling, resumes on reveal and releases the owned connection on close', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '进程管理 1', exact: true }).click()
  const samples = await page.evaluate(() => (window as any).processTest.samples)
  await page.waitForTimeout(2300)
  expect(await page.evaluate(() => (window as any).processTest.samples)).toBe(samples)
  await page.getByRole('button', { name: '进程管理 1', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).processTest.samples)).toBeGreaterThan(samples)
  await page.locator('.workspace-category-view.active .workspace-instance-close').click()
  expect(await page.evaluate(() => (window as any).processTest.closed)).toBe(1)
})

test('distinguishes explicit tools from launchers and runtime arguments with offline icons', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).processTest.identities = {
      10: { name: 'clickhouse-serv', argv: ['/usr/bin/clickhouse-server'] },
      11: { name: 'codex', argv: ['/usr/bin/codex'] },
      12: { name: 'pyrefly', argv: ['/usr/bin/pyrefly', 'check'] },
      13: { name: 'devin', argv: ['/usr/bin/devin'] },
      14: { name: 'npm run dev', argv: ['npm run dev'] },
      15: { name: 'node', argv: ['/usr/bin/node', '/srv/项目 with spaces/node_modules/vite/bin/vite.js'] },
      16: { name: 'node', argv: ['node', '-e', 'console.log("vite")', '/srv/node_modules/vite/bin/vite.js'] },
      17: { name: 'custom-worker', argv: ['custom-worker', '--application=codex'] },
    }
  })
  await open(page)
  const expected = ['clickhouse', 'codex', 'pyrefly', 'devin', 'npm', 'vite', 'node', 'process']
  for (let index = 0; index < expected.length; index++) {
    await expect(page.locator('.process-row[data-pid="' + (10 + index) + '"] .process-icon')).toHaveAttribute('data-process-icon', expected[index])
  }
  await page.context().setOffline(true)
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('pyrefly')
  await page.locator('.process-row').click()
  await expect(page.locator('.process-detail .process-icon')).toHaveAttribute('data-process-icon', 'pyrefly')
  await expect(page.locator('.process-detail')).toContainText('/usr/bin/pyrefly check')
})

test('labels AI CLIs across native, npm and Python launches while preserving runtime fallbacks', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).monitorFixture.store.bottomPanelHeight = 650
    const programs = [
      ['claude', ['claude']],
      ['node', ['node', '/srv/node_modules/@google/gemini-cli/bundle/gemini.js']],
      ['node', ['node', '/srv/node_modules/@github/copilot/npm-loader.js']],
      ['opencode', ['opencode']], ['cursor-agent', ['cursor-agent']],
      ['node', ['node', '/srv/node_modules/@qwen-code/qwen-code/cli-entry.js']],
      ['cline', ['cline']], ['kilo', ['kilo']], ['amp', ['amp']], ['droid', ['droid']],
      ['python3', ['python3', '-m', 'aider']], ['python3', ['python3', '/srv/.venv/bin/vibe']],
      ['ollama', ['ollama', 'serve']], ['agent', ['agent', '--model=claude']],
    ]
    ;(window as any).processTest.identities = Object.fromEntries(programs.map(([name, argv], i) => [i + 10, { name, argv }]))
  })
  await open(page)
  const expected = ['claude', 'gemini', 'copilot', 'opencode', 'cursor', 'qwen', 'cline', 'kilo', 'amp', 'droid', 'aider', 'mistral', 'ollama', 'process']
  for (let index = 0; index < expected.length; index++) {
    await expect(page.locator('.process-row[data-pid="' + (10 + index) + '"] .process-icon')).toHaveAttribute('data-process-icon', expected[index])
  }
  await expect(page.locator('.process-row[data-pid="10"] .process-icon svg')).toHaveAttribute('fill-rule', 'evenodd')
  await page.context().setOffline(true)
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('@google/gemini-cli')
  await page.locator('.process-row').click()
  await expect(page.locator('.process-detail .process-icon')).toHaveAttribute('title', 'Gemini CLI')
})

test('confirms a tree separately from its selection and supports cancel, forced action and partial failures', async ({ page }) => {
  await open(page)
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('tree-root')
  await page.locator('.process-row').click()
  await action(page, '结束进程')
  await expect(page.locator('.process-confirm-list>div')).toHaveCount(1)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await action(page, '结束进程树')
  await expect(page.locator('.process-confirm-list>div')).toHaveCount(3)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(() => (window as any).processTest.commands.length)).toBe(0)
  await action(page, '强制结束进程树')
  await page.evaluate(() => { (window as any).processTest.reuse = true; (window as any).processTest.denied = true })
  await page.getByRole('button', { name: '确认强制结束进程树', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('.process-results')).toContainText('身份已变化，已跳过')
  await expect(page.locator('.process-results')).toContainText('权限不足')
  expect(await page.evaluate(() => (window as any).processTest.commands[0])).toContain('kill -KILL')
  await expect(page.locator('.process-table-scroll')).toBeVisible()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
})

test('preserves multi-selection through sorting and refresh and supports expanding a process tree', async ({ page }) => {
  await open(page)
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('tree-')
  await page.getByRole('checkbox', { name: '选择进程 10', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择进程 11', exact: true }).click()
  await page.getByRole('columnheader').getByRole('button', { name: '按PID排序', exact: true }).click()
  await expect(page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: /PID/ }) })).toHaveAttribute('aria-sort', 'ascending')
  await page.getByRole('button', { name: '刷新进程', exact: true }).click()
  await expect(page.locator('.process-footer')).toContainText('已选 2 项')
  await action(page, '结束进程树')
  await expect(page.locator('.process-confirm-list>div')).toHaveCount(3)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('columnheader').getByRole('button', { name: '按PID排序', exact: true }).click()
  await page.getByRole('columnheader').getByRole('button', { name: '按PID排序', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('')
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await page.getByRole('button', { name: '展开进程 10', exact: true }).click()
  await expect(page.locator('.process-row[data-pid="11"]')).toBeVisible()
})

test('uses the shared three-state headers, restores CPU priority and retains selection and details', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '暂停刷新', exact: true }).click()
  await page.evaluate(() => {
    const state = (window as any).monitorFixture.store.tabs.find((tab: any) => tab.kind === 'process').processes
    state.rows = state.rows.slice(0, 3).map((row: any, i: number) => ({ ...row, cpu: [20, null, 80][i], rss: [3000, 1000, 2000][i] }))
  })
  const ids = () => page.locator('.process-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-pid')))
  await expect.poll(ids).toEqual(['12', '10', '11'])
  await page.getByRole('checkbox', { name: '选择进程 10', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择进程 11', exact: true }).click()
  for (const label of ['进程', 'PID', '用户', 'CPU', '内存', '状态', '命令行']) {
    const button = page.getByRole('button', { name: `按${label}排序`, exact: true })
    const header = page.getByRole('columnheader').filter({ has: button })
    await button.scrollIntoViewIfNeeded()
    const bounds = (await button.boundingBox())!
    await button.click({ position: { x: bounds.width - 14, y: bounds.height / 2 }, modifiers: ['Shift'] })
    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(page.locator('.process-table-head [aria-sort="ascending"]')).toHaveCount(1)
    if (label === 'PID') await expect.poll(ids).toEqual(['10', '11', '12'])
    if (label === 'CPU') await expect.poll(ids).toEqual(['10', '12', '11'])
    await button.press('Space')
    await expect(header).toHaveAttribute('aria-sort', 'descending')
    if (label === 'PID') await expect.poll(ids).toEqual(['12', '11', '10'])
    if (label === 'CPU') await expect.poll(ids).toEqual(['12', '10', '11'])
    await button.press('Enter')
    await expect(header).toHaveAttribute('aria-sort', 'none')
    await expect(header.locator('svg')).toHaveCount(0)
    await expect.poll(ids).toEqual(['12', '10', '11'])
    await expect(page.locator('.process-footer')).toContainText('已选 2 项')
    await expect(page.locator('.process-detail')).toContainText('tree-child')
  }
  const handle = page.getByRole('separator', { name: '调整进程列宽', exact: true })
  await handle.focus()
  await handle.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '120')
  await handle.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '130')
  await expect(page.locator('.process-table-head [aria-sort="none"]')).toHaveCount(7)
  const selected = page.locator('.process-row[aria-selected="true"]').first()
  await expect(selected).toHaveCSS('background-color', 'rgb(9, 71, 113)')
  await page.evaluate(() => { (window as any).monitorFixture.store.focusedDock = 'terminal' })
  await expect(selected).toHaveCSS('background-color', 'rgb(55, 55, 61)')
  await expect(selected).toHaveCSS('height', '32px')
  await expect(selected).toHaveCSS('font-size', '13px')
})
