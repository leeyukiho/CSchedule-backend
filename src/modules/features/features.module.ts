import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { ProvidersModule } from '../providers/providers.module'
import { FeaturesController } from './features.controller'
import { FeaturesService } from './features.service'

@Module({
  imports: [PrismaModule, ProvidersModule],
  controllers: [FeaturesController],
  providers: [FeaturesService],
})
export class FeaturesModule {}
