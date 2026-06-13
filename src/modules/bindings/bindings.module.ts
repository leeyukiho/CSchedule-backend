import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { BindingsController } from './bindings.controller'
import { BindingsService } from './bindings.service'

@Module({
  imports: [PrismaModule],
  controllers: [BindingsController],
  providers: [BindingsService],
  exports: [BindingsService],
})
export class BindingsModule {}

