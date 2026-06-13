import { Module } from "@nestjs/common";

import { BindingsModule } from "../bindings/bindings.module";
import { ProvidersModule } from "../providers/providers.module";
import { CourseSyncService } from "../sync/course-sync.service";
import { AuthController, SessionImportController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [BindingsModule, ProvidersModule],
  controllers: [AuthController, SessionImportController],
  providers: [AuthService, CourseSyncService],
  exports: [AuthService],
})
export class AuthModule {}
