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
    knownHash?: string,
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
    const display = this.providerDisplay.getDisplay(account.school.config, account.providerId, 'course')
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
        termId: cache.termId ?? termId,
        courses: [],
        terms: [],
        sectionTimes: [],
        display,
        sourceHash: cache.sourceHash,
        notModified: true,
        syncedAt: cache.syncedAt.toISOString(),
        session,
      }
    }

    const termCaches = await this.prisma.courseCache.findMany({
      where: { accountId },
      select: {
        termId: true,
        termsJson: true,
      },
      orderBy: { syncedAt: 'desc' },
    })
    const terms = this.mergeTerms(termCaches, cache?.termsJson)
    const canonicalTermId = this.getCanonicalTermId(cache?.termId ?? termId, terms)

    return {
      accountId,
      schoolId: account.schoolId,
      providerId: account.providerId,
      termId: canonicalTermId,
      courses: this.asArray(cache?.coursesJson),
      terms,
      sectionTimes: this.asArray(cache?.sectionTimesJson),
      display,
      sourceHash: cache?.sourceHash,
      syncedAt: cache?.syncedAt.toISOString(),
      session,
    }
  }

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : []
  }

  private mergeTerms(
    caches: Array<{ termId: string | null; termsJson: unknown }>,
    primaryTermsJson: unknown,
  ) {
    const terms = new Map<string, unknown>()
    const canonicalIds = new Map<string, string>()
    const aliases = new Map<string, string>()

    for (const term of this.asArray(primaryTermsJson)) {
      const id = this.getTermId(term)

      if (id) {
        this.setMergedTerm(terms, canonicalIds, aliases, id, term)
      }
    }

    for (const cache of caches) {
      for (const term of this.asArray(cache.termsJson)) {
        const id = this.getTermId(term)

        if (id) {
          this.setMergedTerm(terms, canonicalIds, aliases, id, term)
        }
      }

      if (cache.termId && !aliases.has(cache.termId)) {
        this.setMergedTerm(terms, canonicalIds, aliases, cache.termId, {
          id: cache.termId,
          label: cache.termId,
          title: cache.termId,
        })
      }
    }

    return [...terms.values()].filter((term) => this.isNotFutureAcademicYear(term)).sort(
      (left, right) => this.getTermSortKey(right) - this.getTermSortKey(left),
    )
  }

  private getTermId(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return ''
    }

    const id = (value as Record<string, unknown>).id
    return typeof id === 'string' ? id.trim() : ''
  }

  private getCanonicalTermId(termId: string | null | undefined, terms: unknown[]) {
    const id = typeof termId === 'string' ? termId.trim() : ''

    if (!id) {
      return id
    }

    if (terms.some((term) => this.getTermId(term) === id)) {
      return id
    }

    const key = this.getTermKey({ id, label: id, title: id })
    const canonicalTerm = terms.find((term) => this.getTermKey(term) === key)

    return this.getTermId(canonicalTerm) || id
  }

  private setMergedTerm(
    terms: Map<string, unknown>,
    canonicalIds: Map<string, string>,
    aliases: Map<string, string>,
    id: string,
    term: unknown,
  ) {
    const key = this.getTermKey(term)
    const existingId = canonicalIds.get(key)

    if (existingId) {
      terms.set(existingId, this.mergeTermRecords(terms.get(existingId), term))
      aliases.set(id, existingId)
      return
    }

    if (!terms.has(id)) {
      terms.set(id, term)
      canonicalIds.set(key, id)
      aliases.set(id, id)
    }
  }

  private mergeTermRecords(existing: unknown, next: unknown) {
    const existingRecord = this.asRecord(existing)
    const nextRecord = this.asRecord(next)

    return {
      ...existingRecord,
      selected: Boolean(existingRecord.selected || nextRecord.selected),
    }
  }

  private getTermKey(value: unknown) {
    const record = this.asRecord(value)
    const text = String(record.label ?? record.title ?? record.name ?? record.id ?? '')
      .replace(/\s+/g, '')
      .trim()
    const yearMatch = text.match(/(20\d{2})[-~—至]?(20\d{2})/)

    if (!yearMatch) {
      return text
    }

    const secondSemester =
      text.includes('第二学期') ||
      text.includes('下学期') ||
      /第?[二2]学期/.test(text) ||
      /[.-]?2$/.test(text)

    return `${yearMatch[1]}-${yearMatch[2]}-${secondSemester ? '2' : '1'}`
  }

  private getTermSortKey(value: unknown) {
    const match = this.getTermKey(value).match(/^(20\d{2})-(20\d{2})-([12])$/)

    return match ? Number(match[1]) * 10 + Number(match[3]) : Number.NEGATIVE_INFINITY
  }

  private isNotFutureAcademicYear(value: unknown) {
    const match = this.getTermKey(value).match(/^(20\d{2})-(20\d{2})-([12])$/)

    if (!match) {
      return true
    }

    return Number(match[1]) <= this.getCurrentAcademicStartYear()
  }

  private getCurrentAcademicStartYear(baseDate = new Date()) {
    const year = baseDate.getFullYear()
    const month = baseDate.getMonth()

    return month >= 8 ? year : year - 1
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
}
