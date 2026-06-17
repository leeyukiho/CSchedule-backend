import { AccountStatus, FeatureDisplayConfig } from '../providers/provider.types'

export interface AccountSessionSummary {
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  accountStatus: AccountStatus
}

export interface TimetableCacheDataResponse {
  accountId: string
  schoolId: string
  providerId: string
  termId?: string
  courses: unknown[]
  terms: unknown[]
  sectionTimes: unknown[]
  display?: FeatureDisplayConfig
  sourceHash?: string
  notModified?: boolean
  syncedAt?: string
  session: AccountSessionSummary
}

export interface TimetableNotModifiedResponse {
  termId?: string
  sourceHash?: string
  notModified: true
  syncedAt?: string
}

export type TimetableCacheResponse =
  | TimetableCacheDataResponse
  | TimetableNotModifiedResponse
