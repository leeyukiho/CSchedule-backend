import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderRegistryService } from '../providers/provider-registry.service'
import {
  EMPTY_CAPABILITIES,
  EMPTY_DATA_ACCESS,
  LoginContextResponse,
  SchoolCatalogSeed,
  SchoolListResponse,
} from './schools.types'
import {
  CredentialSaveCapability,
  DataTarget,
  ProviderAuthConfig,
  SchoolSyncStrategy,
} from '../providers/provider.types'

@Injectable()
export class SchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistryService,
  ) {}

  async listSchools(
    keyword?: string,
    enabledOnly = true,
    limitInput?: number,
    offsetInput?: number,
  ): Promise<SchoolListResponse> {
    const text = keyword?.trim()
    const limit = Math.min(Math.max(Number(limitInput) || 50, 1), 100)
    const offset = Math.max(Number(offsetInput) || 0, 0)
    const where = text
      ? {
          OR: [
            { id: { contains: text, mode: 'insensitive' as const } },
            { name: { contains: text, mode: 'insensitive' as const } },
            { shortName: { contains: text, mode: 'insensitive' as const } },
            { province: { contains: text, mode: 'insensitive' as const } },
            { city: { contains: text, mode: 'insensitive' as const } },
            { providerId: { contains: text, mode: 'insensitive' as const } },
          ],
        }
      : undefined

    const statusFilter = enabledOnly
      ? { enabled: true, status: 'enabled' as const }
      : undefined

    const combinedWhere = where && statusFilter
      ? { AND: [where, statusFilter] }
      : (where || statusFilter)

    const [schools, total] = await this.prisma.$transaction([
      this.prisma.school.findMany({
        where: combinedWhere,
        orderBy: [{ enabled: 'desc' }, { status: 'asc' }, { name: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.school.count({
        where: combinedWhere,
      }),
    ])

    return {
      items: schools.map((school) => ({
        id: school.id,
        name: school.name,
        shortName: school.shortName ?? undefined,
        province: school.province ?? undefined,
        city: school.city ?? undefined,
        ...this.getCatalogInfo(school.config),
        status: school.status,
        enabled: school.enabled,
        providerId: school.providerId ?? undefined,
        loginMode: school.loginMode ?? undefined,
        dataAccess: this.asDataAccess(school.dataAccess),
        capabilities: this.asCapabilities(school.capabilities),
        credentialSave: this.getCredentialSaveCapability(
          school.providerId,
          school.config,
        ),
        syncStrategy: this.getSchoolSyncStrategy({
          providerId: school.providerId,
          dataAccess: this.asDataAccess(school.dataAccess),
          capabilities: this.asCapabilities(school.capabilities),
          config: school.config,
        }),
        message: this.getStatusMessage(school.enabled, school.status),
      })),
      total,
      limit,
      offset,
      hasMore: offset + schools.length < total,
    }
  }

  async createLoginContext(schoolId: string): Promise<LoginContextResponse> {
    const school = await this.findSchool(schoolId)
    this.assertSchoolAvailable(school)

    const loginMode = school.loginMode ?? 'direct_password'
    const authConfig = this.getAuthConfig(school.config)
    const credentialSave = this.getCredentialSaveCapability(
      school.providerId,
      school.config,
    )
    const dataAccess = this.asDataAccess(school.dataAccess)
    const capabilities = this.asCapabilities(school.capabilities)
    const syncStrategy = this.getSchoolSyncStrategy({
      providerId: school.providerId,
      dataAccess,
      capabilities,
      config: school.config,
    })
    const webview = this.createFrontendWebviewDescriptor(school, authConfig)
    const expireAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    if (loginMode === 'cas_webview' || loginMode === 'oauth_webview') {
      return {
        contextId: this.createContextId(school.id),
        mode: loginMode,
        fields: [],
        webview,
        credentialSave,
        syncStrategy,
        expireAt,
      }
    }

    let fields: LoginContextResponse['fields'] = [
      {
        name: 'username',
        label: '学号',
        type: 'text',
        required: true,
        placeholder: '请输入教务系统账号',
      },
      {
        name: 'password',
        label: '密码',
        type: 'password',
        required: true,
        placeholder: '请输入教务系统密码',
      },
    ]

    if (authConfig?.fields?.length) {
      fields = authConfig.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        placeholder: field.placeholder,
      }))
    }

    if (
      !fields.some((field) => field.type === 'captcha') &&
      (loginMode === 'password_captcha' || authConfig?.captchaRequired)
    ) {
      fields.push({
        name: 'captcha',
        label: '验证码',
        type: 'captcha',
        required: true,
        placeholder: '请输入图片验证码',
      })
    }

    return {
      contextId: this.createContextId(school.id),
      mode: loginMode,
      fields,
      webview,
      captcha:
        loginMode === 'password_captcha' || authConfig?.captchaRequired
          ? {
              id: authConfig?.captcha?.id || `${school.id}-captcha`,
              imageBase64: authConfig?.captcha?.imageBase64,
              refreshable: authConfig?.captcha?.refreshable ?? true,
            }
          : undefined,
      credentialSave,
      syncStrategy,
      expireAt,
    }
  }

  private createFrontendWebviewDescriptor(
    school: SchoolCatalogSeed,
    authConfig?: ProviderAuthConfig,
  ): LoginContextResponse['webview'] | undefined {
    const webview = authConfig?.webview
    const url = school.authUrl || webview?.url

    if (!url) {
      return undefined
    }

    return {
      url,
      successUrlPatterns: webview?.successUrlPatterns || ['.*'],
      failureUrlPatterns: webview?.failureUrlPatterns,
      callbackMode:
        webview?.callbackMode === 'manual_confirm'
          ? 'manual_confirm'
          : 'webview_client_fetch',
      requiredFetchTargets:
        webview?.requiredFetchTargets || this.getInitialFetchTargets(school.capabilities),
      closeAfterCacheWritten: webview?.closeAfterCacheWritten ?? true,
    }
  }

  private getInitialFetchTargets(capabilities: unknown): DataTarget[] {
    const source =
      capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
        ? (capabilities as Partial<Record<DataTarget, unknown>>)
        : {}

    if (source.course) {
      return ['course']
    }

    for (const target of ['profile', 'score', 'exam'] as DataTarget[]) {
      if (source[target]) {
        return [target]
      }
    }

    return ['course']
  }

  private async findSchool(schoolId: string): Promise<SchoolCatalogSeed> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    })

    if (school) {
      return {
        id: school.id,
        name: school.name,
        shortName: school.shortName ?? undefined,
        province: school.province ?? undefined,
        city: school.city ?? undefined,
        enabled: school.enabled,
        status: school.status,
        providerId: school.providerId ?? undefined,
        loginMode: school.loginMode ?? undefined,
        dataAccess: this.asDataAccess(school.dataAccess),
        capabilities: this.asCapabilities(school.capabilities),
        authUrl: school.authUrl ?? undefined,
        config: school.config,
      }
    }

    throw new NotFoundException('School not found')
  }

  private assertSchoolAvailable(school: SchoolCatalogSeed) {
    if (!school.enabled || school.status !== 'enabled') {
      throw new NotFoundException('School not available')
    }
  }

  private asCapabilities(value: unknown) {
    if (!value || typeof value !== 'object') {
      return EMPTY_CAPABILITIES
    }

    const source = value as Partial<typeof EMPTY_CAPABILITIES>

    return {
      course: Boolean(source.course),
      score: Boolean(source.score),
      exam: Boolean(source.exam),
      profile: Boolean(source.profile),
    }
  }

  private asDataAccess(value: unknown) {
    if (!value || typeof value !== 'object') {
      return EMPTY_DATA_ACCESS
    }

    const source = value as Partial<typeof EMPTY_DATA_ACCESS>

    return {
      course: Array.isArray(source.course) ? source.course : [],
      score: Array.isArray(source.score) ? source.score : [],
      exam: Array.isArray(source.exam) ? source.exam : [],
      profile: Array.isArray(source.profile) ? source.profile : [],
    }
  }

  private getCatalogInfo(value: unknown) {
    if (!value || typeof value !== 'object') {
      return {}
    }

    const catalog = (value as { catalog?: unknown }).catalog

    if (!catalog || typeof catalog !== 'object') {
      return {}
    }

    const source = catalog as {
      code?: unknown
      level?: unknown
      isPrivate?: unknown
    }

    return {
      catalogCode: typeof source.code === 'string' ? source.code : undefined,
      level: typeof source.level === 'string' ? source.level : undefined,
      isPrivate: typeof source.isPrivate === 'boolean' ? source.isPrivate : undefined,
    }
  }

  private getAuthConfig(value: unknown): ProviderAuthConfig | undefined {
    const config = this.asRecord(value)
    const provider = this.asRecord(config.provider)
    const auth = config.authConfig ?? provider.authConfig

    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return undefined
    }

    return auth as ProviderAuthConfig
  }

  private getCredentialSaveCapability(
    providerId: string | null | undefined,
    config: unknown,
  ): CredentialSaveCapability | undefined {
    if (providerId) {
      try {
        const providerCapability =
          this.providers.getProvider(providerId).meta.credentialSave

        if (providerCapability) {
          return providerCapability
        }
      } catch {
        // Provider metadata is optional; fall through to school config.
      }
    }

    const root = this.asRecord(config)
    const provider = this.asRecord(root.provider)
    const capability = root.credentialSave ?? provider.credentialSave

    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      return undefined
    }

    return this.asCredentialSaveCapability(capability)
  }

  private getSchoolSyncStrategy(input: {
    providerId?: string | null
    dataAccess: ReturnType<SchoolsService['asDataAccess']>
    capabilities: ReturnType<SchoolsService['asCapabilities']>
    config: unknown
  }): SchoolSyncStrategy {
    const credentialSave = this.getCredentialSaveCapability(
      input.providerId,
      input.config,
    )
    const canSavePassword =
      Boolean(credentialSave?.passwordVaultAllowed) &&
      credentialSave?.autoSync === 'password_login'
    const hasWebviewCourse = input.dataAccess.course.includes('webview_client_fetch')
    const hasManualImport = input.dataAccess.course.includes('manual_import')
    const supportsCourse = Boolean(input.capabilities.course)

    if (supportsCourse && (hasWebviewCourse || canSavePassword)) {
      return {
        importMode: 'webview_cloud',
        syncMode: canSavePassword ? 'cloud_worker' : 'manual_webview',
        cloudParserRequired: true,
        localCachePreferred: true,
        scheduledSyncSupported: canSavePassword,
        passwordVaultRequired: canSavePassword,
        manualSyncRequired: !canSavePassword,
        reason: canSavePassword
          ? 'First import uses frontend fetch and cloud parsing; saved credentials are used only for later auto-sync.'
          : 'WebView login requires user interaction and cannot be scheduled safely.',
      }
    }

    return {
      importMode: hasManualImport ? 'manual_import' : 'webview_cloud',
      syncMode: 'manual_webview',
      cloudParserRequired: true,
      localCachePreferred: true,
      scheduledSyncSupported: false,
      passwordVaultRequired: false,
      manualSyncRequired: true,
      reason: 'This school is configured for manual import only.',
    }
  }

  private getRegisteredProvider(providerId: string) {
    try {
      return this.providers.getProvider(providerId)
    } catch {
      return null
    }
  }

  private asCredentialSaveCapability(
    value: unknown,
  ): CredentialSaveCapability | undefined {
    const source = this.asRecord(value)

    if (
      typeof source.passwordVaultAllowed !== 'boolean' ||
      typeof source.autoSync !== 'string' ||
      typeof source.notice !== 'string' ||
      typeof source.consentLabel !== 'string'
    ) {
      return undefined
    }

    if (
      ![
        'manual_only',
        'password_login',
        'password_login_may_need_verification',
      ].includes(source.autoSync)
    ) {
      return undefined
    }

    return {
      passwordVaultAllowed: source.passwordVaultAllowed,
      autoSync: source.autoSync as CredentialSaveCapability['autoSync'],
      scheduledSyncSupported:
        typeof source.scheduledSyncSupported === 'boolean'
          ? source.scheduledSyncSupported
          : undefined,
      title: typeof source.title === 'string' ? source.title : undefined,
      notice: source.notice,
      consentLabel: source.consentLabel,
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private getStatusMessage(enabled: boolean, status: string) {
    if (enabled && status === 'enabled') {
      return undefined
    }

    if (status === 'researching') {
      return '学校适配调研中'
    }

    if (status === 'candidate') {
      return '已收录，待完成 Provider 验收'
    }

    if (status === 'catalog_only') {
      return '已收录至学校目录，暂未接入教务适配'
    }

    return '暂不可绑定'
  }

  private createContextId(schoolId: string) {
    return `${schoolId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}
