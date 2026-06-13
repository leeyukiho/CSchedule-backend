import { Module } from "@nestjs/common";

import { BindingsModule } from "../bindings/bindings.module";
import { ProvidersModule } from "../providers/providers.module";
import { CourseSyncService } from "./course-sync.service";
import { BindingSyncController, SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";

@Module({
  imports: [BindingsModule, ProvidersModule],
  controllers: [SyncController, BindingSyncController],
  providers: [SyncService, CourseSyncService],
  exports: [SyncService, CourseSyncService],
})
export class SyncModule {}
