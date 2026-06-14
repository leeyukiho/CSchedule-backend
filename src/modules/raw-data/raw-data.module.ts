import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { RawDataController } from "./raw-data.controller";
import { RawDataService } from "./raw-data.service";

@Module({
  imports: [AccountsModule, PrismaModule],
  controllers: [RawDataController],
  providers: [RawDataService],
})
export class RawDataModule {}
