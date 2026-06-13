import { BindingStatus } from '../providers/provider.types'

export interface BindingSessionSummary {
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  bindingStatus: BindingStatus
}

export interface TimetableCacheResponse {
  bindingId: string
  schoolId: string
  providerId: string
  termId?: string
  courses: unknown[]
  terms: unknown[]
  sectionTimes: unknown[]
  syncedAt?: string
  session: BindingSessionSummary
}
