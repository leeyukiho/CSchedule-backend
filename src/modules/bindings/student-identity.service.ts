import { Injectable } from "@nestjs/common";
import { Prisma, UserSchoolBinding } from "@prisma/client";
import { createHash } from "node:crypto";

import { PrismaService } from "../../common/prisma/prisma.service";

@Injectable()
export class StudentIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateBinding(input: {
    schoolId: string;
    providerId: string;
    studentNo?: string;
    displayName?: string;
    data: Omit<
      Prisma.UserSchoolBindingUncheckedCreateInput,
      | "id"
      | "userId"
      | "schoolId"
      | "providerId"
      | "studentNoEncrypted"
      | "studentNoHash"
    >;
  }): Promise<UserSchoolBinding> {
    const rawStudentNo = this.normalizeRawStudentNo(input.studentNo);
    const studentNo = this.normalizeStudentNo(rawStudentNo);
    const studentNoHash = studentNo
      ? this.createStudentNoHash(input.schoolId, input.providerId, studentNo)
      : undefined;

    if (studentNoHash) {
      const existingBinding = await this.prisma.userSchoolBinding.findFirst({
        where: {
          schoolId: input.schoolId,
          providerId: input.providerId,
          OR: [
            { studentNoHash },
            { studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo) },
            { studentNoEncrypted: this.maskStudentNo(studentNo) },
          ],
        },
      });

      if (existingBinding) {
        return this.prisma.userSchoolBinding.update({
          where: { id: existingBinding.id },
          data: {
            ...input.data,
            schoolId: input.schoolId,
            providerId: input.providerId,
            studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo),
            studentNoHash,
            displayName:
              this.normalizeOptionalText(input.displayName) ??
              input.data.displayName,
          },
        });
      }
    }

    const user = await this.prisma.user.create({ data: {} });

    return this.prisma.userSchoolBinding.create({
      data: {
        ...input.data,
        userId: user.id,
        schoolId: input.schoolId,
        providerId: input.providerId,
        studentNoEncrypted: studentNo
          ? this.maskStudentNo(rawStudentNo || studentNo)
          : undefined,
        studentNoHash,
        displayName:
          this.normalizeOptionalText(input.displayName) ??
          input.data.displayName,
      },
    });
  }

  async bindStudentIdentity(input: {
    bindingId: string;
    schoolId: string;
    providerId: string;
    studentNo?: string;
    displayName?: string;
    authState?: Prisma.InputJsonValue;
  }): Promise<UserSchoolBinding> {
    const rawStudentNo = this.normalizeRawStudentNo(input.studentNo);
    const studentNo = this.normalizeStudentNo(rawStudentNo);

    if (!studentNo) {
      return this.prisma.userSchoolBinding.update({
        where: { id: input.bindingId },
        data: {
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.authState ? { authState: input.authState } : {}),
        },
      });
    }

    const studentNoHash = this.createStudentNoHash(
      input.schoolId,
      input.providerId,
      studentNo,
    );
    const existingBinding = await this.prisma.userSchoolBinding.findFirst({
      where: {
        schoolId: input.schoolId,
        providerId: input.providerId,
        OR: [
          { studentNoHash },
          { studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo) },
          { studentNoEncrypted: this.maskStudentNo(studentNo) },
        ],
        NOT: { id: input.bindingId },
      },
    });

    if (!existingBinding) {
      return this.prisma.userSchoolBinding.update({
        where: { id: input.bindingId },
        data: {
          studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo),
          studentNoHash,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.authState ? { authState: input.authState } : {}),
        },
      });
    }

    const temporaryBinding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: input.bindingId },
    });

    if (!temporaryBinding) {
      return existingBinding;
    }

    await this.prisma.$transaction([
      this.prisma.courseCache.updateMany({
        where: { bindingId: temporaryBinding.id },
        data: { userId: existingBinding.userId, bindingId: existingBinding.id },
      }),
      this.prisma.featureCache.updateMany({
        where: { bindingId: temporaryBinding.id },
        data: { userId: existingBinding.userId, bindingId: existingBinding.id },
      }),
      this.prisma.syncRecord.updateMany({
        where: { bindingId: temporaryBinding.id },
        data: { userId: existingBinding.userId, bindingId: existingBinding.id },
      }),
      this.prisma.feedbackItem.updateMany({
        where: { bindingId: temporaryBinding.id },
        data: { userId: existingBinding.userId, bindingId: existingBinding.id },
      }),
      this.prisma.userSchoolBinding.update({
        where: { id: existingBinding.id },
        data: {
          status: temporaryBinding.status,
          authState: this.toNullableJson(
            input.authState ??
              temporaryBinding.authState ??
              existingBinding.authState,
          ),
          cacheState: this.toNullableJson(
            temporaryBinding.cacheState ?? existingBinding.cacheState,
          ),
          sessionReusable: temporaryBinding.sessionReusable,
          sessionRefreshable: temporaryBinding.sessionRefreshable,
          sessionExpireAt: temporaryBinding.sessionExpireAt,
          lastSessionValidatedAt:
            temporaryBinding.lastSessionValidatedAt ??
            existingBinding.lastSessionValidatedAt,
          credentialSaveMode: temporaryBinding.credentialSaveMode,
          lastAuthErrorCode: temporaryBinding.lastAuthErrorCode,
          lastAuthErrorAt: temporaryBinding.lastAuthErrorAt,
          lastLoginAt:
            temporaryBinding.lastLoginAt ?? existingBinding.lastLoginAt,
          lastCachedAt:
            temporaryBinding.lastCachedAt ?? existingBinding.lastCachedAt,
          studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo),
          studentNoHash,
          displayName:
            this.normalizeOptionalText(input.displayName) ??
            temporaryBinding.displayName ??
            existingBinding.displayName,
        },
      }),
      this.prisma.userSchoolBinding.delete({
        where: { id: temporaryBinding.id },
      }),
    ]);

    await this.deleteUserIfUnused(temporaryBinding.userId);

    const mergedBinding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: existingBinding.id },
    });

    return mergedBinding ?? existingBinding;
  }

  extractStudentNo(value: unknown): string | undefined {
    const direct = this.extractFromRecord(this.asRecord(value));
    if (direct) {
      return direct;
    }

    const envelope = this.asRecord(value);
    const nestedCandidates = [
      envelope.profile,
      envelope.student,
      envelope.user,
      envelope.data,
      envelope.result,
      this.asRecord(envelope.data).profile,
      this.asRecord(envelope.result).profile,
    ];

    for (const candidate of nestedCandidates) {
      const studentNo = this.extractFromRecord(this.asRecord(candidate));
      if (studentNo) {
        return studentNo;
      }
    }

    return undefined;
  }

  extractDisplayName(value: unknown): string | undefined {
    const keys = ["name", "studentName", "xm", "XM", "displayName"];
    const records = [
      this.asRecord(value),
      this.asRecord(this.asRecord(value).profile),
      this.asRecord(this.asRecord(value).student),
      this.asRecord(this.asRecord(value).data),
      this.asRecord(this.asRecord(value).result),
      this.asRecord(this.asRecord(this.asRecord(value).data).profile),
      this.asRecord(this.asRecord(this.asRecord(value).result).profile),
    ];

    for (const record of records) {
      for (const key of keys) {
        const text = this.normalizeOptionalText(record[key]);
        if (text) {
          return text;
        }
      }
    }

    return undefined;
  }

  createStudentNoHash(schoolId: string, providerId: string, studentNo: string) {
    return createHash("sha256")
      .update(`${schoolId}:${providerId}:${this.normalizeStudentNo(studentNo)}`)
      .digest("hex");
  }

  private extractFromRecord(record: Record<string, unknown>) {
    const keys = [
      "studentNo",
      "studentId",
      "studentNumber",
      "studentCode",
      "xh",
      "XH",
      "account",
    ];

    for (const key of keys) {
      const text = this.normalizeStudentNo(record[key]);
      if (text) {
        return text;
      }
    }

    return undefined;
  }

  private async deleteUserIfUnused(userId: string) {
    const bindingCount = await this.prisma.userSchoolBinding.count({
      where: { userId },
    });

    if (bindingCount === 0) {
      await this.prisma.user.delete({
        where: { id: userId },
      });
    }
  }

  private normalizeStudentNo(value: unknown) {
    return typeof value === "string" || typeof value === "number"
      ? String(value).trim().toLowerCase()
      : "";
  }

  private normalizeRawStudentNo(value: unknown) {
    return typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  }

  private normalizeOptionalText(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
  }

  private maskStudentNo(studentNo: string) {
    return `masked:${studentNo}`;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private toNullableJson(
    value: unknown,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    return value === null || value === undefined
      ? Prisma.JsonNull
      : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
  }
}
