import { posixPaths } from '../files/path'

export const normalizeRemotePath = posixPaths.normalize
export const parentRemotePath = posixPaths.parent
export const joinRemotePath = posixPaths.join
export const basenameRemotePath = posixPaths.basename
export const isDescendantRemotePath = posixPaths.descendant
