import type { FolderProfile, HostProfile } from '../stores/app'
import { randomId } from '../utils/id'
import { moveTreeNodes } from './storage'

export type TreeNodeKind = 'folder' | 'host'

export interface TreeNode {
  kind: TreeNodeKind
  id: string
  parentId: string | null
  label: string
  host?: HostProfile
  folder?: FolderProfile
  depth: number
  hasChildren: boolean
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function nodeKey(kind: TreeNodeKind, id: string): string {
  return `${kind}:${id}`
}

export function parseNodeKey(key: string): { kind: TreeNodeKind; id: string } | undefined {
  const separator = key.indexOf(':')
  if (separator <= 0) return undefined
  const kind = key.slice(0, separator)
  if (kind !== 'folder' && kind !== 'host') return undefined
  return { kind, id: key.slice(separator + 1) }
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
  return collator.compare(left.label, right.label) || left.id.localeCompare(right.id)
}

export function buildVisibleNodes(
  folders: FolderProfile[],
  hosts: HostProfile[],
  expandedFolderIds: Set<string>,
): TreeNode[] {
  const result: TreeNode[] = []
  const folderByParent = new Map<string | null, FolderProfile[]>()
  const hostByParent = new Map<string | null, HostProfile[]>()
  for (const folder of folders) {
    const parent = folders.some((candidate) => candidate.id === folder.parentId) ? folder.parentId : null
    const siblings = folderByParent.get(parent) ?? []
    siblings.push(folder)
    folderByParent.set(parent, siblings)
  }
  for (const host of hosts) {
    const parent = host.folderId && folders.some((folder) => folder.id === host.folderId) ? host.folderId : null
    const siblings = hostByParent.get(parent) ?? []
    siblings.push(host)
    hostByParent.set(parent, siblings)
  }

  function append(parentId: string | null, depth: number) {
    const folderChildren = folderByParent.get(parentId) ?? []
    const hostChildren = hostByParent.get(parentId) ?? []
    const children: TreeNode[] = [
      ...folderChildren.map((folder) => ({
        kind: 'folder' as const,
        id: folder.id,
        parentId: folder.parentId,
        label: folder.name,
        folder,
        depth,
        hasChildren: (folderByParent.get(folder.id)?.length ?? 0) + (hostByParent.get(folder.id)?.length ?? 0) > 0,
      })),
      ...hostChildren.map((host) => ({
        kind: 'host' as const,
        id: host.id,
        parentId: host.folderId,
        label: host.name.trim() || host.address,
        host,
        depth,
        hasChildren: false,
      })),
    ]
    children.sort(compareNodes)
    for (const child of children) {
      result.push(child)
      if (child.kind === 'folder' && expandedFolderIds.has(child.id)) append(child.id, depth + 1)
    }
  }

  append(null, 0)
  return result
}

export function collectFolderDescendants(folderIds: string[], folders: FolderProfile[]): Set<string> {
  const collected = new Set(folderIds)
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId !== null && collected.has(folder.parentId) && !collected.has(folder.id)) {
        collected.add(folder.id)
        changed = true
      }
    }
  }
  return collected
}

export function collectFolderHostIds(folderIds: Set<string>, hosts: HostProfile[]): string[] {
  return hosts.filter((host) => host.folderId !== null && folderIds.has(host.folderId)).map((host) => host.id)
}

export function normalizeMoveSelection(
  selectedNodeIds: Set<string>,
  folders: FolderProfile[],
  hosts: HostProfile[],
): Set<string> {
  const selected = new Set(selectedNodeIds)
  const selectedFolders = new Set<string>()
  for (const key of selected) {
    const parsed = parseNodeKey(key)
    if (parsed?.kind === 'folder') selectedFolders.add(parsed.id)
  }
  const normalized = new Set<string>()
  for (const key of selected) {
    const parsed = parseNodeKey(key)
    if (!parsed) continue
    if (parsed.kind === 'folder') {
      let parent = folders.find((folder) => folder.id === parsed.id)?.parentId ?? null
      let nested = false
      while (parent !== null) {
        if (selectedFolders.has(parent)) {
          nested = true
          break
        }
        parent = folders.find((folder) => folder.id === parent)?.parentId ?? null
      }
      if (!nested) normalized.add(key)
      continue
    }
    let parent = hosts.find((host) => host.id === parsed.id)?.folderId ?? null
    let nested = false
    while (parent !== null) {
      if (selectedFolders.has(parent)) {
        nested = true
        break
      }
      parent = folders.find((folder) => folder.id === parent)?.parentId ?? null
    }
    if (nested) continue
    normalized.add(key)
  }
  return normalized
}

export function canMoveToFolder(
  selectedNodeIds: Set<string>,
  targetFolderId: string | null,
  folders: FolderProfile[],
): boolean {
  if (targetFolderId === null) return true
  const selectedFolders = new Set<string>()
  for (const key of selectedNodeIds) {
    const parsed = parseNodeKey(key)
    if (parsed?.kind === 'folder') selectedFolders.add(parsed.id)
  }
  let current: string | null = targetFolderId
  while (current !== null) {
    if (selectedFolders.has(current)) return false
    current = folders.find((folder) => folder.id === current)?.parentId ?? null
  }
  return true
}

const COPY_NAME_PATTERN = /^(.+-copy)(?:-(\d+))?$/

export function nextCopyName(name: string): string {
  const match = COPY_NAME_PATTERN.exec(name)
  if (match) return `${match[1]}-${match[2] ? Number(match[2]) + 1 : 2}`
  return `${name}-copy`
}

export function resolveCopyName(name: string, taken: ReadonlySet<string>): string {
  let candidate = name
  while (taken.has(candidate)) candidate = nextCopyName(candidate)
  return candidate
}

export function nodeParentId(key: string, folders: FolderProfile[], hosts: HostProfile[]): string | null {
  const parsed = parseNodeKey(key)
  if (!parsed) return null
  if (parsed.kind === 'folder') return folders.find((folder) => folder.id === parsed.id)?.parentId ?? null
  return hosts.find((host) => host.id === parsed.id)?.folderId ?? null
}

export function resolvePasteFolderId(
  targetKey: string | undefined,
  clipboardKeys: ReadonlySet<string>,
  folders: FolderProfile[],
  hosts: HostProfile[],
): string | null {
  if (!targetKey) return null
  const parsed = parseNodeKey(targetKey)
  if (!parsed) return null
  if (clipboardKeys.has(targetKey)) return nodeParentId(targetKey, folders, hosts)
  if (parsed.kind === 'folder') return folders.some((folder) => folder.id === parsed.id) ? parsed.id : null
  return hosts.find((host) => host.id === parsed.id)?.folderId ?? null
}

export function siblingNames(
  parentId: string | null,
  kind: TreeNodeKind,
  folders: FolderProfile[],
  hosts: HostProfile[],
): Set<string> {
  if (kind === 'folder') {
    return new Set(folders.filter((folder) => folder.parentId === parentId).map((folder) => folder.name))
  }
  return new Set(hosts.filter((host) => host.folderId === parentId).map((host) => host.name))
}

export function findSiblingNameConflict(
  kind: TreeNodeKind,
  name: string,
  parentId: string | null,
  folders: FolderProfile[],
  hosts: HostProfile[],
  excludeId?: string,
): FolderProfile | HostProfile | undefined {
  if (kind === 'folder') {
    return folders.find((folder) => folder.id !== excludeId && folder.parentId === parentId && folder.name === name)
  }
  return hosts.find((host) => host.id !== excludeId && host.folderId === parentId && host.name === name)
}

export function nodeInsideFolder(key: string, folderId: string, folders: FolderProfile[], hosts: HostProfile[]): boolean {
  let parent = nodeParentId(key, folders, hosts)
  while (parent !== null) {
    if (parent === folderId) return true
    parent = folders.find((folder) => folder.id === parent)?.parentId ?? null
  }
  return false
}

export interface ClonedConnectionNodes {
  folders: FolderProfile[]
  hosts: HostProfile[]
  credentialPairs: { from: string; to: string }[]
  rootKey: string
}

export function cloneConnectionNodes(
  key: string,
  targetFolderId: string | null,
  rootName: string,
  folders: FolderProfile[],
  hosts: HostProfile[],
): ClonedConnectionNodes | undefined {
  const parsed = parseNodeKey(key)
  if (!parsed) return undefined
  if (parsed.kind === 'host') {
    const host = hosts.find((item) => item.id === parsed.id)
    if (!host) return undefined
    const id = randomId()
    return {
      folders: [],
      hosts: [{ ...host, id, name: rootName, folderId: targetFolderId }],
      credentialPairs: [{ from: host.id, to: id }],
      rootKey: nodeKey('host', id),
    }
  }
  const root = folders.find((item) => item.id === parsed.id)
  if (!root) return undefined
  const subtreeFolderIds = collectFolderDescendants([root.id], folders)
  const subtreeHostIds = new Set(collectFolderHostIds(subtreeFolderIds, hosts))
  const idMap = new Map<string, string>()
  for (const id of subtreeFolderIds) idMap.set(id, randomId())
  for (const id of subtreeHostIds) idMap.set(id, randomId())
  return {
    folders: folders
      .filter((folder) => subtreeFolderIds.has(folder.id))
      .map((folder) => ({
        ...folder,
        id: idMap.get(folder.id)!,
        name: folder.id === root.id ? rootName : folder.name,
        parentId: folder.id === root.id ? targetFolderId : idMap.get(folder.parentId!) ?? null,
      })),
    hosts: hosts
      .filter((host) => subtreeHostIds.has(host.id))
      .map((host) => ({ ...host, id: idMap.get(host.id)!, folderId: idMap.get(host.folderId!) ?? null })),
    credentialPairs: Array.from(subtreeHostIds, (id) => ({ from: id, to: idMap.get(id)! })),
    rootKey: nodeKey('folder', idMap.get(root.id)!),
  }
}

export async function moveNodes(
  selectedNodeIds: Set<string>,
  targetFolderId: string | null,
  folders: FolderProfile[],
  hosts: HostProfile[],
): Promise<Set<string>> {
  const normalized = normalizeMoveSelection(selectedNodeIds, folders, hosts)
  if (!canMoveToFolder(normalized, targetFolderId, folders)) throw new Error('不能将文件夹移动到自身或其子文件夹中')
  const folderIds: string[] = []
  const hostIds: string[] = []
  for (const key of normalized) {
    const parsed = parseNodeKey(key)
    if (!parsed) continue
    if (parsed.kind === 'folder') folderIds.push(parsed.id)
    else if (hosts.some((host) => host.id === parsed.id)) hostIds.push(parsed.id)
  }
  await moveTreeNodes(folderIds, hostIds, targetFolderId)
  return normalized
}
