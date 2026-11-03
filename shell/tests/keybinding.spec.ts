import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/keybinding-harness.html')
})

test('dispatches a registered Mod binding and formats its label', async ({ page }) => {
  await expect(page.locator('#label')).toHaveText('Ctrl+K')
  await page.keyboard.press('Control+K')
  await expect(page.locator('#count')).toHaveText('1')
})

test('does not dispatch global bindings from text inputs', async ({ page }) => {
  await page.locator('#input').focus()
  await page.keyboard.press('Control+K')
  await expect(page.locator('#count')).toHaveText('0')

  await page.locator('#editable').focus()
  await page.keyboard.press('Control+K')
  await expect(page.locator('#count')).toHaveText('0')
})

test('does not dispatch global bindings from a terminal embedded in a dialog', async ({ page }) => {
  await page.locator('#input').evaluate(input => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const terminal = document.createElement('div')
    terminal.className = 'shell-terminal'
    dialog.append(terminal)
    input.before(dialog)
    terminal.append(input)
  })
  await page.locator('#input').focus()
  await page.keyboard.press('Control+K')
  await expect(page.locator('#count')).toHaveText('0')
})
