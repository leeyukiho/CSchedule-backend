import { Injectable } from '@nestjs/common'
import { Prisma, StudentAccount } from '@prisma/client'
import { createHash } from 'node:crypto'

import { PrismaService } from '../../common/prisma/prisma.service'

@Injectable()
export class StudentIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateAccount(input: {
    schoolId: string
    providerId: string
    studentNo?: string
    displayName?: string
    data: Omit<
      Prisma.StudentAccountUncheckedCreateInput,
      | 'id'
      | 'schoolId'
      | 'providerId'
      | 'studentNoEncrypted'
      | 'studentNoHash'
    >
  }): Promise<StudentAccount> {
    const rawStudentNo = this.normalizeRawStudentNo(input.studentNo)
    const studentNo = this.normalizeStudentNo(rawStudentNo)
    const studentNoHash = studentNo
      ? this.createStudentNoHash(input.schoolId, studentNo)
      : undefined

    if (studentNoHash) {
      const existingAccount = await this.prisma.studentAccount.findFirst({
        where: {
          schoolId: input.schoolId,
          OR: [
            { studentNoHash },
            {
              studentNoHash: this.createLegacyProviderStudentNoHash(
                input.schoolId,
                input.providerId,
                studentNo,
              ),
            },
            { studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo) },
            { studentNoEncrypted: this.maskStudentNo(studentNo) },
          ],
        },
      })

      if (existingAccount) {
        return this.prisma.studentAccount.update({
          where: { id: existingAccount.id },
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
        })
      }
    }

    return this.prisma.studentAccount.create({
      data: {
        ...input.data,
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
    })
  }

  async bindStudentIdentity(input: {
    accountId: string
    schoolId: string
    providerId: string
    studentNo?: string
    displayName?: string
    authState?: Prisma.InputJsonValue
  }): Promise<StudentAccount> {
    const rawStudentNo = this.normalizeRawStudentNo(input.studentNo)
    const studentNo = this.normalizeStudentNo(rawStudentNo)

    if (!studentNo) {
      return this.prisma.studentAccount.update({
        where: { id: input.accountId },
        data: {
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.authState ? { authState: input.authState } : {}),
        },
      })
    }

    const studentNoHash = this.createStudentNoHash(input.schoolId, studentNo)
    const existingAccount = await this.prisma.studentAccount.findFirst({
      where: {
        schoolId: input.schoolId,
        OR: [
          { studentNoHash },
          {
            studentNoHash: this.createLegacyProviderStudentNoHash(
              input.schoolId,
              input.providerId,
              studentNo,
            ),
          },
          { studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo) },
          { studentNoEncrypted: this.maskStudentNo(studentNo) },
        ],
        NOT: { id: input.accountId },
      },
    })

    if (!existingAccount) {
      return this.prisma.studentAccount.update({
        where: { id: input.accountId },
        data: {
          studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo),
          studentNoHash,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.authState ? { authState: input.authState } : {}),
        },
      })
    }

    const temporaryAccount = await this.prisma.studentAccount.findUnique({
      where: { id: input.accountId },
    })

    if (!temporaryAccount) {
      return existingAccount
    }

    await this.prisma.$transaction([
      this.prisma.courseCache.updateMany({
        where: { accountId: temporaryAccount.id },
        data: { accountId: existingAccount.id },
      }),
      this.prisma.featureCache.updateMany({
        where: { accountId: temporaryAccount.id },
        data: { accountId: existingAccount.id },
      }),
      this.prisma.syncRecord.updateMany({
        where: { accountId: temporaryAccount.id },
        data: { accountId: existingAccount.id },
      }),
      this.prisma.feedbackItem.updateMany({
        where: { accountId: temporaryAccount.id },
        data: { accountId: existingAccount.id },
      }),
      this.prisma.studentAccount.update({
        where: { id: existingAccount.id },
        data: {
          status: temporaryAccount.status,
          authState: this.toNullableJson(
            input.authState ??
              temporaryAccount.authState ??
              existingAccount.authState,
          ),
          cacheState: this.toNullableJson(
            temporaryAccount.cacheState ?? existingAccount.cacheState,
          ),
          sessionReusable: temporaryAccount.sessionReusable,
          sessionRefreshable: temporaryAccount.sessionRefreshable,
          sessionExpireAt: temporaryAccount.sessionExpireAt,
          lastSessionValidatedAt:
            temporaryAccount.lastSessionValidatedAt ??
            existingAccount.lastSessionValidatedAt,
          credentialSaveMode: temporaryAccount.credentialSaveMode,
          lastAuthErrorCode: temporaryAccount.lastAuthErrorCode,
          lastAuthErrorAt: temporaryAccount.lastAuthErrorAt,
          lastLoginAt:
            temporaryAccount.lastLoginAt ?? existingAccount.lastLoginAt,
          lastCachedAt:
            temporaryAccount.lastCachedAt ?? existingAccount.lastCachedAt,
          studentNoEncrypted: this.maskStudentNo(rawStudentNo || studentNo),
          studentNoHash,
          displayName:
            this.normalizeOptionalText(input.displayName) ??
            temporaryAccount.displayName ??
            existingAccount.displayName,
        },
      }),
      this.prisma.studentAccount.delete({
        where: { id: temporaryAccount.id },
      }),
    ])

    const mergedAccount = await this.prisma.studentAccount.findUnique({
      where: { id: existingAccount.id },
    })

    return mergedAccount ?? existingAccount
  }

  extractStudentNo(value: unknown): string | undefined {
    const direct = this.extractFromRecord(this.asRecord(value))
    if (direct) {
      return direct
    }

    const envelope = this.asRecord(value)
    const nestedCandidates = [
      envelope.profile,
      envelope.student,
      envelope.user,
      envelope.data,
      envelope.result,
      this.asRecord(envelope.data).profile,
      this.asRecord(envelope.result).profile,
    ]

    for (const candidate of nestedCandidates) {
      const studentNo = this.extractFromRecord(this.asRecord(candidate))
      if (studentNo) {
        return studentNo
      }
    }

    return undefined
  }

  extractDisplayName(value: unknown): string | undefined {
    const keys = ['name', 'studentName', 'xm', 'XM', 'displayName']
    const records = [
      this.asRecord(value),
      this.asRecord(this.asRecord(value).profile),
      this.asRecord(this.asRecord(value).student),
      this.asRecord(this.asRecord(value).data),
      this.asRecord(this.asRecord(value).result),
      this.asRecord(this.asRecord(this.asRecord(value).data).profile),
      this.asRecord(this.asRecord(this.asRecord(value).result).profile),
    ]

    for (const record of records) {
      for (const key of keys) {
        const text = this.normalizeOptionalText(record[key])
        if (text) {
          return text
        }
      }
    }

    return undefined
  }

  createStudentNoHash(schoolId: string, studentNo: string) {
    return createHash('sha256')
      .update(`${schoolId}:${this.normalizeStudentNo(studentNo)}`)
      .digest('hex')
  }

  private createLegacyProviderStudentNoHash(
    schoolId: string,
    providerId: string,
    studentNo: string,
  ) {
    return createHash('sha256')
      .update(`${schoolId}:${providerId}:${this.normalizeStudentNo(studentNo)}`)
      .digest('hex')
  }

  private extractFromRecord(record: Record<string, unknown>) {
    const keys = [
      'studentNo',
      'studentId',
      'studentNumber',
      'studentCode',
      'xh',
      'XH',
      'account',
    ]

    for (const key of keys) {
      const text = this.normalizeStudentNo(record[key])
      if (text) {
        return text
      }
    }

    return undefined
  }

  private normalizeStudentNo(value: unknown) {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).trim().toLowerCase()
      : ''
  }

  private normalizeRawStudentNo(value: unknown) {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : ''
  }

  private normalizeOptionalText(value: unknown) {
    const text = typeof value === 'string' ? value.trim() : ''
    return text || undefined
  }

  private maskStudentNo(studentNo: string) {
    return `masked:${studentNo}`
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private toNullableJson(
    value: unknown,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    return value === null || value === undefined
      ? Prisma.JsonNull
      : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue)
  }
}
