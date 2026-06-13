import { Body, Controller, Get, Param, Patch, Put, Query, UseGuards } from '@nestjs/common'
import { AdminGuard } from './admin.guard'
import {
  AdminProviderBindingUpsertInput,
  AdminSchoolUpdateInput,
  AdminService,
} from './admin.service'
import { SchoolStatus } from '@prisma/client'

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats()
  }

  @Get('schools')
  listSchools(
    @Query('keyword') keyword?: string,
    @Query('status') status?: SchoolStatus,
    @Query('enabled') enabled?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminService.listAllSchools({
      keyword,
      status,
      enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Patch('schools/:schoolId')
  updateSchool(
    @Param('schoolId') schoolId: string,
    @Body() input: AdminSchoolUpdateInput,
  ) {
    return this.adminService.updateSchool(schoolId, input)
  }

  @Put('schools/:schoolId/provider-binding')
  upsertProviderBinding(
    @Param('schoolId') schoolId: string,
    @Body() input: AdminProviderBindingUpsertInput,
  ) {
    return this.adminService.upsertProviderBinding(schoolId, input)
  }

  @Get('submissions')
  listSubmissions(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminService.listSubmissions({
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Patch('submissions/:submissionId')
  updateSubmission(
    @Param('submissionId') submissionId: string,
    @Body() input: { status?: string; review?: Record<string, unknown> },
  ) {
    return this.adminService.updateSubmission(submissionId, input)
  }

  @Get('feedback')
  listFeedback(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminService.listFeedback({
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }
}
