import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { DataAccessMode, LoginMode, Prisma, SchoolStatus } from '@prisma/client'

export interface AdminSchoolUpdateInput {
  name?: string
  shortName?: string | null
  status?: SchoolStatus
  enabled?: boolean
  loginMode?: LoginMode | null
  authUrl?: string | null
  homepageUrl?: string | null
  providerId?: string | null
  eduSystemType?: string | null
  capabilities?: Record<string, boolean>
  dataAccess?: Partial<Record<'course' | 'score' | 'exam' | 'profile', DataAccessMode[]>>
  authConfig?: Record<string, unknown> | null
  providerConfig?: Record<string, unknown> | null
  providerStatus?: SchoolStatus
  termStarts?: Record<string, string>
  note?: string
}

export interface AdminProviderConfigUpsertInput {
  providerId: string
  loginMode: LoginMode
  dataAccess?: Partial<Record<'course' | 'score' | 'exam' | 'profile', DataAccessMode[]>>
  capabilities?: Record<string, boolean>
  eduSystemType?: string | null
  credentialPolicy?: Record<string, unknown>
  providerConfig?: Record<string, unknown>
  featureConfig?: Record<string, unknown>
  authConfig?: Record<string, unknown>
  limits?: Record<string, unknown> | null
  status?: SchoolStatus
  verifiedAt?: string | null
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listAllSchools(params: {
    keyword?: string
    status?: SchoolStatus
    enabled?: boolean
    limit?: number
    offset?: number
  }) {
    const { keyword, status, enabled, limit = 50, offset = 0 } = params
    const where: Record<string, unknown> = {}

    if (keyword) {
      where.OR = [
        { id: { contains: keyword, mode: 'insensitive' } },
        { name: { contains: keyword, mode: 'insensitive' } },
        { shortName: { contains: keyword, mode: 'insensitive' } },
        { province: { contains: keyword, mode: 'insensitive' } },
        { city: { contains: keyword, mode: 'insensitive' } },
      ]
    }
    if (status) where.status = status
    if (enabled !== undefined) where.enabled = enabled

    const [schools, total] = await this.prisma.$transaction([
      this.prisma.school.findMany({
        where: where as any,
        orderBy: [{ enabled: 'desc' }, { status: 'asc' }, { name: 'asc' }],
        take: Math.min(limit, 200),
        skip: offset,
      }),
      this.prisma.school.count({ where: where as any }),
    ])

    return {
      items: schools.map((school) => ({
        ...school,
        termStarts: this.getTermStarts(school.config),
      })),
      total,
      limit,
      offset,
      hasMore: offset + schools.length < total,
    }
  }

  async updateSchool(schoolId: string, input: AdminSchoolUpdateInput) {
    const data: Record<string, unknown> = {}
    if (input.name !== undefined) data.name = input.name
    if (input.shortName !== undefined) data.shortName = input.shortName
    if (input.status !== undefined) {
      data.status = input.status
      data.enabled = input.status === 'enabled'
    } else if (input.enabled !== undefined) {
      data.enabled = input.enabled
      data.status = input.enabled ? 'enabled' : 'disabled'
    }
    if (input.loginMode !== undefined) data.loginMode = input.loginMode
    if (input.authUrl !== undefined) data.authUrl = input.authUrl
    if (input.homepageUrl !== undefined) data.homepageUrl = input.homepageUrl
    if (input.providerId !== undefined) data.providerId = input.providerId
    if (input.eduSystemType !== undefined) data.eduSystemType = input.eduSystemType
    if (input.capabilities !== undefined) data.capabilities = this.toJson(input.capabilities)
    if (input.dataAccess !== undefined) data.dataAccess = this.toJson(input.dataAccess)

    if (
      input.note ||
      input.authConfig !== undefined ||
      input.providerConfig !== undefined ||
      input.termStarts !== undefined
    ) {
      data.config = await this.mergeSchoolConfig(schoolId, {
        note: input.note,
        authConfig: input.authConfig,
        providerConfig: input.providerConfig,
        termStarts: input.termStarts,
      })
    }

    const school = await this.prisma.school.update({
      where: { id: schoolId },
      data: data as any,
    })

    return school
  }

  async upsertProviderConfig(
    schoolId: string,
    input: AdminProviderConfigUpsertInput,
  ) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } })

    if (!school) {
      throw new NotFoundException('School not found')
    }

    const providerConfig = {
      ...(input.providerConfig || {}),
      ...(input.authConfig ? { authConfig: input.authConfig } : {}),
      ...(input.credentialPolicy ? { credentialPolicy: input.credentialPolicy } : {}),
      ...(input.featureConfig ? { featureConfig: input.featureConfig } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    }
    const capabilities = input.capabilities ?? (school.capabilities as Record<string, boolean>) ?? {}
    const dataAccess = input.dataAccess ?? (school.dataAccess as Record<string, unknown>) ?? {}
    const status = input.status ?? school.status
    const verifiedAt = input.verifiedAt ? new Date(input.verifiedAt) : undefined

    return this.prisma.school.update({
      where: { id: schoolId },
      data: {
        providerId: input.providerId,
        loginMode: input.loginMode,
        dataAccess: this.toJson(dataAccess),
        capabilities: this.toJson(capabilities),
        eduSystemType: input.eduSystemType ?? school.eduSystemType,
        status,
        enabled: status === 'enabled',
        ...(verifiedAt ? { verifiedAt } : {}),
        config: await this.mergeSchoolConfig(schoolId, {
          authConfig: input.authConfig,
          providerConfig,
        }),
      },
    })
  }

  async listSubmissions(params: {
    status?: string
    limit?: number
    offset?: number
  }) {
    const { status, limit = 50, offset = 0 } = params
    const where: Record<string, unknown> = {}
    if (status) where.status = status

    const [submissions, total] = await this.prisma.$transaction([
      this.prisma.schoolAccessSubmission.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      this.prisma.schoolAccessSubmission.count({ where: where as any }),
    ])

    return {
      items: submissions,
      total,
      limit,
      offset,
      hasMore: offset + submissions.length < total,
    }
  }

  async updateSubmission(submissionId: string, input: {
    status?: string
    review?: Record<string, unknown>
  }) {
    const data: Record<string, unknown> = {}
    if (input.status) data.status = input.status
    if (input.review) data.review = input.review

    return this.prisma.schoolAccessSubmission.update({
      where: { id: submissionId },
      data: data as any,
    })
  }

  async listFeedback(params: {
    status?: string
    limit?: number
    offset?: number
  }) {
    const { status, limit = 50, offset = 0 } = params
    const where: Record<string, unknown> = {}
    if (status) where.status = status

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedbackItem.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      this.prisma.feedbackItem.count({ where: where as any }),
    ])
    const accountIds = [...new Set(items.map((item) => item.accountId).filter(Boolean))]
    const accounts = accountIds.length
      ? await this.prisma.studentAccount.findMany({
          where: { id: { in: accountIds as string[] } },
          select: {
            id: true,
            schoolId: true,
            providerId: true,
            displayName: true,
            status: true,
            school: {
              select: {
                id: true,
                name: true,
                shortName: true,
              },
            },
          },
        })
      : []
    const accountMap = new Map(accounts.map((account) => [account.id, account]))

    return {
      items: items.map((item) => ({
        ...item,
        account: item.accountId ? accountMap.get(item.accountId) ?? null : null,
      })),
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    }
  }

  async getStats() {
    const [schoolCount, enabledCount, accountCount, submissionCount, feedbackCount] =
      await Promise.all([
        this.prisma.school.count(),
        this.prisma.school.count({
          where: { enabled: true, status: 'enabled' },
        }),
        this.prisma.studentAccount.count(),
        this.prisma.schoolAccessSubmission.count({ where: { status: 'submitted' } }),
        this.prisma.feedbackItem.count({ where: { status: 'pending' } }),
      ])

    return {
      schools: { total: schoolCount, enabled: enabledCount },
      accounts: accountCount,
      pendingSubmissions: submissionCount,
      pendingFeedback: feedbackCount,
    }
  }

  private async mergeSchoolConfig(
    schoolId: string,
    input: {
      note?: string
      authConfig?: Record<string, unknown> | null
      providerConfig?: Record<string, unknown> | null
      termStarts?: Record<string, string>
    },
  ) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } })
    const config = (school?.config as Record<string, unknown>) ?? {}
    const nextConfig: Record<string, unknown> = { ...config }

    if (input.note) {
      const notes = Array.isArray(config['adminNotes']) ? config['adminNotes'] as string[] : []
      nextConfig.adminNotes = [...notes, `${new Date().toISOString()}: ${input.note}`]
    }

    if (input.authConfig !== undefined) {
      nextConfig.authConfig = input.authConfig
    }

    if (input.providerConfig !== undefined) {
      nextConfig.provider = input.providerConfig
    }

    if (input.termStarts !== undefined) {
      nextConfig.termStarts = this.normalizeTermStarts(input.termStarts)
    }

    return this.toJson(nextConfig)
  }

  private normalizeTermStarts(value: Record<string, string>) {
    const result: Record<string, string> = {}

    for (const [termId, date] of Object.entries(value || {})) {
      if (termId && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        result[termId] = date
      }
    }

    return result
  }

  private getTermStarts(config: unknown) {
    const record = this.asRecord(this.asRecord(config).termStarts)
    const result: Record<string, string> = {}

    for (const [termId, date] of Object.entries(record)) {
      if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result[termId] = date
      }
    }

    return result
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
  }
}
