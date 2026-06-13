import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AdminController } from './admin.controller'
import { AdminGuard } from './admin.guard'
import { AdminService } from './admin.service'
import { PrismaModule } from '../../common/prisma/prisma.module'

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
