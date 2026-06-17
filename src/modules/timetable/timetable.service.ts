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
      select: {
        schoolId: true,
        providerId: true,
        sessionReusable: true,
        sessionRefreshable: true,
        sessionExpireAt: true,
        status: true,
        school: {
          select: {
            config: true,
          },
        },
      },
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
    if (cache?.sourceHash && knownHash && knownHash === cache.sourceHash) {
      return {
        termId: this.cleanTermLabel(cache.termId ?? termId),
        sourceHash: cache.sourceHash,
        notModified: true,
        syncedAt: cache.syncedAt.toISOString(),
      }
    }

    const display = this.providerDisplay.getDisplay(account.school.config, account.providerId, 'course')
    const session = {
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      accountStatus: account.status,
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
      terms: terms.map((term) => this.cleanTermRecord(term)),
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
    const id = this.cleanTermLabel(termId)

    if (!id) {
      return id
    }

    if (terms.some((term) => this.getTermId(term) === id)) {
      return id
    }

    const key = this.getTermKey({ id, label: id, title: id })
    const canonicalTerm = terms.find((term) => this.getTermKey(term) === key)

    return this.cleanTermLabel(this.getTermId(canonicalTerm) || id)
  }

  private setMergedTerm(
    terms: Map<string, unknown>,
    canonicalIds: Map<string, string>,
    aliases: Map<string, string>,
    id: string,
    term: unknown,
  ) {
    const cleanId = this.cleanTermLabel(id)
    const rawLabel = this.asRecord(term).label ?? this.asRecord(term).title ?? this.asRecord(term).name

    if (!cleanId && this.isScheduleTermNoise(id) && this.isScheduleTermNoise(rawLabel)) {
      return
    }

    const cleanTerm = this.cleanTermRecord({ ...this.asRecord(term), id: cleanId || id })
    const key = this.getTermKey(cleanTerm)
    const existingId = canonicalIds.get(key)

    if (existingId) {
      terms.set(existingId, this.mergeTermRecords(terms.get(existingId), cleanTerm))
      aliases.set(id, existingId)
      return
    }

    if (cleanId && !terms.has(cleanId)) {
      terms.set(cleanId, cleanTerm)
      canonicalIds.set(key, cleanId)
      aliases.set(id, cleanId)
    }
  }

  private mergeTermRecords(existing: unknown, next: unknown) {
    const existingRecord = this.asRecord(existing)
    const nextRecord = this.asRecord(next)

    return {
      ...existingRecord,
      ...this.cleanTermRecord(nextRecord),
      selected: Boolean(existingRecord.selected || nextRecord.selected),
    }
  }

  private cleanTermRecord(value: unknown) {
    const record = this.asRecord(value)
    const id = this.cleanTermLabel(record.id)
    const label = this.cleanTermLabel(record.label ?? record.title ?? record.name ?? record.id)
    const cleanRecord = { ...record }

    if (!label) {
      delete cleanRecord.label
      delete cleanRecord.title
    }

    return {
      ...cleanRecord,
      ...(id ? { id } : {}),
      ...(label ? { label, title: label } : {}),
    }
  }

  private getTermKey(value: unknown) {
    const record = this.asRecord(value)
    const text = this.cleanTermLabel(record.label ?? record.title ?? record.name ?? record.id)
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

  private cleanTermLabel(value: unknown) {
    const text = String(value ?? '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const academicLabel = this.getAcademicTermLabel(text)

    if (academicLabel) {
      return academicLabel
    }

    return this.stripScheduleTermNoise(text)
  }

  private stripScheduleTermNoise(value: string) {
    return value
      .replace(/\s*学生\s*课表\s*/g, ' ')
      .replace(
        /[\s,，、;；|/\\_-]*第?\s*[\d一二三四五六七八九十]+(?:\s*[-~—至]\s*[\d一二三四五六七八九十]+)?\s*周\s*/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .replace(/^[\s,，、;；|/\\_-]+|[\s,，、;；|/\\_-]+$/g, '')
      .trim()
  }

  private isScheduleTermNoise(value: unknown) {
    const text = String(value ?? '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!text || this.getAcademicTermLabel(text)) {
      return false
    }

    return this.stripScheduleTermNoise(text).replace(/[\s,，、;；|/\\_-]+/g, '') === ''
  }

  private getAcademicTermLabel(value: string) {
    const text = value.replace(/\s+/g, ' ').trim()
    const compactText = text.replace(/\s+/g, '')
    const patterns = [
      /(20\d{2})\s*[-~—至]\s*(20\d{2})\s*学年\s*第?\s*([一二两12])\s*学期/,
      /(20\d{2})\s*[-~—至]\s*(20\d{2})[\s_-]*第?\s*([一二两12])\s*学期/,
      /(20\d{2})\s*[-~—至]\s*(20\d{2})[\s._-]+([12])(?:\s*学期)?/,
      /(20\d{2})\s*[-~—至]\s*(20\d{2}).*?([上下])\s*学期/,
    ]

    for (const source of [text, compactText]) {
      for (const pattern of patterns) {
        const match = source.match(pattern)

        if (match) {
          const semester = match[3] === '2' || match[3] === '二' || match[3] === '两' || match[3] === '下' ? '2' : '1'
          return `${match[1]}-${match[2]}学年第${semester}学期`
        }
      }
    }

    return ''
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
