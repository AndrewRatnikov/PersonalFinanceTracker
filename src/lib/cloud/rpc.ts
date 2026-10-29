// The rpc transport types and the one error class every cloud client rejects
// with. Shared by api.ts (the sync server client) and the Family space
// client, so the Family client never has to import api.ts (decision D7).
// api.ts re-exports all of it, so `@/lib/cloud/api` imports keep working.

import type { CloudErrorCode } from './types'

export interface RpcError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

export interface RpcResponse {
  data: unknown
  error: RpcError | null
  status?: number
}

export type RpcFn = (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<RpcResponse>

export class CloudError extends Error {
  readonly code: CloudErrorCode

  constructor(code: CloudErrorCode, message: string = code) {
    super(message)
    this.name = 'CloudError'
    this.code = code
  }
}
