import { beforeEach, expect, it, vi } from 'vitest'
import { store, type Tab } from '../stores/app'
import { droppedFilePaths } from '../native/fileDrop'
import { enqueueUpload } from './sftp/transfer-runtime'
import { terminalUploadTarget, uploadTerminalFiles, isFileDrop } from './terminalFileDrop'

vi.mock('../native/fileDrop', () => ({ droppedFilePaths: vi.fn() }))
vi.mock('./sftp/transfer-runtime', () => ({ enqueueUpload: vi.fn() }))
vi.mock('./ssh', () => ({ getSshSession: (sessionId: string) => ({ sessionId, host: 'original.example', port: 2222, username: 'alice' }) }))

const tab = (id: string, cwd: string): Tab => ({ id, kind: 'terminal', label: id, state: 'online', error: '', sessionId: `${id}-session`, terminalId: id, encoding: 'utf-8', cwd })
beforeEach(() => {
  vi.clearAllMocks()
  store.tabs = [tab('left', '/srv/left'), tab('right', '/srv/right')]
  store.activeTerminalTabId = 'left'
})

it('freezes the drop pane and directory before native path resolution', async () => {
  let resolve!: (paths: string[]) => void
  vi.mocked(droppedFilePaths).mockReturnValue(new Promise(value => { resolve = value }))
  const target = terminalUploadTarget('right')
  const upload = uploadTerminalFiles(target, [])
  store.tabs[1].cwd = '/elsewhere'
  store.activeTerminalTabId = 'left'
  resolve(['C:\\项目\\folder', "C:\\项目\\a'b.txt"])
  await upload
  expect(target.destination).toBe('alice@original.example:2222:/srv/right')
  expect(enqueueUpload).toHaveBeenCalledWith(expect.stringContaining(target.destination), {
    sessionId: 'right-session', directory: '/srv/right', paths: ['C:\\项目\\folder', "C:\\项目\\a'b.txt"],
  })
})

it.each(['close', 'reconnect'])('rejects a %s before accepting the upload', async action => {
  let resolve!: (paths: string[]) => void
  vi.mocked(droppedFilePaths).mockReturnValue(new Promise(value => { resolve = value }))
  const upload = uploadTerminalFiles(terminalUploadTarget('left'), [])
  if (action === 'close') store.tabs.splice(0, 1)
  else store.tabs[0].sessionId = 'new-session'
  resolve(['C:\\file.txt'])
  await expect(upload).rejects.toThrow('已关闭或重连')
  expect(enqueueUpload).not.toHaveBeenCalled()
})

it.each([undefined, '', 'C:\\remote', '/bad\u0007path'])('refuses an unknown or unusable cwd (%s) without a fallback', cwd => {
  store.tabs[0].cwd = cwd
  expect(() => terminalUploadTarget('left')).toThrow('无法获取当前终端目录')
  expect(droppedFilePaths).not.toHaveBeenCalled()
  expect(enqueueUpload).not.toHaveBeenCalled()
})

it('keeps native path errors out of the transfer queue', async () => {
  vi.mocked(droppedFilePaths).mockRejectedValue(new Error('no source path'))
  await expect(uploadTerminalFiles(terminalUploadTarget('left'), [])).rejects.toThrow('no source path')
  expect(enqueueUpload).not.toHaveBeenCalled()
})

it('distinguishes file drops from existing internal drags and text', () => {
  for (const types of [['text/plain'], ['application/x-sealshell-files'], []]) {
    expect(isFileDrop({ dataTransfer: { types } } as unknown as DragEvent)).toBe(false)
  }
  expect(isFileDrop({ dataTransfer: { types: ['Files'] } } as unknown as DragEvent)).toBe(true)
})
