import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../bindings/student-identity.service";
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
    bindingId: string;
    username: string;
    password: string;
    semesterId?: string;
  }) {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: input.bindingId },
      include: { school: true },
    });

    if (!binding) {
      throw new NotFoundException("Binding not found");
    }

    const provider = this.providers.getProvider(binding.providerId);

    if (!provider.course) {
      throw new BadRequestException(
        "UNSUPPORTED_SCHOOL: course sync is not available",
      );
    }

    const result = await provider.course.fetchByCredentials({
      username: input.username,
      password: input.password,
      semesterId: input.semesterId,
      providerConfig: this.getProviderConfig(binding.school.config),
    });

    return this.writeCourseCache({
      binding,
      result,
    });
  }

  private async writeCourseCache(input: {
    binding: {
      id: string;
      userId: string;
      schoolId: string;
      providerId: string;
      cacheState: Prisma.JsonValue | null;
    };
    result: CourseFetchResult;
  }) {
    const courses = input.result.schedule.courses.map((course, index) =>
      this.normalizeCourse(course, index),
    );
    const termId = input.result.schedule.selectedSemesterId;
    const syncedAt = new Date();
    const terms = input.result.schedule.semesters ?? [];
    const sectionTimes = input.result.schedule.sectionTimes ?? [];
    const featureResults = this.getFeatureResults(input.result);
    const sourceHash = createHash("sha256")
      .update(
        JSON.stringify({
          bindingId: input.binding.id,
          providerId: input.binding.providerId,
          termId,
          courses,
        }),
      )
      .digest("hex");

    const existingCache = await this.prisma.courseCache.findFirst({
      where: { bindingId: input.binding.id, sourceHash },
      select: { id: true },
    });
    const cache = existingCache
      ? await this.prisma.courseCache.update({
          where: { id: existingCache.id },
          data: {
            termId,
            coursesJson: this.toJson(courses),
            termsJson: this.toJson(terms),
            sectionTimesJson: this.toJson(sectionTimes),
            syncedAt,
          },
        })
      : await this.prisma.courseCache.create({
          data: {
            userId: input.binding.userId,
            bindingId: input.binding.id,
            schoolId: input.binding.schoolId,
            providerId: input.binding.providerId,
            termId,
            coursesJson: this.toJson(courses),
            termsJson: this.toJson(terms),
            sectionTimesJson: this.toJson(sectionTimes),
            sourceHash,
            syncedAt,
          },
        });

    for (const feature of featureResults) {
      await this.writeFeatureCache({
        binding: input.binding,
        target: feature.target,
        result: feature.result,
        syncedAt,
      });
    }

    const authState = this.toJson({
      profile:
        featureResults.find((feature) => feature.target === "profile")?.result
          .data ??
        input.result.profile ??
        undefined,
      syncedBy: "server_session",
      syncedAt: syncedAt.toISOString(),
    });
    const identityBinding = await this.studentIdentity.bindStudentIdentity({
      bindingId: input.binding.id,
      schoolId: input.binding.schoolId,
      providerId: input.binding.providerId,
      studentNo: input.result.profile?.studentId,
      displayName: input.result.profile?.name,
      authState,
    });

    await this.prisma.userSchoolBinding.update({
      where: { id: identityBinding.id },
      data: {
        displayName: input.result.profile?.name || undefined,
        status: "cached_only",
        authState,
        cacheState: this.toJson({
          ...this.asRecord(
            identityBinding.cacheState ?? input.binding.cacheState,
          ),
          course: {
            status: "cached",
            termId,
            syncedAt: syncedAt.toISOString(),
            count: courses.length,
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
        credentialSaveMode: "none",
        lastCachedAt: syncedAt,
        lastAuthErrorCode: null,
        lastAuthErrorAt: null,
      },
    });

    return {
      bindingId: identityBinding.id,
      cacheId: cache.id,
      termId,
      parsedCount: courses.length,
      syncedAt,
    };
  }

  async fetchAndCacheFeatureByCredentials(input: {
    bindingId: string;
    target: Exclude<DataTarget, "course">;
    username: string;
    password: string;
    semesterId?: string;
  }) {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: input.bindingId },
      include: { school: true },
    });

    if (!binding) {
      throw new NotFoundException("Binding not found");
    }

    const provider = this.providers.getProvider(binding.providerId);
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
      providerConfig: this.getProviderConfig(binding.school.config),
    });
    const syncedAt = new Date();
    const cache = await this.writeFeatureCache({
      binding,
      target: input.target,
      result,
      syncedAt,
    });

    await this.prisma.userSchoolBinding.update({
      where: { id: binding.id },
      data: {
        displayName:
          input.target === "profile" && result.profile?.name
            ? result.profile.name
            : undefined,
        authState: this.toJson({
          ...this.asRecord(binding.authState),
          ...(input.target === "profile" ? { profile: result.data } : {}),
          syncedBy: "server_session",
          syncedAt: syncedAt.toISOString(),
        }),
        cacheState: this.toJson({
          ...this.asRecord(binding.cacheState),
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
      bindingId: binding.id,
      cacheId: cache.id,
      termId: result.termId,
      parsedCount: this.countFeatureItems(result.data),
      syncedAt,
    };
  }

  private async writeFeatureCache(input: {
    binding: {
      id: string;
      userId: string;
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
          bindingId: input.binding.id,
          providerId: input.binding.providerId,
          target: input.target,
          termId: input.result.termId,
          data: input.result.data,
        }),
      )
      .digest("hex");
    const existingCache = await this.prisma.featureCache.findFirst({
      where: {
        bindingId: input.binding.id,
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
        userId: input.binding.userId,
        bindingId: input.binding.id,
        schoolId: input.binding.schoolId,
        providerId: input.binding.providerId,
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
