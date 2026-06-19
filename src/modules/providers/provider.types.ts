export type LoginMode =
  | 'direct_password'
  | 'password_captcha'
  | 'cas_simple'
  | 'cas_webview'
  | 'oauth_webview'
  | 'qrcode'

export type DataAccessMode =
  | 'cloud_worker'
  | 'webview_client_fetch'
  | 'session_import'
  | 'manual_import'

export type DataTarget = 'course' | 'score' | 'exam' | 'profile'

export type ProviderStatus =
  | 'candidate'
  | 'researching'
  | 'beta'
  | 'enabled'
  | 'disabled'
  | 'deprecated'

export type EduSystemType =
  | 'eams'
  | 'zf_jwglxt'
  | 'qiangzhi'
  | 'urp'
  | 'cas'
  | 'oauth'
  | 'custom'
  | 'unknown'

export type CredentialSaveMode =
  | 'none'
  | 'session_only'
  | 'session_refresh'
  | 'password_vault'

export type AccountStatus =
  | 'active'
  | 'need_login'
  | 'cached_only'
  | 'disabled'
  | 'unbound'

export interface ProviderCapabilities {
  course: boolean
  score: boolean
  exam: boolean
  profile: boolean
}

export interface ProviderDataAccess {
  course: DataAccessMode[]
  score: DataAccessMode[]
  exam: DataAccessMode[]
  profile: DataAccessMode[]
}

export interface FeatureCapability {
  target: DataTarget
  enabled: boolean
  accessModes: DataAccessMode[]
  requiredFetchTargets?: DataTarget[]
  status: 'unsupported' | 'researching' | 'beta' | 'enabled'
}

export type FeatureDisplayKind =
  | 'course_grid'
  | 'profile_fields'
  | 'score_semesters'
  | 'exam_list'
  | 'raw'

export interface FeatureDisplayField {
  key: string
  label: string
  visible?: boolean
  editable?: boolean
  primary?: boolean
  fallbackKeys?: string[]
}

export interface FeatureDisplayConfig {
  title?: string
  kind?: FeatureDisplayKind
  summaryFields?: FeatureDisplayField[]
  detailFields?: FeatureDisplayField[]
  editableFields?: FeatureDisplayField[]
  itemFields?: FeatureDisplayField[]
  itemPath?: string
  groupPath?: string
  emptyText?: string
}

export interface SectionTimeConfig {
  section: number
  start: string
  end: string
}

export type FeatureDisplayMap = Partial<
  Record<DataTarget, FeatureDisplayConfig>
>

export interface AuthCapability {
  captchaRequired: boolean
  webviewRequired: boolean
  sessionImportSupported: boolean
  webviewClientFetchSupported: boolean
  passwordStorageAllowed: boolean
}

export type CaptchaKind =
  | 'none'
  | 'image'
  | 'math_image'
  | 'slider'
  | 'sms'
  | 'qrcode'
  | 'unknown'

export interface ProviderAuthConfig {
  captchaRequired: boolean
  captchaKind: CaptchaKind
  uiPreset?: 'password' | 'password_captcha' | 'webview' | 'qrcode'
  passwordTransform?: 'plain' | 'rsa_public_key' | 'sha1_salt' | 'custom'
  fields?: LoginField[]
  captcha?: Partial<CaptchaDescriptor> & {
    kind?: CaptchaKind
    imageEndpoint?: string
  }
  webview?: Partial<WebviewLoginDescriptor>
}

export interface CredentialPolicy {
  saveMode: CredentialSaveMode
  userConsentRequired: boolean
  maxSessionTtlMinutes: number
  maxPasswordTtlDays?: number
  autoRefreshAllowed: boolean
  backgroundRefreshTargets: DataTarget[]
  requiresReauthOnFailure: boolean
  adminNote?: string
}

export type AutoSyncCapability =
  | 'manual_only'
  | 'password_login'
  | 'password_login_may_need_verification'

export type ImportMode = 'password_server' | 'webview_cloud' | 'manual_import'
export type SyncMode = 'cloud_worker' | 'manual_webview'

export interface CloudSyncFunctionConfig {
  functionName?: string
  url?: string
}

export type CloudSyncFunctionMap = Partial<
  Record<DataTarget, CloudSyncFunctionConfig>
>

export interface SchoolSyncStrategy {
  importMode: ImportMode
  syncMode: SyncMode
  cloudFunctions?: CloudSyncFunctionMap
  cloudParserRequired: boolean
  localCachePreferred: boolean
  scheduledSyncSupported: boolean
  passwordVaultRequired: boolean
  passwordVaultOptional?: boolean
  manualSyncRequired: boolean
  reason?: string
}

export interface CredentialSaveCapability {
  passwordVaultAllowed: boolean
  autoSync: AutoSyncCapability
  scheduledSyncSupported?: boolean
  title?: string
  notice: string
  consentLabel: string
}

export interface LoginField {
  name: string
  label: string
  type: 'text' | 'password' | 'captcha' | 'select' | 'hidden'
  required: boolean
  placeholder?: string
}

export interface CaptchaDescriptor {
  id: string
  imageBase64?: string
  refreshable: boolean
}

export interface WebviewLoginDescriptor {
  url: string
  successUrlPatterns: string[]
  failureUrlPatterns?: string[]
  callbackMode: 'session_import' | 'webview_client_fetch' | 'manual_confirm'
  requiredFetchTargets?: DataTarget[]
  closeAfterCacheWritten: boolean
}

export interface SchoolProviderMeta {
  id: string
  name: string
  shortName?: string
  providerId: string
  loginMode: LoginMode
  dataAccess: ProviderDataAccess
  eduSystemType?: EduSystemType
  capabilities: ProviderCapabilities
  auth?: AuthCapability
  credentialSave?: CredentialSaveCapability
  featureDisplay?: FeatureDisplayMap
  sectionTimes?: SectionTimeConfig[]
  status?: ProviderStatus
  verifiedAt?: string
}

export interface SchoolProvider {
  id: string
  meta: SchoolProviderMeta
}
