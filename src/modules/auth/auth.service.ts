import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { CredentialVaultService } from "../../common/crypto/credential-vault.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../accounts/student-identity.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { CourseSyncService } from "../sync/course-sync.service";
import { LoginSubmitRequest, LoginSubmitResponse } from "./auth.types";

const INVALID_CREDENTIAL_PATTERN =
  /\u5b66\u53f7\u6216\u5bc6\u7801\u9519\u8bef|\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef|\u8d26\u53f7\u6216\u5bc6\u7801\u9519\u8bef|\u7528\u6237\u4e0d\u5b58\u5728|invalid credentials?/i;
const LOGIN_SYNC_MAX_ATTEMPTS = 3;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseSync: CourseSyncService,
    private readonly studentIdentity: StudentIdentityService,
    private readonly providers: ProviderRegistryService,
    private readonly credentialVault: CredentialVaultService,
  ) {}

  async submitLogin(
    schoolId: string,
    input: LoginSubmitRequest,
  ): Promise<LoginSubmitResponse> {
    const existingSchool = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!existingSchool) {
      throw new NotFoundException("School not found");
    }

    this.assertSchoolAvailable(existingSchool);

    const loginMode = existingSchool.loginMode ?? "direct_password";

    if (!input.contextId) {
      throw new BadRequestException("contextId is required");
    }

    if (loginMode !== "cas_webview" && !input.username) {
      throw new BadRequestException("username is required");
    }

    if (loginMode !== "cas_webview" && !input.password) {
      throw new BadRequestException("password is required");
    }

    const providerId = existingSchool.providerId ?? schoolId;
    const credentialSaveMode = this.getCredentialSaveMode(providerId, input);
    const authStatePatch =
      credentialSaveMode === "password_vault" && input.username && input.password
        ? {
            credentialVault: {
              username: this.credentialVault.encrypt(input.username),
              password: this.credentialVault.encrypt(input.password),
              savedAt: new Date().toISOString(),
              providerId,
            },
          }
        : undefined;
    const account = await this.studentIdentity.findOrCreateAccount({
      schoolId,
      providerId,
      studentNo: input.username,
      data: {
        status: "need_login",
        authState: this.toJson({
          contextId: input.contextId,
          loginMode,
          ...(authStatePatch || {}),
        }),
        cacheState: {},
        sessionReusable: false,
        sessionRefreshable: false,
        credentialSaveMode,
        lastLoginAt: new Date(),
      },
    });

    if (loginMode === "cas_webview") {
      return {
        accountId: account.id,
        status: "need_webview_fetch",
        sessionReusable: false,
        requiredFetchTargets: ["course"],
      };
    }

    try {
      let latestError: unknown;

      for (let attempt = 1; attempt <= LOGIN_SYNC_MAX_ATTEMPTS; attempt += 1) {
        try {
          const cache = await this.courseSync.fetchAndCacheByCredentials({
            accountId: account.id,
            username: input.username || "",
            password: input.password || "",
            semesterId:
              typeof input.extra?.semesterId === "string"
                ? input.extra.semesterId
                : undefined,
            allSemesters: true,
            credentialSaveMode,
            authStatePatch,
          });

          return {
            accountId: cache.accountId,
            status: "cached",
            sessionReusable: false,
            requiredFetchTargets: [],
            cacheId: cache.cacheId,
            parsedCount: cache.parsedCount,
          };
        } catch (error) {
          latestError = error;

          if (this.isInvalidCredentialError(error)) {
            throw error;
          }

          if (attempt < LOGIN_SYNC_MAX_ATTEMPTS) {
            await this.sleep(700);
          }
        }
      }

      throw latestError;
    } catch (error) {
      const authErrorCode = this.isInvalidCredentialError(error)
        ? "INVALID_CREDENTIAL"
        : "SYNC_FAILED";

      await this.prisma.studentAccount.update({
        where: { id: account.id },
        data: {
          status: "need_login",
          lastAuthErrorCode: authErrorCode,
          lastAuthErrorAt: new Date(),
        },
      });

      throw this.toSyncException(error);
    }
  }

  async importSession(
    schoolId: string,
    input: { contextId?: string; accountId?: string; session?: unknown },
  ) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new NotFoundException("School not found");
    }

    this.assertSchoolAvailable(school);

    const account = input.accountId
      ? await this.prisma.studentAccount.findUnique({
          where: { id: input.accountId },
        })
      : await this.createWebviewAccount(
          schoolId,
          school.providerId ?? schoolId,
          input.contextId,
        );

    if (!account) {
      throw new NotFoundException("Student account not found");
    }

    await this.prisma.studentAccount.update({
      where: { id: account.id },
      data: {
        status: "need_login",
        authState: {
          contextId: input.contextId,
          loginMode: school.loginMode ?? "cas_webview",
          sessionImportAttempted: true,
        },
        lastAuthErrorCode: "SESSION_IMPORT_FAILED",
        lastAuthErrorAt: new Date(),
      },
    });

    return {
      status: "need_webview_client_fetch",
      accountId: account.id,
      requiredFetchTargets: ["course"],
      message:
        "Session import is not available for this provider. Fetch data inside WebView and upload raw-data.",
    };
  }

  private async createWebviewAccount(
    schoolId: string,
    providerId: string,
    contextId?: string,
  ) {
    return this.studentIdentity.findOrCreateAccount({
      schoolId,
      providerId,
      data: {
        status: "need_login",
        authState: {
          contextId,
          loginMode: "cas_webview",
        },
        cacheState: {},
        sessionReusable: false,
        sessionRefreshable: false,
        credentialSaveMode: "none",
        lastLoginAt: new Date(),
      },
    });
  }

  private toSyncException(error: unknown) {
    if (error instanceof HttpException) {
      return error;
    }

    const message = error instanceof Error ? error.message : "";

    if (this.isInvalidCredentialError(error)) {
      return new UnauthorizedException(
        message || "\u5b66\u53f7\u6216\u5bc6\u7801\u9519\u8bef",
      );
    }

    return new BadGatewayException(
      message
        ? `\u6559\u52a1\u7cfb\u7edf\u6570\u636e\u540c\u6b65\u5931\u8d25\uff1a${message}`
        : "\u6559\u52a1\u7cfb\u7edf\u6682\u65f6\u65e0\u6cd5\u8bbf\u95ee",
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isInvalidCredentialError(error: unknown) {
    const message = error instanceof Error ? error.message : "";

    return INVALID_CREDENTIAL_PATTERN.test(message);
  }

  private getCredentialSaveMode(
    providerId: string,
    input: LoginSubmitRequest,
  ): "none" | "password_vault" {
    if (input.credentialSaveMode !== "password_vault") {
      return "none";
    }

    const provider = this.providers.getProvider(providerId);

    if (!provider.meta.credentialSave?.passwordVaultAllowed) {
      throw new BadRequestException(
        "CREDENTIAL_SAVE_UNSUPPORTED: this school does not support saved credentials",
      );
    }

    return "password_vault";
  }

  private assertSchoolAvailable(school: { enabled: boolean; status: string }) {
    if (!school.enabled || school.status !== "enabled") {
      throw new NotFoundException("School not available");
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private toLoginException(error: unknown) {
    if (error instanceof HttpException) {
      return error;
    }

    const message = error instanceof Error ? error.message : "";

    if (/学号|密码|credential|login/i.test(message)) {
      return new UnauthorizedException(message || "学号或密码错误");
    }

    return new BadGatewayException(
      message ? `教务系统登录失败：${message}` : "教务系统暂时无法访问",
    );
  }
}
