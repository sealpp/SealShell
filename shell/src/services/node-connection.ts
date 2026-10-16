import { NativeConnection } from '../native/connection'
import { readIdentity } from './storage'

/** SealShell supplies its saved identity and local gateway address. */
export class NodeConnection extends NativeConnection {
  constructor() {
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : '127.0.0.1'
    super({ endpoint: `ws://${host}:17373`, identity: readIdentity })
  }
}
