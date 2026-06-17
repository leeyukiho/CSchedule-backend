import { AccountStatus } from '../providers/provider.types'
import { SchoolSyncStrategy } from '../providers/provider.types'

export interface StudentAccountSummary {
  id: string
  schoolId: string
  providerId: string
  displayName?: string
  status: AccountStatus
  credentialSaveMode?: 'none' | 'session_only' | 'session_refresh' | 'password_vault'
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  lastLoginAt?: string
  lastCachedAt?: string
  syncStrategy?: SchoolSyncStrategy
  school?: {
    id: string
    name: string
    shortName?: string
  }
}
