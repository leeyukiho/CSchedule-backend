import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../accounts/student-identity.service";
import { ProviderDisplayService } from "../providers/provider-display.service";
import { DataAccessMode, DataTarget } from "../providers/provider.types";
import { ProviderRegistryService } from "../providers/provider-registry.service";

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

const RAW_DATA_TARGETS: DataTarget[] = ["course", "score", "exam", "profile"];
const RAW_DATA_ACCESS_MODES: RawDataUploadRequest["accessMode"][] = [
  "webview_client_fetch",
  "manual_import",
];
const RAW_DATA_CONTENT_TYPES: RawDataUploadRequest["contentType"][] = [
  "json",
  "html",
  "text",
  "csv",
  "xlsx",
  "ics",
  "pdf",
];
const MAX_RAW_COURSE_ITEMS = 500;
const MAX_RAW_FEATURE_ITEMS = 1000;
const MAX_RAW_PAYLOAD_DEPTH = 12;
const MAX_RAW_PAYLOAD_ARRAY_ITEMS = 5000;
const MAX_RAW_PAYLOAD_OBJECT_KEYS = 2000;
const MAX_RAW_PAYLOAD_NODES = 12000;
const MAX_RAW_PAYLOAD_STRING_LENGTH = 1024 * 1024;
const BACKEND_RAW_CONTENT_TYPES: RawDataUploadRequest["contentType"][] = [
  "json",
];

@Injectable()
export class RawDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentIdentity: StudentIdentityService,
    private readonly providerDisplay: ProviderDisplayService,
    private readonly providers: ProviderRegistryService,
  ) {}

  async uploadRawData(accountId: string, input: RawDataUploadRequest) {
    let account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: { school: true },
    });

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    if (!input.target || !input.accessMode || !input.contentType) {
      throw new BadRequestException(
        "target, accessMode and contentType are required",
      );
    }

    this.validateRawDataInput(account.providerId, input);

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
      const identityAccount = await this.studentIdentity.bindStudentIdentity({
        accountId: account.id,
        schoolId: account.schoolId,
        providerId: account.providerId,
        studentNo,
        displayName,
      });
      account = await this.prisma.studentAccount.findUnique({
        where: { id: identityAccount.id },
        include: { school: true },
      });

      if (!account) {
        throw new NotFoundException("Student account not found");
      }
    }

    const sourceHash = this.createSourceHash(input);
    const syncedAt = new Date();
    let cacheId = sourceHash;
    const termId = input.termId ?? parsed.termId;
    const session = {
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      accountStatus: "active",
    };
    const display = this.providerDisplay.getDisplay(
      account.school?.config ?? null,
      account.providerId,
      input.target,
    );
    let cacheData: Record<string, unknown>;

    if (input.target === "course") {
      const cache = await this.prisma.courseCache.upsert({
        where: {
          courseCacheAccountSourceHash: {
            accountId: account.id,
            sourceHash,
          },
        },
        update: {
          termId,
          coursesJson: this.toJson(parsed.data),
          termsJson: this.toJson(parsed.terms),
          sectionTimesJson: this.toJson(parsed.sectionTimes),
          syncedAt,
        },
        create: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          termId,
          coursesJson: this.toJson(parsed.data),
          termsJson: this.toJson(parsed.terms),
          sectionTimesJson: this.toJson(parsed.sectionTimes),
          sourceHash,
          syncedAt,
        },
      });

      cacheId = cache.id;
      cacheData = {
        accountId: account.id,
        schoolId: account.schoolId,
        providerId: account.providerId,
        termId,
        courses: parsed.data,
        terms: parsed.terms,
        sectionTimes: parsed.sectionTimes,
        display,
        sourceHash,
        syncedAt: syncedAt.toISOString(),
        session,
      };
    } else {
      const cache = await this.prisma.featureCache.upsert({
        where: {
          featureCacheAccountTargetSourceHash: {
            accountId: account.id,
            target: input.target,
            sourceHash,
          },
        },
        update: {
          termId,
          dataJson: this.toJson(parsed.data),
          metaJson: this.toJson(parsed.meta),
          syncedAt,
        },
        create: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target: input.target,
          termId,
          dataJson: this.toJson(parsed.data),
          metaJson: this.toJson(parsed.meta),
          sourceHash,
          syncedAt,
        },
      });

      cacheId = cache.id;
      cacheData = {
        accountId: account.id,
        schoolId: account.schoolId,
        providerId: account.providerId,
        target: input.target,
        termId,
        data: parsed.data,
        meta: parsed.meta,
        display,
        sourceHash,
        syncedAt: syncedAt.toISOString(),
        session,
      };
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
              termId,
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
      cacheId,
      sourceHash,
      status: "cached",
      parsedCount: parsed.count,
      warnings: parsed.warnings,
      cacheData,
      syncStatus: {
        status: "ready",
        canCloseWebview: input.target === "course",
        missingRequiredTargets: input.target === "course" ? [] : ["course"],
      },
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

  private validateRawDataInput(providerId: string, input: RawDataUploadRequest) {
    if (!RAW_DATA_TARGETS.includes(input.target)) {
      throw new BadRequestException("RAW_TARGET_INVALID");
    }

    if (!RAW_DATA_ACCESS_MODES.includes(input.accessMode)) {
      throw new BadRequestException("RAW_ACCESS_MODE_INVALID");
    }

    if (!RAW_DATA_CONTENT_TYPES.includes(input.contentType)) {
      throw new BadRequestException("RAW_CONTENT_TYPE_INVALID");
    }

    if (!BACKEND_RAW_CONTENT_TYPES.includes(input.contentType)) {
      throw new BadRequestException(
        "PARSER_NOT_FOUND: send non-json raw payload to cloud parser before backend upload",
      );
    }

    this.assertProviderAccessMode(providerId, input);

    if (input.contentType === "json" && !this.isJsonPayload(input.payload)) {
      throw new BadRequestException(
        "RAW_PAYLOAD_INVALID: json payload must be an object or array",
      );
    }

    if (input.meta !== undefined && !this.isPlainRecord(input.meta)) {
      throw new BadRequestException("RAW_META_INVALID: meta must be an object");
    }

    this.assertPayloadBounds(input.payload);

    if (input.meta !== undefined) {
      this.assertPayloadBounds(input.meta);
    }
  }

  private isJsonPayload(value: unknown) {
    return value !== null && typeof value === "object";
  }

  private assertPayloadBounds(
    value: unknown,
    depth = 0,
    stats: { nodes: number } = { nodes: 0 },
  ) {
    stats.nodes += 1;

    if (stats.nodes > MAX_RAW_PAYLOAD_NODES) {
      throw new BadRequestException("RAW_PAYLOAD_TOO_LARGE: too many fields");
    }

    if (depth > MAX_RAW_PAYLOAD_DEPTH) {
      throw new BadRequestException("RAW_PAYLOAD_TOO_DEEP");
    }

    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      if (value.length > MAX_RAW_PAYLOAD_STRING_LENGTH) {
        throw new BadRequestException(
          "RAW_PAYLOAD_TOO_LARGE: string field is too large",
        );
      }
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_RAW_PAYLOAD_ARRAY_ITEMS) {
        throw new BadRequestException(
          "RAW_PAYLOAD_TOO_LARGE: array field has too many items",
        );
      }

      for (const item of value) {
        this.assertPayloadBounds(item, depth + 1, stats);
      }
      return;
    }

    if (!this.isPlainRecord(value)) {
      throw new BadRequestException(
        "RAW_PAYLOAD_INVALID: payload must be JSON-compatible",
      );
    }

    const keys = Object.keys(value);

    if (keys.length > MAX_RAW_PAYLOAD_OBJECT_KEYS) {
      throw new BadRequestException(
        "RAW_PAYLOAD_TOO_LARGE: object has too many fields",
      );
    }

    for (const key of keys) {
      this.assertPayloadBounds(value[key], depth + 1, stats);
    }
  }

  private parsePayload(input: RawDataUploadRequest) {
    const envelope = this.asRecord(input.payload);
    const source =
      this.isPlainRecord(input.payload) && Object.keys(envelope).length > 0
        ? envelope.cacheData ?? envelope.data ?? envelope.result ?? envelope
        : input.payload;
    const sourceRecord = this.asRecord(source);

    if (input.target === "course") {
      if (input.contentType !== "json") {
        throw new BadRequestException(
          "RAW_CONTENT_TYPE_UNSUPPORTED: course payload must be json",
        );
      }

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

      if (courses.length > MAX_RAW_COURSE_ITEMS) {
        throw new BadRequestException(
          `RAW_PAYLOAD_TOO_LARGE: course payload must include at most ${MAX_RAW_COURSE_ITEMS} courses`,
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

    const featureData =
      envelope.cacheData && envelope.target === input.target
        ? sourceRecord.data
        : sourceRecord.data ?? source;
    const count = Array.isArray(featureData)
      ? featureData.length
      : (this.findArray(featureData, [
          "items",
          "records",
          "summary",
          "semesters",
        ])?.length ?? 0);

    if (count > MAX_RAW_FEATURE_ITEMS) {
      throw new BadRequestException(
        `RAW_PAYLOAD_TOO_LARGE: feature payload must include at most ${MAX_RAW_FEATURE_ITEMS} items`,
      );
    }

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

  private assertProviderAccessMode(
    providerId: string,
    input: RawDataUploadRequest,
  ) {
    const provider = this.providers.getProvider(providerId);
    const accessModes = provider.meta.dataAccess[input.target] ?? [];

    if (!accessModes.includes(input.accessMode)) {
      throw new BadRequestException(
        "WEBVIEW_CLIENT_FETCH_REQUIRED: provider does not allow this raw-data access mode",
      );
    }

    if (!provider.meta.capabilities[input.target]) {
      throw new BadRequestException(
        `UNSUPPORTED_SCHOOL: ${input.target} is not enabled for this provider`,
      );
    }
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return this.isPlainRecord(value) ? value : {};
  }

  private asOptionalString(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";

    return text || undefined;
  }

  private createSourceHash(input: RawDataUploadRequest) {
    const payload = this.getStableHashPayload(input.payload);

    return createHash("sha256")
      .update(
        JSON.stringify({
          target: input.target,
          termId: input.termId,
          contentType: input.contentType,
          payload,
        }),
      )
      .digest("hex");
  }

  private getStableHashPayload(payload: unknown): unknown {
    const record = this.asRecord(payload);

    if (!record.cacheData && !record.courses && record.data === undefined) {
      return payload;
    }

    const source = this.asRecord(record.cacheData ?? record);

    return {
      target: source.target,
      termId: source.termId,
      courses: source.courses,
      terms: source.terms,
      sectionTimes: source.sectionTimes,
      data: source.data,
      meta: source.meta,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
