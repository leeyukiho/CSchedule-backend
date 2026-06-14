import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../accounts/student-identity.service";
import {
  CourseFetchResult,
  DataTarget,
  FeatureFetchResult,
  ProviderCourse,
} from "../providers/provider.types";
import { ProviderRegistryService } from "../providers/provider-registry.service";

@Injectable()
export class CourseSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistryService,
    private readonly studentIdentity: StudentIdentityService,
  ) {}

  async fetchAndCacheByCredentials(input: {
    accountId: string;
    username: string;
    password: string;
    semesterId?: string;
    allSemesters?: boolean;
    credentialSaveMode?: "none" | "password_vault";
    authStatePatch?: Record<string, unknown>;
  }) {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: input.accountId },
      include: { school: true },
    });

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    const provider = this.providers.getProvider(account.providerId);

    if (!provider.course) {
      throw new BadRequestException(
        "UNSUPPORTED_SCHOOL: course sync is not available",
      );
    }

    const result = await provider.course.fetchByCredentials({
      username: input.username,
      password: input.password,
      semesterId: input.semesterId,
      allSemesters: input.allSemesters,
      providerConfig: this.getProviderConfig(account.school.config),
    });

    return this.writeCourseCache({
      account,
      result,
      credentialSaveMode: input.credentialSaveMode,
      authStatePatch: input.authStatePatch,
    });
  }

  private async writeCourseCache(input: {
    account: {
      id: string;
      schoolId: string;
      providerId: string;
      cacheState: Prisma.JsonValue | null;
    };
    result: CourseFetchResult;
    credentialSaveMode?: "none" | "password_vault";
    authStatePatch?: Record<string, unknown>;
  }) {
    const schedules = input.result.schedules?.length
      ? input.result.schedules
      : [input.result.schedule];
    const primarySchedule = schedules[0] || input.result.schedule;
    const writtenCaches = [];
    let parsedCount = 0;
    const syncedAt = new Date();
    const allTerms = this.mergeTerms(schedules);

    for (const [index, schedule] of schedules.entries()) {
      const cache = await this.writeScheduleCache({
        account: input.account,
        schedule,
        syncedAt:
          index === 0
            ? new Date(syncedAt.getTime() + schedules.length)
            : syncedAt,
        terms: allTerms,
      });
      writtenCaches.push(cache);
      parsedCount += cache.parsedCount;
    }

    const featureResults = this.getFeatureResults(input.result);

    for (const feature of featureResults) {
      await this.writeFeatureCache({
        account: input.account,
        target: feature.target,
        result: feature.result,
        syncedAt,
      });
    }

    const authState = this.toJson({
      ...input.authStatePatch,
      profile:
        featureResults.find((feature) => feature.target === "profile")?.result
          .data ??
        input.result.profile ??
        undefined,
      syncedBy: "server_session",
      syncedAt: syncedAt.toISOString(),
    });
    const identityAccount = await this.studentIdentity.bindStudentIdentity({
      accountId: input.account.id,
      schoolId: input.account.schoolId,
      providerId: input.account.providerId,
      studentNo: input.result.profile?.studentId,
      displayName: input.result.profile?.name,
      authState,
    });

    await this.prisma.studentAccount.update({
      where: { id: identityAccount.id },
      data: {
        displayName: input.result.profile?.name || undefined,
        status: "cached_only",
        authState,
        cacheState: this.toJson({
          ...this.asRecord(
            identityAccount.cacheState ?? input.account.cacheState,
          ),
          course: {
            status: "cached",
            termId: primarySchedule.selectedSemesterId,
            syncedAt: syncedAt.toISOString(),
            count: parsedCount,
            cachedTerms: schedules.length,
          },
          ...featureResults.reduce<Record<string, unknown>>(
            (state, feature) => {
              state[feature.target] = {
                status: "cached",
                termId: feature.result.termId,
                syncedAt: syncedAt.toISOString(),
              };
              return state;
            },
            {},
          ),
        }),
        sessionReusable: false,
        sessionRefreshable: false,
        sessionExpireAt: null,
        credentialSaveMode: input.credentialSaveMode || "none",
        lastCachedAt: syncedAt,
        lastAuthErrorCode: null,
        lastAuthErrorAt: null,
      },
    });

    const primaryCache = writtenCaches[0];

    return {
      accountId: identityAccount.id,
      cacheId: primaryCache?.cacheId || "",
      termId: primarySchedule.selectedSemesterId,
      parsedCount,
      syncedAt,
    };
  }

  private async writeScheduleCache(input: {
    account: {
      id: string;
      schoolId: string;
      providerId: string;
    };
    schedule: CourseFetchResult["schedule"];
    syncedAt: Date;
    terms: unknown[];
  }) {
    const courses = input.schedule.courses.map((course, index) =>
      this.normalizeCourse(course, index),
    );
    const termId = input.schedule.selectedSemesterId;
    const sectionTimes = input.schedule.sectionTimes ?? [];
    const sourceHash = createHash("sha256")
      .update(
        JSON.stringify({
          accountId: input.account.id,
          providerId: input.account.providerId,
          termId,
          courses,
        }),
      )
      .digest("hex");

    const existingCache = await this.prisma.courseCache.findFirst({
      where: { accountId: input.account.id, sourceHash },
      select: { id: true },
    });
    const cache = existingCache
      ? await this.prisma.courseCache.update({
          where: { id: existingCache.id },
          data: {
            termId,
            coursesJson: this.toJson(courses),
            termsJson: this.toJson(input.terms),
            sectionTimesJson: this.toJson(sectionTimes),
            syncedAt: input.syncedAt,
          },
        })
      : await this.prisma.courseCache.create({
          data: {
            accountId: input.account.id,
            schoolId: input.account.schoolId,
            providerId: input.account.providerId,
            termId,
            coursesJson: this.toJson(courses),
            termsJson: this.toJson(input.terms),
            sectionTimesJson: this.toJson(sectionTimes),
            sourceHash,
            syncedAt: input.syncedAt,
          },
        });

    return {
      cacheId: cache.id,
      termId,
      parsedCount: courses.length,
    };
  }

  async fetchAndCacheFeatureByCredentials(input: {
    accountId: string;
    target: Exclude<DataTarget, "course">;
    username: string;
    password: string;
    semesterId?: string;
  }) {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: input.accountId },
      include: { school: true },
    });

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    const provider = this.providers.getProvider(account.providerId);
    const connector = provider[input.target];

    if (!connector) {
      throw new BadRequestException(
        `UNSUPPORTED_SCHOOL: ${input.target} sync is not available`,
      );
    }

    const result = await connector.fetchByCredentials({
      username: input.username,
      password: input.password,
      semesterId: input.semesterId,
      providerConfig: this.getProviderConfig(account.school.config),
    });
    const syncedAt = new Date();
    const cache = await this.writeFeatureCache({
      account,
      target: input.target,
      result,
      syncedAt,
    });

    await this.prisma.studentAccount.update({
      where: { id: account.id },
      data: {
        displayName:
          input.target === "profile" && result.profile?.name
            ? result.profile.name
            : undefined,
        authState: this.toJson({
          ...this.asRecord(account.authState),
          ...(input.target === "profile" ? { profile: result.data } : {}),
          syncedBy: "server_session",
          syncedAt: syncedAt.toISOString(),
        }),
        cacheState: this.toJson({
          ...this.asRecord(account.cacheState),
          [input.target]: {
            status: "cached",
            termId: result.termId,
            syncedAt: syncedAt.toISOString(),
          },
        }),
        status: "cached_only",
        lastCachedAt: syncedAt,
        lastAuthErrorCode: null,
        lastAuthErrorAt: null,
      },
    });

    return {
      accountId: account.id,
      cacheId: cache.id,
      termId: result.termId,
      parsedCount: this.countFeatureItems(result.data),
      syncedAt,
    };
  }

  private async writeFeatureCache(input: {
    account: {
      id: string;
      schoolId: string;
      providerId: string;
    };
    target: Exclude<DataTarget, "course">;
    result: FeatureFetchResult;
    syncedAt: Date;
  }) {
    const sourceHash = createHash("sha256")
      .update(
        JSON.stringify({
          accountId: input.account.id,
          providerId: input.account.providerId,
          target: input.target,
          termId: input.result.termId,
          data: input.result.data,
        }),
      )
      .digest("hex");
    const existingCache = await this.prisma.featureCache.findFirst({
      where: {
        accountId: input.account.id,
        target: input.target,
        sourceHash,
      },
      select: { id: true },
    });
    const data = {
      termId: input.result.termId,
      dataJson: this.toJson(input.result.data),
      metaJson: this.toJson(input.result.meta ?? { source: "server_session" }),
      syncedAt: input.syncedAt,
    };

    if (existingCache) {
      return this.prisma.featureCache.update({
        where: { id: existingCache.id },
        data,
      });
    }

    return this.prisma.featureCache.create({
      data: {
        accountId: input.account.id,
        schoolId: input.account.schoolId,
        providerId: input.account.providerId,
        target: input.target,
        sourceHash,
        ...data,
      },
    });
  }

  private getFeatureResults(result: CourseFetchResult) {
    const features = result.features ?? {};
    const list: Array<{
      target: Exclude<DataTarget, "course">;
      result: FeatureFetchResult;
    }> = [];

    if (result.profile) {
      list.push({
        target: "profile",
        result: {
          data: result.profile,
          profile: result.profile,
          meta: { source: "course_fetch" },
        },
      });
    }

    for (const target of ["score", "exam", "profile"] as const) {
      const data = features[target];

      if (data === undefined || (target === "profile" && result.profile)) {
        continue;
      }

      list.push({
        target,
        result: {
          data,
          profile:
            target === "profile"
              ? (data as FeatureFetchResult["profile"])
              : undefined,
          meta: { source: "course_fetch" },
        },
      });
    }

    return list;
  }

  private countFeatureItems(data: unknown) {
    if (Array.isArray(data)) {
      return data.length;
    }

    const record = this.asRecord(data);

    if (Array.isArray(record.semesters)) {
      return record.semesters.reduce((count, semester) => {
        const grades = this.asRecord(semester).grades;
        return count + (Array.isArray(grades) ? grades.length : 0);
      }, 0);
    }

    return Object.keys(record).length;
  }

  private mergeTerms(schedules: CourseFetchResult["schedule"][]) {
    const terms = new Map<string, unknown>();
    const canonicalIds = new Map<string, string>();
    const aliases = new Map<string, string>();

    for (const schedule of schedules) {
      for (const term of schedule.semesters || []) {
        const record = this.asRecord(term);
        const id = record.id;

        if (typeof id !== "string" || !id.trim()) {
          continue;
        }

        const key = this.getTermKey(term);
        const existingId = canonicalIds.get(key);

        if (existingId) {
          terms.set(existingId, this.mergeTermRecords(terms.get(existingId), term));
          aliases.set(id, existingId);
        } else {
          terms.set(id, term);
          canonicalIds.set(key, id);
          aliases.set(id, id);
        }
      }

      if (schedule.selectedSemesterId && !aliases.has(schedule.selectedSemesterId)) {
        const fallbackTerm = {
          id: schedule.selectedSemesterId,
          title: schedule.term || schedule.selectedSemesterId,
          label: schedule.term || schedule.selectedSemesterId,
        };
        const key = this.getTermKey(fallbackTerm);
        const existingId = canonicalIds.get(key);

        if (existingId) {
          terms.set(existingId, this.mergeTermRecords(terms.get(existingId), fallbackTerm));
          aliases.set(schedule.selectedSemesterId, existingId);
          continue;
        }

        terms.set(schedule.selectedSemesterId, {
          id: schedule.selectedSemesterId,
          title: schedule.term || schedule.selectedSemesterId,
          label: schedule.term || schedule.selectedSemesterId,
        });
        canonicalIds.set(key, schedule.selectedSemesterId);
        aliases.set(schedule.selectedSemesterId, schedule.selectedSemesterId);
      }
    }

    return [...terms.values()].filter((term) => this.isNotFutureAcademicYear(term)).sort(
      (left, right) => this.getTermSortKey(right) - this.getTermSortKey(left),
    );
  }

  private mergeTermRecords(existing: unknown, next: unknown) {
    const existingRecord = this.asRecord(existing);
    const nextRecord = this.asRecord(next);

    return {
      ...existingRecord,
      selected: Boolean(existingRecord.selected || nextRecord.selected),
    };
  }

  private getTermKey(value: unknown) {
    const record = this.asRecord(value);
    const text = String(record.label ?? record.title ?? record.name ?? record.id ?? "")
      .replace(/\s+/g, "")
      .trim();
    const yearMatch = text.match(/(20\d{2})[-~—至]?(20\d{2})/);

    if (!yearMatch) {
      return text;
    }

    const secondSemester =
      text.includes("第二学期") ||
      text.includes("下学期") ||
      /第?[二2]学期/.test(text) ||
      /[.-]?2$/.test(text);

    return `${yearMatch[1]}-${yearMatch[2]}-${secondSemester ? "2" : "1"}`;
  }

  private getTermSortKey(value: unknown) {
    const match = this.getTermKey(value).match(/^(20\d{2})-(20\d{2})-([12])$/);

    return match ? Number(match[1]) * 10 + Number(match[3]) : Number.NEGATIVE_INFINITY;
  }

  private isNotFutureAcademicYear(value: unknown) {
    const match = this.getTermKey(value).match(/^(20\d{2})-(20\d{2})-([12])$/);

    if (!match) {
      return true;
    }

    return Number(match[1]) <= this.getCurrentAcademicStartYear();
  }

  private getCurrentAcademicStartYear(baseDate = new Date()) {
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();

    return month >= 8 ? year : year - 1;
  }

  private normalizeCourse(course: ProviderCourse, index: number) {
    const sections = this.normalizeSections(course);
    const startSection = Number(course.startSection ?? sections[0] ?? 0);
    const endSection = Number(
      course.endSection ?? sections[sections.length - 1] ?? startSection,
    );

    return {
      id: course.id || `course-${index + 1}`,
      name: course.name || "未命名课程",
      teacher: course.teacher,
      location: course.location ?? course.classroom,
      classroom: course.classroom ?? course.location,
      weekday: Number(course.weekday || 0),
      sections,
      startSection,
      endSection,
      weeks: Array.isArray(course.weeks) ? course.weeks : [],
      rawWeeks: course.rawWeeks,
      campus: course.campus,
      remark: course.remark,
      source: course.source,
    };
  }

  private normalizeSections(course: ProviderCourse) {
    if (Array.isArray(course.sections) && course.sections.length > 0) {
      return course.sections
        .map((section) => Number(section))
        .filter((section) => Number.isFinite(section) && section > 0);
    }

    const start = Number(course.startSection);
    const end = Number(course.endSection ?? start);

    if (!Number.isFinite(start) || start <= 0) {
      return [];
    }

    return Array.from(
      { length: Math.max((Number.isFinite(end) ? end : start) - start + 1, 1) },
      (_, index) => start + index,
    );
  }

  private getProviderConfig(config: Prisma.JsonValue | null) {
    const root = this.asRecord(config);
    return this.asRecord(root.provider);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
