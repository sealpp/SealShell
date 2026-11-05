import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyDesktopReconnect(page, { artifacts }) {
  const ids = await page.evaluate(() => {
    const { store, ws } = window.desktopFixture
    const host = store.hosts.find(host => host.id === 'desktop-fixture')
    return ['Reconnect first', 'Reconnect second'].map(label => {
      const tab = ws.addTab(host, 'fixture-password')
      tab.label = label
      return tab.id
    })
  })
  const remoteState = async () => JSON.parse(await readFile(join(artifacts, 'ssh-state.json'), 'utf8'))
  try {
    await page.waitForFunction(ids => ids.every(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'online'), ids)
    const dock = page.locator('.main-dock')
    const bounds = await dock.boundingBox()
    await page.locator('.terminal-tab').filter({ hasText: 'Reconnect second' }).dragTo(dock, {
      targetPosition: { x: bounds.width - 5, y: bounds.height / 2 },
    })
    await expect(page.locator('.main-dock .dv-groupview')).toHaveCount(2)
    const snapshot = () => page.evaluate(() => window.desktopFixture.store.tabs.map(tab => ({
      id: tab.id, sessionId: tab.sessionId, terminalId: tab.terminalId,
    })))
    let previous = await snapshot()
    for (const [index, id] of ids.entries()) {
      const remoteBefore = await remoteState()
      const group = page.locator('.main-dock .dv-groupview').nth(index)
      if (!index) await group.locator('.terminal-tab').filter({ hasText: 'Reconnect first' }).click()
      await group.locator('.xterm-screen').click()
      await group.locator('.xterm-helper-textarea').focus()
      await page.keyboard.press('Control+Shift+R')
      const old = previous.find(tab => tab.id === id)
      await page.waitForFunction(({ id, sessionId }) => {
        const tab = window.desktopFixture.store.tabs.find(tab => tab.id === id)
        return tab?.state === 'online' && tab.sessionId !== sessionId
      }, old)
      const current = await snapshot()
      expect(current.map(tab => tab.id)).toEqual(previous.map(tab => tab.id))
      expect(current.find(tab => tab.id === id).terminalId).toBe(old.terminalId)
      expect(current.filter(tab => tab.id !== id)).toEqual(previous.filter(tab => tab.id !== id))
      expect(await page.evaluate(async sessionId => {
        const { getSshSession } = await import('/src/services/ssh.ts')
        return !!getSshSession(sessionId)
      }, old.sessionId)).toBe(false)
      await expect.poll(async () => (await remoteState()).shell).toBe(remoteBefore.shell + 1)
      await expect.poll(async () => (await remoteState()).active_connections).toBe(remoteBefore.active_connections)
      await expect(page.locator('.main-dock .dv-groupview')).toHaveCount(2)
      await group.locator('.xterm-helper-textarea').focus()
      await page.keyboard.type(`echo reconnect-${index}`)
      await page.keyboard.press('Enter')
      await expect(group.locator('.xterm-rows')).toContainText(`reconnect-${index}`)
      previous = current
    }
    console.log('Desktop reconnect: Ctrl+Shift+R replaces only the focused SSH session, preserves split panes, closes old connections and accepts input')
  } finally {
    await page.evaluate(ids => window.desktopFixture.ws.closeTabs(ids), ids)
  }
}
