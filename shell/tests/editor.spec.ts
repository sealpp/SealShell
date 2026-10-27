import { expect, test, type Page } from '@playwright/test'

const pane = (page: Page, id = 'python') => page.locator(`[data-editor-tab="${id}"]`)
async function content(page: Page, id = 'python') {
  return page.evaluate(id => (window as any).editorFixture.store.tabs.find((tab: any) => tab.id === id)?.editor.content, id)
}
async function replace(page: Page, text: string, id = 'python') {
  await pane(page, id).locator('.view-lines').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await expect.poll(() => content(page, id)).toBe(text)
}
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/editor-harness.html')
  await expect(pane(page).locator('.monaco-editor')).toBeVisible()
})

test('renders dark local syntax, line numbers, folding, Chinese find/replace and wrap controls', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(pane(page).locator('.line-numbers').first()).toHaveText('1')
  await expect.poll(() => page.evaluate(() => (window as any).editorFixture.store.tabs[0].editor.language)).toBe('python')
  await expect.poll(() => pane(page).locator('.view-lines span[class^="mtk"]').evaluateAll(spans => new Set(spans.map(span => getComputedStyle(span).color)).size)).toBeGreaterThan(2)
  await pane(page).getByRole('button', { name: '查找/替换', exact: true }).click()
  const find = pane(page).locator('.find-widget')
  await expect(find).toBeVisible()
  await expect(find).toHaveCSS('background-color', 'rgb(32, 32, 32)')
  await find.getByRole('textbox', { name: '查找', exact: true }).fill('message')
  await expect(pane(page).locator('.matchesCount')).toContainText('2')
  await page.keyboard.press('Escape')
  await pane(page).locator('.view-lines').click()
  await page.keyboard.press('Control+h')
  await expect(find.getByRole('textbox', { name: '替换', exact: true })).toBeVisible()
  await find.getByRole('textbox', { name: '替换', exact: true }).fill('greeting')
  await find.getByRole('button', { name: /全部替换/ }).click()
  await expect.poll(() => content(page)).toContain('return greeting')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    const { monaco } = await import('/src/services/editor/runtime.ts')
    await monaco.editor.getEditors()[0].getAction('editor.foldAll')!.run()
  })
  await expect(pane(page).locator('.view-line').filter({ hasText: 'return greeting' })).toHaveCount(0)
  await page.evaluate(async () => {
    const { monaco } = await import('/src/services/editor/runtime.ts')
    await monaco.editor.getEditors()[0].getAction('editor.unfoldAll')!.run()
  })
  await pane(page).locator('.view-lines').click()
  await page.keyboard.press('Alt+z')
  expect(await page.evaluate(async () => { const { monaco } = await import('/src/services/editor/runtime.ts'); return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.wordWrap) })).toBe('off')
  expect(errors).toEqual([])
})

for (const [name, viewport, deviceScaleFactor] of [
  ['desktop', { width: 1500, height: 900 }, 1],
  ['narrow at 150% DPI', { width: 780, height: 850 }, 1.5],
] as const) {
  test.describe(`find tooltips: ${name}`, () => {
    test.use({ viewport, deviceScaleFactor })

    test('keeps the close tooltip stable without covering its button', async ({ page }) => {
      await pane(page).getByRole('button', { name: '查找/替换', exact: true }).click()
      const find = pane(page).locator('.find-widget')
      const close = find.getByRole('button', { name: '关闭 (Escape)', exact: true })
      await close.hover()
      const tooltip = page.locator('.workbench-hover', { hasText: '关闭 (Escape)' })
      await expect(tooltip).toBeVisible()
      const stable = await tooltip.evaluate(async element => {
        const button = document.querySelector('.find-widget [aria-label="关闭 (Escape)"]')!
        const target = button.getBoundingClientRect()
        const start = performance.now()
        // Observe multiple mouse-out debounce intervals with the pointer stationary.
        while (performance.now() - start < 800) {
          await new Promise(requestAnimationFrame)
          const bounds = element.getBoundingClientRect()
          const hit = document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)
          if (!element.isConnected || !button.contains(hit)) return false
          if (bounds.bottom > target.top && bounds.top < target.bottom
            && bounds.right > target.left && bounds.left < target.right) return false
        }
        return true
      })
      expect(stable).toBe(true)
      // Click where the pointer has stayed; do not wait for a gap in a flickering tooltip.
      await page.mouse.down()
      await page.mouse.up()
      await expect(find).toHaveAttribute('aria-hidden', 'true')
      await expect(tooltip).toHaveCount(0)
      await pane(page).locator('.view-lines').click()
      await page.keyboard.press('Control+f')
      await expect(find).toHaveAttribute('aria-hidden', 'false')
      await page.keyboard.press('Escape')
      await expect(find).toHaveAttribute('aria-hidden', 'true')
    })
  })
}

test('keeps same-path files isolated, retains undo through hiding and releases models on close', async ({ page }) => {
  await replace(page, 'first_draft')
  await page.evaluate(() => (window as any).editorFixture.add('second', '/etc/setup.py', 'second host'))
  await expect(pane(page, 'second').locator('.monaco-editor')).toBeVisible()
  await replace(page, 'second_draft', 'second')
  await page.getByRole('button', { name: '切换底栏', exact: true }).click()
  await page.getByRole('button', { name: '切换底栏', exact: true }).click()
  const source = (await page.locator('.workspace-instance[data-tab-id="python"]').boundingBox())!
  const dock = (await page.locator('.workspace-category-view.active .workspace-dock').boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x - 30, source.y + source.height / 2, { steps: 4 })
  await page.mouse.move(dock.x + 10, dock.y + dock.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator('.editor-panel:visible')).toHaveCount(2)
  await expect.poll(() => pane(page).evaluate(el => Math.abs(el.querySelector('.monaco-editor')!.getBoundingClientRect().width - el.querySelector('.editor-host')!.getBoundingClientRect().width))).toBeLessThan(2)
  await expect(pane(page)).toBeVisible()
  await pane(page).locator('.view-lines').click()
  await page.keyboard.press('Control+z')
  await expect.poll(() => content(page)).toContain('def hello():')
  expect(await content(page, 'second')).toBe('second_draft')
  await pane(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '文件有未保存修改' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(pane(page)).toBeVisible()
  await pane(page).getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '不保存', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => { const { monaco } = await import('/src/services/editor/runtime.ts'); return monaco.editor.getModels().length })).toBe(1)
  await page.evaluate(() => (window as any).editorFixture.closeTabs(['second'], true))
  await expect.poll(() => page.evaluate(async () => { const { monaco } = await import('/src/services/editor/runtime.ts'); return monaco.editor.getModels().length })).toBe(0)
})

for (const deviceScaleFactor of [1, 1.5]) {
  test.describe(`editor layout at ${deviceScaleFactor * 100}% DPI`, () => {
    test.use({ viewport: { width: 1500, height: 900 }, deviceScaleFactor })

    test('keeps wrapping bounded while hidden and fits the resized pane on return', async ({ page }) => {
      await page.evaluate(() => (window as any).editorFixture.add('large', '/large.txt', 'a moderately long line with words for wrapping '.repeat(4).concat('\n').repeat(3000)))
      const large = pane(page, 'large')
      await expect(large.locator('.monaco-editor')).toBeVisible()
      const layout = () => page.evaluate(async () => {
        const { monaco } = await import('/src/services/editor/runtime.ts')
        const editor = monaco.editor.getEditors().find(view => view.getModel()?.uri.authority === 'large')!
        return { width: editor.getLayoutInfo().width, column: editor.getOption(monaco.editor.EditorOption.wrappingInfo).wrappingColumn }
      })
      await expect.poll(async () => (await layout()).column).toBeGreaterThan(20)
      const visible = await layout()
      await page.getByRole('tab', { name: '文件列表', exact: true }).click()
      await expect(large).toBeHidden()
      // Let ResizeObserver and the editor's deferred layout react to display:none.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await layout()).toEqual(visible)
      await page.setViewportSize({ width: 780, height: 850 })
      await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
      await expect.poll(async () => (await layout()).width).toBeLessThan(visible.width)
      await expect.poll(() => large.evaluate(el => Math.abs(el.querySelector('.monaco-editor')!.getBoundingClientRect().width - el.querySelector('.editor-host')!.clientWidth))).toBeLessThan(2)
      const resized = await layout()
      expect(resized.column).toBeGreaterThan(20)
      await page.getByRole('button', { name: '切换底栏', exact: true }).click()
      await expect(large).toBeHidden()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await layout()).toEqual(resized)
      await page.getByRole('button', { name: '切换底栏', exact: true }).click()
      await expect(large).toBeVisible()
      await large.locator('.view-lines').click()
      await page.keyboard.press('Alt+z')
      await expect.poll(async () => (await layout()).column).toBe(-1)
    })
  })
}

test('defers an editor whose chunk finishes loading while its pane is hidden', async ({ page }) => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route('**/src/services/editor/documents.ts', async route => { await blocked; await route.continue() })
  await page.goto('/tests/editor-harness.html')
  await expect(pane(page).getByRole('status')).toHaveText('正在加载编辑器…')
  await page.getByRole('tab', { name: '文件列表', exact: true }).click()
  release()
  await expect(pane(page).getByRole('status', { includeHidden: true })).toHaveCount(0)
  expect(await page.evaluate(async () => { const { monaco } = await import('/src/services/editor/runtime.ts'); return monaco.editor.getModels().length })).toBe(0)
  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await expect(pane(page).locator('.monaco-editor')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => {
    const { monaco } = await import('/src/services/editor/runtime.ts')
    return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.wrappingInfo).wrappingColumn
  })).toBeGreaterThan(20)
})

test('can close a tab while the editor chunk is still loading without creating an orphan model', async ({ page }) => {
  // Use a fresh navigation so the dynamic module is not already evaluated.
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route('**/src/services/editor/documents.ts', async route => { await blocked; await route.continue() })
  await page.goto('/tests/editor-harness.html')
  await expect(pane(page).getByRole('status')).toHaveText('正在加载编辑器…')
  await pane(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(pane(page)).toHaveCount(0)
  release()
  await expect.poll(() => page.evaluate(async () => { const { monaco } = await import('/src/services/editor/runtime.ts'); return monaco.editor.getModels().length })).toBe(0)
  await page.evaluate(() => (window as any).editorFixture.add('next', '/data.yaml', 'enabled: true'))
  await expect(pane(page, 'next').locator('.monaco-editor')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).editorFixture.store.tabs[0].editor.language)).toBe('yaml')
})

test('saves through Ctrl+S with BOM and line endings, and keeps failed saves editable', async ({ page }) => {
  await page.evaluate(() => { Object.assign((window as any).editorFixture.store.tabs[0].editor, { bom: true, lineEnding: '\r\n' }) })
  await replace(page, '你好\nsecond line\n')
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => (window as any).editorFixture.writes.length)).toBe(1)
  const saved = await page.evaluate(() => (window as any).editorFixture.writes[0].bytes)
  expect(saved).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('你好\r\nsecond line\r\n')])
  await expect(pane(page).getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await replace(page, 'unsaved')
  await page.evaluate(() => { (window as any).editorFixture.fail = true })
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('dialog', { name: '保存失败', exact: true })).toContainText('fixture save rejected')
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(pane(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  expect(await content(page)).toBe('unsaved')
})

test('reopens with another encoding and clears the discarded undo history', async ({ page }) => {
  await replace(page, 'discard this draft')
  await page.evaluate(() => {
    const f = (window as any).editorFixture
    f.files.get('python').set('/etc/setup.py', new Uint8Array([0xff, 0xfe, 65, 0, 13, 0, 10, 0, 66, 0]))
    void f.reopenEditorTab('python', 'utf-16le')
  })
  await page.getByRole('button', { name: '丢弃修改并重新打开', exact: true }).click()
  await expect.poll(() => content(page)).toBe('A\r\nB')
  await expect(pane(page).locator('.view-line').first()).toHaveText('A')
  await pane(page).locator('.view-lines').click()
  await page.keyboard.press('Control+z')
  expect(await content(page)).toBe('A\r\nB')
  await expect(pane(page).getByRole('button', { name: '保存', exact: true })).toBeDisabled()
})

test('preserves edits made during an in-flight save', async ({ page }) => {
  await replace(page, 'saved_snapshot')
  await page.evaluate(() => { (window as any).editorFixture.hold = true })
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => !!(window as any).editorFixture.release)).toBe(true)
  await replace(page, 'new_unsaved_changes')
  await page.evaluate(() => { const f = (window as any).editorFixture; f.hold = false; f.release() })
  await expect.poll(() => page.evaluate(() => (window as any).editorFixture.writes.length)).toBe(1)
  await expect(pane(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  expect(await content(page)).toBe('new_unsaved_changes')
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => (window as any).editorFixture.writes.length)).toBe(2)
  expect(await page.evaluate(() => new TextDecoder().decode(new Uint8Array((window as any).editorFixture.writes[1].bytes)))).toBe('new_unsaved_changes')
})

test('unregisters per-editor commands when panes close and keeps reopened shortcuts usable', async ({ page }) => {
  const commands = () => page.evaluate(() => (window as any).editorFixture.editorCommands())
  await expect.poll(commands).toHaveLength(2)
  for (let index = 0; index < 4; index++) {
    const id = index ? `reopened-${index}` : 'python'
    if (index) {
      await page.evaluate(id => (window as any).editorFixture.add(id, '/note.txt', 'original'), id)
      await expect(pane(page, id).locator('.monaco-editor')).toBeVisible()
    }
    await expect.poll(commands).toHaveLength(2)
    await replace(page, `saved-${index}`, id)
    await page.keyboard.press('Control+s')
    await expect(pane(page, id).getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await page.keyboard.press('Alt+z')
    expect(await page.evaluate(async () => {
      const { monaco } = await import('/src/services/editor/runtime.ts')
      return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.wordWrap)
    })).toBe('off')
    await pane(page, id).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(pane(page, id)).toHaveCount(0)
    await expect.poll(commands).toEqual([])
  }
})
