import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../accounts/student-identity.service";
import { DataAccessMode, DataTarget } from "../providers/provider.types";

export interface RawDataUploadRequest {
  contextId?: string;
  target: DataTarget;
  accessMode: Extract<DataAccessMode, "webview_client_fetch" | "manual_import">;
  termId?: string;
  contentType: "json" | "html" | "text" | "csv" | "xlsx" | "ics" | "pdf";
  sourceUrl?: string;
  payload: unknown;
  meta?: Record<string, unknown>;
}

@Injectable()
export class RawDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentIdentity: StudentIdentityService,
  ) {}

  async uploadRawData(accountId: string, input: RawDataUploadRequest) {
    let account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    if (!input.target || !input.accessMode || !input.contentType) {
      throw new BadRequestException(
        "target, accessMode and contentType are required",
      );
    }

    const parsed = this.parsePayload(input);
    const studentNo =
      this.studentIdentity.extractStudentNo(input.meta) ??
      this.studentIdentity.extractStudentNo(input.payload) ??
      this.studentIdentity.extractStudentNo(parsed.data) ??
      this.studentIdentity.extractStudentNo(parsed.meta);
    const displayName =
      this.studentIdentity.extractDisplayName(input.meta) ??
      this.studentIdentity.extractDisplayName(input.payload) ??
      this.studentIdentity.extractDisplayName(parsed.data) ??
      this.studentIdentity.extractDisplayName(parsed.meta);

    if (studentNo) {
      account = await this.studentIdentity.bindStudentIdentity({
        accountId: account.id,
        schoolId: account.schoolId,
        providerId: account.providerId,
        studentNo,
        displayName,
      });
    }

    const sourceHash = this.createSourceHash(input);
    const syncedAt = new Date();

    if (input.target === "course") {
      await this.prisma.courseCache.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          termId: input.termId ?? parsed.termId,
          coursesJson: this.toJson(parsed.data),
          termsJson: this.toJson(parsed.terms),
          sectionTimesJson: this.toJson(parsed.sectionTimes),
          sourceHash,
          syncedAt,
        },
      });
    } else {
      await this.prisma.featureCache.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target: input.target,
          termId: input.termId ?? parsed.termId,
          dataJson: this.toJson(parsed.data),
          metaJson: this.toJson(parsed.meta),
          sourceHash,
          syncedAt,
        },
      });
    }

    await this.prisma.$transaction([
      this.prisma.studentAccount.update({
        where: { id: account.id },
        data: {
          status: "active",
          cacheState: this.toJson({
            ...this.asRecord(account.cacheState),
            [input.target]: {
              status: "cached",
              termId: input.termId ?? parsed.termId,
              syncedAt: syncedAt.toISOString(),
            },
          }),
          lastCachedAt: syncedAt,
          lastAuthErrorCode: null,
          lastAuthErrorAt: null,
        },
      }),
      this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target: input.target,
          status: "success",
          startedAt: syncedAt,
          finishedAt: syncedAt,
        },
      }),
    ]);

    return {
      accountId: account.id,
      target: input.target,
      cacheId: sourceHash,
      status: "cached",
      parsedCount: parsed.count,
      warnings: parsed.warnings,
    };
  }

  async completeWebviewSync(
    accountId: string,
    completedTargets: DataTarget[] = [],
  ) {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: {
        courseCaches: {
          select: { id: true },
          take: 1,
          orderBy: { syncedAt: "desc" },
        },
      },
    });

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    const hasCourseCache =
      completedTargets.includes("course") || account.courseCaches.length > 0;
    const missingRequiredTargets = hasCourseCache ? [] : ["course"];

    return {
      accountId,
      status: missingRequiredTargets.length === 0 ? "ready" : "partial",
      canCloseWebview: missingRequiredTargets.length === 0,
      sessionReusable: account.sessionReusable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      missingRequiredTargets,
    };
  }

  private parsePayload(input: RawDataUploadRequest) {
    const envelope = this.asRecord(input.payload);
    const source = envelope.data ?? envelope.result ?? envelope;
    const sourceRecord = this.asRecord(source);

    if (input.target === "course") {
      const courses = this.findArray(source, [
        "courses",
        "courseList",
        "lessons",
      ]);

      if (!courses) {
        throw new BadRequestException(
          "RAW_PAYLOAD_INVALID: course payload must include courses",
        );
      }

      return {
        data: courses.map((course, index) =>
          this.normalizeCourse(course, index),
        ),
        terms: this.findArray(source, ["terms", "semesters"]) ?? [],
        sectionTimes:
          this.findArray(source, ["sectionTimes", "sections"]) ?? [],
        termId: this.asOptionalString(
          sourceRecord.termId ?? sourceRecord.selectedSemesterId,
        ),
        meta: this.asRecord(input.meta),
        count: courses.length,
        warnings: [] as string[],
      };
    }

    const featureData = sourceRecord.data ?? source;
    const count = Array.isArray(featureData)
      ? featureData.length
      : (this.findArray(featureData, [
          "items",
          "records",
          "summary",
          "semesters",
        ])?.length ?? 0);

    return {
      data: featureData ?? null,
      terms: [],
      sectionTimes: [],
      termId: this.asOptionalString(
        sourceRecord.termId ?? sourceRecord.selectedSemesterId,
      ),
      meta: {
        ...this.asRecord(input.meta),
        contentType: input.contentType,
        sourceUrl: input.sourceUrl,
      },
      count,
      warnings: [] as string[],
    };
  }

  private normalizeCourse(value: unknown, index: number) {
    const course = this.asRecord(value);
    const sections = this.normalizeSections(course);
    const startSection = Number(course.startSection ?? sections[0] ?? 1);
    const endSection = Number(
      course.endSection ?? sections[sections.length - 1] ?? startSection,
    );

    return {
      id: this.asOptionalString(course.id) ?? `course-${index + 1}`,
      name:
        this.asOptionalString(course.name) ??
        this.asOptionalString(course.courseName) ??
        "未命名课程",
      teacher:
        this.asOptionalString(course.teacher) ??
        this.asOptionalString(course.teacherName),
      location:
        this.asOptionalString(course.location) ??
        this.asOptionalString(course.classroom) ??
        this.asOptionalString(course.room),
      classroom:
        this.asOptionalString(course.classroom) ??
        this.asOptionalString(course.location) ??
        this.asOptionalString(course.room),
      weekday: Number(course.weekday ?? course.dayOfWeek ?? course.week ?? 0),
      startSection,
      endSection,
      sections:
        sections.length > 0
          ? sections
          : Array.from(
              { length: Math.max(endSection - startSection + 1, 1) },
              (_, sectionIndex) => startSection + sectionIndex,
            ),
      weeks: this.normalizeNumberArray(course.weeks),
      rawWeeks: this.asOptionalString(course.rawWeeks),
    };
  }

  private normalizeSections(course: Record<string, unknown>) {
    const sections = this.normalizeNumberArray(course.sections);

    if (sections.length > 0) {
      return sections;
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

  private normalizeNumberArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  private findArray(value: unknown, keys: string[]): unknown[] | undefined {
    if (Array.isArray(value)) {
      return value;
    }

    const record = this.asRecord(value);

    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }

    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private asOptionalString(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";

    return text || undefined;
  }

  private createSourceHash(input: RawDataUploadRequest) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          target: input.target,
          termId: input.termId,
          contentType: input.contentType,
          payload: input.payload,
        }),
      )
      .digest("hex");
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
