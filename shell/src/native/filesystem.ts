import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { FsRequestSchema, type FsResponse } from './proto/seal_pb'
import type { NativeConnection } from './connection'
import { NativeError } from './errors'

export class NativeFileSystem {
  constructor(private readonly connection: NativeConnection) {}

  async request(operation: MessageInitShape<typeof FsRequestSchema>['operation']): Promise<FsResponse['result']> {
    const response = await this.connection.request({ case: 'fsRequest', value: create(FsRequestSchema, { operation }) })
    if (response.body.case !== 'fsResponse') throw new Error('Unexpected native filesystem response')
    const result = response.body.value.result
    if (result.case === 'error') throw new NativeError(result.value.code, result.value.message)
    return result
  }
}
