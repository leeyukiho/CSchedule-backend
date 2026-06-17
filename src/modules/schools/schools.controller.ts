import { Controller, Get, Param, Post, Query } from '@nestjs/common'

import { SchoolsService } from './schools.service'

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Get()
  listSchools(
    @Query('keyword') keyword?: string,
    @Query('enabledOnly') enabledOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('fields') fields?: string,
  ) {
    return this.schoolsService.listSchools(
      keyword,
      enabledOnly !== 'false',
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
      fields === 'summary' ? 'summary' : 'full',
    )
  }

  @Post(':schoolId/login-context')
  createLoginContext(@Param('schoolId') schoolId: string) {
    return this.schoolsService.createLoginContext(schoolId)
  }
}
