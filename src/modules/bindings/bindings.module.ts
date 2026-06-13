import { Module } from "@nestjs/common";

import { PrismaModule } from "../../common/prisma/prisma.module";
import { BindingsController } from "./bindings.controller";
import { BindingsService } from "./bindings.service";
import { StudentIdentityService } from "./student-identity.service";

@Module({
  imports: [PrismaModule],
  controllers: [BindingsController],
  providers: [BindingsService, StudentIdentityService],
  exports: [BindingsService, StudentIdentityService],
})
export class BindingsModule {}
