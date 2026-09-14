import { describe, expect, it } from 'vitest'
import {
  cloneConnectionNodes,
  findSiblingNameConflict,
  nextCopyName,
  nodeInsideFolder,
  resolveCopyName,
  resolvePasteFolderId,
  siblingNames,
} from './connectionTree'
import type { FolderProfile, HostProfile } from '../stores/app'

const folders: FolderProfile[] = [
  { id: 'fa', name: 'Alpha', parentId: null },
  { id: 'fb', name: 'Beta', parentId: null },
  { id: 'fc', name: 'Nested', parentId: 'fa' },
]

const hosts: HostProfile[] = [
  { id: 'h1', name: 'web', address: '10.0.0.1', port: 22, username: 'root', folderId: null },
  { id: 'h2', name: 'db', address: '10.0.0.2', port: 22, username: 'root', folderId: 'fa' },
  { id: 'h3', name: 'cache', address: '10.0.0.3', port: 22, username: 'root', folderId: 'fc' },
]

describe('nextCopyName', () => {
  it('appends -copy to a plain name', () => {
    expect(nextCopyName('web')).toBe('web-copy')
  })
  it('increments a bare -copy suffix to -2', () => {
    expect(nextCopyName('web-copy')).toBe('web-copy-2')
  })
  it('increments -copy-N suffixes', () => {
    expect(nextCopyName('web-copy-2')).toBe('web-copy-3')
    expect(nextCopyName('web-copy-9')).toBe('web-copy-10')
  })
  it('appends -copy when the suffix is not numeric', () => {
    expect(nextCopyName('web-copy-x')).toBe('web-copy-x-copy')
  })
})

describe('resolveCopyName', () => {
  it('keeps the name when free', () => {
    expect(resolveCopyName('web', new Set())).toBe('web')
  })
  it('resolves the full -copy/-copy-N sequence', () => {
    const taken = new Set(['web', 'web-copy', 'web-copy-2'])
    expect(resolveCopyName('web', taken)).toBe('web-copy-3')
  })
  it('is case-sensitive', () => {
    expect(resolveCopyName('web', new Set(['Web']))).toBe('web')
  })
})

describe('siblingNames / findSiblingNameConflict', () => {
  it('collects names per kind at the given level', () => {
    expect(siblingNames(null, 'folder', folders, hosts)).toEqual(new Set(['Alpha', 'Beta']))
    expect(siblingNames('fa', 'host', folders, hosts)).toEqual(new Set(['db']))
  })
  it('finds a conflicting sibling excluding the moving item', () => {
    expect(findSiblingNameConflict('host', 'db', 'fa', folders, hosts)?.id).toBe('h2')
    expect(findSiblingNameConflict('host', 'db', 'fa', folders, hosts, 'h2')).toBeUndefined()
    expect(findSiblingNameConflict('folder', 'Alpha', null, folders, hosts)?.id).toBe('fa')
  })
})

describe('resolvePasteFolderId', () => {
  const clipboard = new Set(['folder:fc', 'host:h1'])
  it('pastes into a folder target', () => {
    expect(resolvePasteFolderId('folder:fa', new Set(), folders, hosts)).toBe('fa')
  })
  it('pastes as sibling of a host target', () => {
    expect(resolvePasteFolderId('host:h2', new Set(), folders, hosts)).toBe('fa')
    expect(resolvePasteFolderId('host:h1', new Set(), folders, hosts)).toBeNull()
  })
  it('resolves a clipboard item target to its parent', () => {
    expect(resolvePasteFolderId('folder:fc', clipboard, folders, hosts)).toBe('fa')
    expect(resolvePasteFolderId('host:h1', clipboard, folders, hosts)).toBeNull()
  })
  it('falls back to root without a target', () => {
    expect(resolvePasteFolderId(undefined, clipboard, folders, hosts)).toBeNull()
  })
})

describe('nodeInsideFolder', () => {
  it('detects nested hosts and folders', () => {
    expect(nodeInsideFolder('host:h3', 'fa', folders, hosts)).toBe(true)
    expect(nodeInsideFolder('folder:fc', 'fa', folders, hosts)).toBe(true)
    expect(nodeInsideFolder('host:h1', 'fa', folders, hosts)).toBe(false)
  })
})

describe('cloneConnectionNodes', () => {
  it('clones a host under the target folder', () => {
    const cloned = cloneConnectionNodes('host:h2', 'fb', 'db-copy', folders, hosts)
    expect(cloned?.folders).toEqual([])
    expect(cloned?.hosts).toHaveLength(1)
    expect(cloned?.hosts[0]).toMatchObject({ name: 'db-copy', folderId: 'fb', address: '10.0.0.2' })
    expect(cloned?.hosts[0].id).not.toBe('h2')
    expect(cloned?.credentialPairs).toEqual([{ from: 'h2', to: cloned!.hosts[0].id }])
    expect(cloned?.rootKey).toBe(`host:${cloned!.hosts[0].id}`)
  })
  it('deep-clones a folder subtree with remapped ids and unchanged inner names', () => {
    const cloned = cloneConnectionNodes('folder:fa', null, 'Alpha-copy', folders, hosts)
    expect(cloned?.folders).toHaveLength(2)
    expect(cloned?.hosts).toHaveLength(2)
    const root = cloned!.folders.find((folder) => folder.name === 'Alpha-copy')!
    const nested = cloned!.folders.find((folder) => folder.name === 'Nested')!
    expect(root.parentId).toBeNull()
    expect(nested.parentId).toBe(root.id)
    expect(cloned!.hosts.map((host) => host.name).sort()).toEqual(['cache', 'db'])
    expect(cloned!.hosts.every((host) => host.folderId === root.id || host.folderId === nested.id)).toBe(true)
    expect(cloned!.credentialPairs.map((pair) => pair.from).sort()).toEqual(['h2', 'h3'])
    expect(cloned?.rootKey).toBe(`folder:${root.id}`)
  })
})
