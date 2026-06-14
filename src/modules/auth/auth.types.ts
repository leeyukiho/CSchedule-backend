import { DataTarget } from '../providers/provider.types'

export interface LoginSubmitRequest {
  contextId: string
  username?: string
  password?: string
  captcha?: string
  extra?: Record<string, unknown>
}

export interface LoginSubmitResponse {
  accountId: string
  sessionId?: string
  status: 'success' | 'cached' | 'need_webview_fetch'
  sessionReusable?: boolean
  sessionExpireAt?: string
  requiredFetchTargets?: DataTarget[]
  cacheId?: string
  parsedCount?: number
}
