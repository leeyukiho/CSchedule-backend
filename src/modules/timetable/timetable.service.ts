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
    accountId: string,
    termId?: string,
  ): Promise<TimetableCacheResponse> {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: { school: true },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    const cache = await this.prisma.courseCache.findFirst({
      where: {
        accountId,
        ...(termId ? { termId } : {}),
      },
      orderBy: { syncedAt: 'desc' },
    })

    return {
      accountId,
      schoolId: account.schoolId,
      providerId: account.providerId,
      termId: cache?.termId ?? termId,
      courses: this.asArray(cache?.coursesJson),
      terms: this.asArray(cache?.termsJson),
      sectionTimes: this.asArray(cache?.sectionTimesJson),
      display: this.providerDisplay.getDisplay(account.school.config, account.providerId, 'course'),
      syncedAt: cache?.syncedAt.toISOString(),
      session: {
        sessionReusable: account.sessionReusable,
        sessionRefreshable: account.sessionRefreshable,
        sessionExpireAt: account.sessionExpireAt?.toISOString(),
        accountStatus: account.status,
      },
    }
  }

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : []
  }
}
