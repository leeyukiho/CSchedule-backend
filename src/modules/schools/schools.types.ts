import {
  DataAccessMode,
  DataTarget,
  LoginMode,
  CredentialSaveCapability,
  ProviderCapabilities,
  ProviderDataAccess,
  ProviderStatus,
  SchoolSyncStrategy,
} from '../providers/provider.types'

export type SchoolStatus =
  | 'catalog_only'
  | 'candidate'
  | 'researching'
  | 'beta'
  | 'enabled'
  | 'disabled'

export interface SchoolListItem {
  id: string
  name: string
  shortName?: string
  province?: string
  city?: string
  catalogCode?: string
  level?: string
  isPrivate?: boolean
  status: SchoolStatus
  enabled: boolean
  providerId?: string
  loginMode?: LoginMode
  dataAccess?: ProviderDataAccess
  capabilities: ProviderCapabilities
  credentialSave?: CredentialSaveCapability
  syncStrategy: SchoolSyncStrategy
  message?: string
}

export interface SchoolListResponse {
  items: SchoolListItem[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface LoginContextResponse {
  contextId: string
  mode: LoginMode
  fields: {
    name: string
    label: string
    type: 'text' | 'password' | 'captcha' | 'select' | 'hidden'
    required: boolean
    placeholder?: string
  }[]
  captcha?: {
    id: string
    imageBase64?: string
    refreshable: boolean
  }
  webview?: {
    url: string
    successUrlPatterns: string[]
    failureUrlPatterns?: string[]
    callbackMode: 'session_import' | 'webview_client_fetch' | 'manual_confirm'
    requiredFetchTargets?: DataTarget[]
    closeAfterCacheWritten: boolean
  }
  credentialSave?: CredentialSaveCapability
  syncStrategy: SchoolSyncStrategy
  expireAt: string
}

export interface SchoolCatalogSeed {
  id: string
  name: string
  shortName?: string
  province?: string
  city?: string
  enabled: boolean
  status: SchoolStatus
  providerId?: string
  loginMode?: LoginMode
  dataAccess?: ProviderDataAccess
  capabilities: ProviderCapabilities
  providerStatus?: ProviderStatus
  authUrl?: string
  config?: unknown
}

export const EMPTY_DATA_ACCESS: ProviderDataAccess = {
  course: [],
  score: [],
  exam: [],
  profile: [],
}

export const EMPTY_CAPABILITIES: ProviderCapabilities = {
  course: false,
  score: false,
  exam: false,
  profile: false,
}

export function createDataAccess(
  course: DataAccessMode[] = [],
  score: DataAccessMode[] = [],
  exam: DataAccessMode[] = [],
  profile: DataAccessMode[] = [],
): ProviderDataAccess {
  return { course, score, exam, profile }
}
