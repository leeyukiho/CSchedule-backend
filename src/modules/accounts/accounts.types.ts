import { AccountStatus } from '../providers/provider.types'

export interface StudentAccountSummary {
  id: string
  schoolId: string
  providerId: string
  displayName?: string
  status: AccountStatus
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  lastLoginAt?: string
  lastCachedAt?: string
  school?: {
    id: string
    name: string
    shortName?: string
  }
}
