import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DataTarget } from '../providers/provider.types'

const EDITABLE_PROFILE_FIELDS = [
  'name',
  'major',
  'grade',
  'level',
  'className',
  'gender',
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
  constructor(private readonly prisma: PrismaService) {}

  async getFeature(bindingId: string, target: Exclude<DataTarget, 'course'>, termId?: string) {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    const cache = await this.prisma.featureCache.findFirst({
      where: {
        bindingId,
        target,
        ...(termId ? { termId } : {}),
      },
      orderBy: { syncedAt: 'desc' },
    })

    const data =
      cache?.dataJson ??
      (target === 'profile' ? this.getAuthStateProfile(binding.authState) : null)

    return {
      bindingId,
      schoolId: binding.schoolId,
      providerId: binding.providerId,
      target,
      termId: cache?.termId ?? termId,
      data,
      meta: cache?.metaJson ?? null,
      syncedAt: cache?.syncedAt.toISOString(),
      session: {
        sessionReusable: binding.sessionReusable,
        sessionRefreshable: binding.sessionRefreshable,
        sessionExpireAt: binding.sessionExpireAt?.toISOString(),
        bindingStatus: binding.status,
      },
    }
  }

  async saveProfile(bindingId: string, profile: Record<string, unknown>) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new BadRequestException('Invalid profile payload')
    }

    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    const latestCache = await this.prisma.featureCache.findFirst({
      where: { bindingId, target: 'profile' },
      orderBy: { syncedAt: 'desc' },
    })
    const existingProfile = {
      ...this.asRecord(this.getAuthStateProfile(binding.authState)),
      ...this.asRecord(latestCache?.dataJson),
    }
    const savedProfile = {
      ...existingProfile,
      ...this.pickEditableProfileFields(profile),
    }
    const syncedAt = new Date()
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          bindingId,
          target: 'profile',
          profile: savedProfile,
        }),
      )
      .digest('hex')

    const sameCache = await this.prisma.featureCache.findFirst({
      where: { bindingId, target: 'profile', sourceHash },
      select: { id: true },
    })

    if (sameCache) {
      await this.prisma.featureCache.update({
        where: { id: sameCache.id },
        data: {
          dataJson: this.toJson(savedProfile),
          metaJson: this.toJson({ source: 'manual_edit', editedAt: syncedAt.toISOString() }),
          syncedAt,
        },
      })
    } else {
      await this.prisma.featureCache.create({
        data: {
          userId: binding.userId,
          bindingId,
          schoolId: binding.schoolId,
          providerId: binding.providerId,
          target: 'profile',
          dataJson: this.toJson(savedProfile),
          metaJson: this.toJson({ source: 'manual_edit', editedAt: syncedAt.toISOString() }),
          sourceHash,
          syncedAt,
        },
      })
    }

    await this.prisma.userSchoolBinding.update({
      where: { id: bindingId },
      data: {
        displayName:
          typeof savedProfile.name === 'string' && savedProfile.name.trim()
            ? savedProfile.name.trim()
            : undefined,
        authState: this.toJson({
          ...this.asRecord(binding.authState),
          profile: savedProfile,
        }),
        lastCachedAt: syncedAt,
      },
    })

    return this.getFeature(bindingId, 'profile')
  }

  private pickEditableProfileFields(profile: Record<string, unknown>) {
    return EDITABLE_PROFILE_FIELDS.reduce<Record<string, string>>((result, field) => {
      const value = profile[field]

      if (value === null || value === undefined) {
        result[field] = ''
        return result
      }

      result[field] = String(value).trim()
      return result
    }, {})
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
