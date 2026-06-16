import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { ProvidersModule } from "../providers/providers.module";
import { RawDataController } from "./raw-data.controller";
import { RawDataService } from "./raw-data.service";

@Module({
  imports: [AccountsModule, PrismaModule, ProvidersModule],
  controllers: [RawDataController],
  providers: [RawDataService],
})
export class RawDataModule {}
