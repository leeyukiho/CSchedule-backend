import { BindingStatus } from '../providers/provider.types'

export interface BindingSummary {
  id: string
  userId: string
  schoolId: string
  providerId: string
  displayName?: string
  status: BindingStatus
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

