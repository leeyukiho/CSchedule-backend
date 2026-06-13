import { Module } from "@nestjs/common";

import { BindingsModule } from "../bindings/bindings.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { RawDataController } from "./raw-data.controller";
import { RawDataService } from "./raw-data.service";

@Module({
  imports: [BindingsModule, PrismaModule],
  controllers: [RawDataController],
  providers: [RawDataService],
})
export class RawDataModule {}
