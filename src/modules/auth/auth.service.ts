import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { CredentialVaultService } from "../../common/crypto/credential-vault.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../accounts/student-identity.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { DataTarget } from "../providers/provider.types";
import { CourseSyncService } from "../sync/course-sync.service";
import { LoginSubmitRequest, LoginSubmitResponse } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentIdentity: StudentIdentityService,
    private readonly providers: ProviderRegistryService,
    private readonly credentialVault: CredentialVaultService,
    private readonly courseSync: CourseSyncService,
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

    if (!input.contextId) {
      throw new BadRequestException("contextId is required");
    }

    const providerId = existingSchool.providerId ?? schoolId;
    const loginMode = existingSchool.loginMode ?? "direct_password";
    const credentialSaveMode = this.getCredentialSaveMode(providerId, input);
    const target = input.target ?? "course";

    if (
      credentialSaveMode === "password_vault" &&
      (!input.username || !input.password || !input.verifiedByCloud)
    ) {
      throw new BadRequestException(
        "verified username and password are required when saving credentials",
      );
    }

    if (input.verifiedByCloud && !input.cacheData) {
      throw new BadRequestException(
        "cacheData is required when cloud verification succeeds",
      );
    }

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
    const authState = this.toJson({
      contextId: input.contextId,
      loginMode,
      frontendFirst: true,
      cloudVerified: Boolean(input.verifiedByCloud),
      cloudVerifiedAt: input.verifiedByCloud ? new Date().toISOString() : undefined,
      cloudWarnings: input.cloudWarnings,
      ...(authStatePatch || {}),
    });
    const account = await this.studentIdentity.findOrCreateAccount({
      schoolId,
      providerId,
      studentNo: input.username,
      data: {
        status: "need_login",
        authState,
        cacheState: {},
        sessionReusable: false,
        sessionRefreshable: false,
        credentialSaveMode,
        lastLoginAt: new Date(),
        lastAuthErrorCode: null,
        lastAuthErrorAt: null,
      },
    });

    if (input.verifiedByCloud && input.cacheData) {
      const cache = await this.courseSync.writeCloudCacheResult({
        accountId: account.id,
        target,
        cacheData: input.cacheData,
        credentialSaveMode,
        authStatePatch: {
          ...this.asRecord(account.authState),
          ...this.asRecord(authState),
          cloudVerified: true,
          cloudVerifiedAt: new Date().toISOString(),
          cloudWarnings: input.cloudWarnings,
        },
      });

      return {
        accountId: account.id,
        status: "cached",
        sessionReusable: false,
        requiredFetchTargets: [],
        cacheId: cache.cacheId,
        parsedCount: input.parsedCount ?? cache.parsedCount,
      };
    }

    return {
      accountId: account.id,
      status: "need_webview_fetch",
      sessionReusable: false,
      requiredFetchTargets: this.getRequiredFetchTargets(
        existingSchool.capabilities,
      ),
    };
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

  private getRequiredFetchTargets(capabilities: unknown): DataTarget[] {
    const source =
      capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
        ? (capabilities as Partial<Record<DataTarget, unknown>>)
        : {};

    if (source.course) {
      return ["course"];
    }

    for (const target of ["profile", "score", "exam"] as DataTarget[]) {
      if (source[target]) {
        return [target];
      }
    }

    return ["course"];
  }

  private assertSchoolAvailable(school: { enabled: boolean; status: string }) {
    if (!school.enabled || school.status !== "enabled") {
      throw new NotFoundException("School not available");
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
