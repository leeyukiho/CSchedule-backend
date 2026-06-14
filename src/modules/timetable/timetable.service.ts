import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderDisplayService } from '../providers/provider-display.service'
import { TimetableCacheResponse } from './timetable.types'

@Injectable()
export class TimetableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerDisplay: ProviderDisplayService,
  ) {}

  async getTimetable(
    bindingId: string,
    termId?: string,
  ): Promise<TimetableCacheResponse> {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
      include: { school: true },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    const cache = await this.prisma.courseCache.findFirst({
      where: {
        bindingId,
        ...(termId ? { termId } : {}),
      },
      orderBy: { syncedAt: 'desc' },
    })

    return {
      bindingId,
      schoolId: binding.schoolId,
      providerId: binding.providerId,
      termId: cache?.termId ?? termId,
      courses: this.asArray(cache?.coursesJson),
      terms: this.asArray(cache?.termsJson),
      sectionTimes: this.asArray(cache?.sectionTimesJson),
      display: this.providerDisplay.getDisplay(binding.school.config, binding.providerId, 'course'),
      syncedAt: cache?.syncedAt.toISOString(),
      session: {
        sessionReusable: binding.sessionReusable,
        sessionRefreshable: binding.sessionRefreshable,
        sessionExpireAt: binding.sessionExpireAt?.toISOString(),
        bindingStatus: binding.status,
      },
    }
  }

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : []
  }
}
