import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service";
import { StudentIdentityService } from "../bindings/student-identity.service";
import { CourseSyncService } from "../sync/course-sync.service";
import { LoginSubmitRequest, LoginSubmitResponse } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseSync: CourseSyncService,
    private readonly studentIdentity: StudentIdentityService,
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
    const binding = await this.studentIdentity.findOrCreateBinding({
      schoolId,
      providerId,
      studentNo: input.username,
      data: {
        status: "need_login",
        authState: {
          contextId: input.contextId,
          loginMode,
        },
        cacheState: {},
        sessionReusable: false,
        sessionRefreshable: false,
        credentialSaveMode: "none",
        lastLoginAt: new Date(),
      },
    });

    if (loginMode === "cas_webview") {
      return {
        bindingId: binding.id,
        status: "need_webview_fetch",
        sessionReusable: false,
        requiredFetchTargets: ["course"],
      };
    }

    try {
      const cache = await this.courseSync.fetchAndCacheByCredentials({
        bindingId: binding.id,
        username: input.username || "",
        password: input.password || "",
        semesterId:
          typeof input.extra?.semesterId === "string"
            ? input.extra.semesterId
            : undefined,
      });

      return {
        bindingId: cache.bindingId,
        status: "cached",
        sessionReusable: false,
        requiredFetchTargets: [],
        cacheId: cache.cacheId,
        parsedCount: cache.parsedCount,
      };
    } catch (error) {
      await this.prisma.userSchoolBinding.update({
        where: { id: binding.id },
        data: {
          status: "need_login",
          lastAuthErrorCode: "INVALID_CREDENTIAL",
          lastAuthErrorAt: new Date(),
        },
      });

      throw this.toLoginException(error);
    }
  }

  async importSession(
    schoolId: string,
    input: { contextId?: string; bindingId?: string; session?: unknown },
  ) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new NotFoundException("School not found");
    }

    const binding = input.bindingId
      ? await this.prisma.userSchoolBinding.findUnique({
          where: { id: input.bindingId },
        })
      : await this.createWebviewBinding(
          schoolId,
          school.providerId ?? schoolId,
          input.contextId,
        );

    if (!binding) {
      throw new NotFoundException("Binding not found");
    }

    await this.prisma.userSchoolBinding.update({
      where: { id: binding.id },
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
      bindingId: binding.id,
      requiredFetchTargets: ["course"],
      message:
        "Session import is not available for this provider. Fetch data inside WebView and upload raw-data.",
    };
  }

  private async createWebviewBinding(
    schoolId: string,
    providerId: string,
    contextId?: string,
  ) {
    return this.studentIdentity.findOrCreateBinding({
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
