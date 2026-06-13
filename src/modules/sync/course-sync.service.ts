import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../bindings/student-identity.service";
import { CourseFetchResult, ProviderCourse } from "../providers/provider.types";
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

    const authState = this.toJson({
      profile: input.result.profile ?? undefined,
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
