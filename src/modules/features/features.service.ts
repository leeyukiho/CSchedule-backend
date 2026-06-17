import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'

import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderDisplayService } from '../providers/provider-display.service'
import { DataTarget, FeatureDisplayConfig } from '../providers/provider.types'

const EDITABLE_PROFILE_FIELDS = [
  'name',
  'major',
  'grade',
  'level',
  'className',
  'birthDate',
  'politicalStatus',
  'phone',
  'email',
  'nativePlace',
  'enrollmentDate',
  'studentStatus',
  'dormitory',
  'counselor',
]

@Injectable()
export class FeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerDisplay: ProviderDisplayService,
  ) {}

  async getFeature(
    accountId: string,
    target: Exclude<DataTarget, 'course'>,
    termId?: string,
    knownHash?: string,
  ) {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: { school: true },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    const cache = await this.prisma.featureCache.findFirst({
      where: {
        accountId,
        target,
        ...(termId ? { termId } : {}),
      },
      orderBy: { syncedAt: 'desc' },
    })

    const display = this.providerDisplay.getDisplay(account.school.config, account.providerId, target)
    const session = {
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      accountStatus: account.status,
    }

    if (cache?.sourceHash && knownHash && knownHash === cache.sourceHash) {
      return {
        accountId,
        schoolId: account.schoolId,
        providerId: account.providerId,
        target,
        termId: cache.termId ?? termId,
        data: null,
        meta: null,
        display,
        sourceHash: cache.sourceHash,
        notModified: true,
        syncedAt: cache.syncedAt.toISOString(),
        session,
      }
    }

    const data =
      cache?.dataJson ??
      (target === 'profile' ? this.getAuthStateProfile(account.authState) : null)

    return {
      accountId,
      schoolId: account.schoolId,
      providerId: account.providerId,
      target,
      termId: cache?.termId ?? termId,
      data,
      meta: cache?.metaJson ?? null,
      display,
      sourceHash: cache?.sourceHash,
      syncedAt: cache?.syncedAt.toISOString(),
      session,
    }
  }

  async saveProfile(accountId: string, profile: Record<string, unknown>) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new BadRequestException('Invalid profile payload')
    }

    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: { school: true },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    const display = this.providerDisplay.getDisplay(account.school.config, account.providerId, 'profile')
    const latestCache = await this.prisma.featureCache.findFirst({
      where: { accountId, target: 'profile' },
      orderBy: { syncedAt: 'desc' },
    })
    const existingProfile = {
      ...this.asRecord(this.getAuthStateProfile(account.authState)),
      ...this.asRecord(latestCache?.dataJson),
    }
    const savedProfile = {
      ...existingProfile,
      ...this.pickEditableProfileFields(profile, display),
    }
    const syncedAt = new Date()
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          accountId,
          target: 'profile',
          profile: savedProfile,
        }),
      )
      .digest('hex')

    await this.prisma.featureCache.upsert({
      where: {
        featureCacheAccountTargetSourceHash: {
          accountId,
          target: 'profile',
          sourceHash,
        },
      },
      update: {
        dataJson: this.toJson(savedProfile),
        metaJson: this.toJson({ source: 'manual_edit', editedAt: syncedAt.toISOString() }),
        syncedAt,
      },
      create: {
        accountId,
        schoolId: account.schoolId,
        providerId: account.providerId,
        target: 'profile',
        dataJson: this.toJson(savedProfile),
        metaJson: this.toJson({ source: 'manual_edit', editedAt: syncedAt.toISOString() }),
        sourceHash,
        syncedAt,
      },
    })

    await this.prisma.studentAccount.update({
      where: { id: accountId },
      data: {
        displayName:
          typeof savedProfile.name === 'string' && savedProfile.name.trim()
            ? savedProfile.name.trim()
            : undefined,
        authState: this.toJson({
          ...this.asRecord(account.authState),
          profile: savedProfile,
        }),
        lastCachedAt: syncedAt,
      },
    })

    return this.getFeature(accountId, 'profile')
  }

  private pickEditableProfileFields(
    profile: Record<string, unknown>,
    display?: FeatureDisplayConfig,
  ) {
    const editableFields = this.getEditableProfileFields(display)

    return editableFields.reduce<Record<string, string>>((result, field) => {
      if (!Object.prototype.hasOwnProperty.call(profile, field)) {
        return result
      }

      const value = profile[field]

      if (value === null || value === undefined) {
        result[field] = ''
        return result
      }

      result[field] = String(value).trim()
      return result
    }, {})
  }

  private getEditableProfileFields(display?: FeatureDisplayConfig) {
    const fields = display?.editableFields?.length
      ? display.editableFields
      : display?.detailFields?.filter((field) => field.editable)

    if (!fields?.length) {
      return EDITABLE_PROFILE_FIELDS
    }

    return fields
      .filter((field) => field.visible !== false && field.editable !== false)
      .map((field) => field.key)
      .filter((field) => field && field !== 'studentId' && field !== 'maskedStudentId')
      .filter((field) => field !== 'gender')
  }

  private getAuthStateProfile(authState: Prisma.JsonValue | null) {
    return this.asRecord(this.asRecord(authState).profile)
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
