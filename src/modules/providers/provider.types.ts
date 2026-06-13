export type LoginMode =
  | 'direct_password'
  | 'password_captcha'
  | 'cas_simple'
  | 'cas_webview'
  | 'oauth_webview'
  | 'qrcode'

export type DataAccessMode =
  | 'server_session'
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

export type BindingStatus =
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

export interface LoginContext {
  id: string
  schoolId: string
  mode: LoginMode
  fields: LoginField[]
  state: Record<string, unknown>
  captcha?: CaptchaDescriptor
  webview?: WebviewLoginDescriptor
  expireAt: string
}

export interface SubmitLoginInput {
  contextId: string
  username?: string
  password?: string
  captcha?: string
  extra?: Record<string, unknown>
}

export interface LoginResult {
  bindingStatus: BindingStatus
  sessionReusable: boolean
  sessionRefreshable: boolean
  sessionExpireAt?: string
  requiredFetchTargets?: DataTarget[]
  sessionSnapshot?: unknown
  parsed?: Partial<Record<DataTarget, unknown>>
}

export interface SessionValidationResult {
  valid: boolean
  reusable: boolean
  refreshable: boolean
  expireAt?: string
  errorCode?: string
}

export interface LoginStrategy {
  mode: LoginMode
  createContext(input: { schoolId: string; providerConfig?: Record<string, unknown> }): Promise<LoginContext>
  submit?(input: SubmitLoginInput): Promise<LoginResult>
  importSession?(input: unknown): Promise<LoginResult>
  validateSession(session: unknown): Promise<SessionValidationResult>
  refreshSession?(session: unknown): Promise<unknown>
  logout?(session: unknown): Promise<void>
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
  status?: ProviderStatus
  verifiedAt?: string
}

export interface SchoolProvider {
  id: string
  meta: SchoolProviderMeta
  login?: LoginStrategy
  course?: CourseConnector
  score?: unknown
  exam?: unknown
  profile?: unknown
}

export interface ProviderTerm {
  id: string
  title?: string
  label?: string
  selected?: boolean
}

export interface ProviderCourse {
  id?: string
  name: string
  teacher?: string
  location?: string
  classroom?: string
  weekday: number
  sections?: number[]
  startSection?: number
  endSection?: number
  weeks: number[]
  rawWeeks?: string
  campus?: string
  remark?: string
  source?: unknown
}

export interface ProviderProfile {
  name?: string
  studentId?: string
  className?: string
  major?: string
}

export interface ProviderSchedule {
  term?: string
  selectedSemesterId?: string
  semesters?: ProviderTerm[]
  courses: ProviderCourse[]
  sectionTimes?: unknown[]
}

export interface CourseFetchResult {
  schedule: ProviderSchedule
  profile?: ProviderProfile | null
}

export interface CourseConnector {
  fetchByCredentials(input: {
    username: string
    password: string
    semesterId?: string
    providerConfig?: Record<string, unknown>
  }): Promise<CourseFetchResult>
}
