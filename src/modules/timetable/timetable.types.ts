import { AccountStatus, FeatureDisplayConfig } from '../providers/provider.types'

export interface AccountSessionSummary {
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  accountStatus: AccountStatus
}

export interface TimetableCacheResponse {
  accountId: string
  schoolId: string
  providerId: string
  termId?: string
  courses: unknown[]
  terms: unknown[]
  sectionTimes: unknown[]
  display?: FeatureDisplayConfig
  syncedAt?: string
  session: AccountSessionSummary
}
