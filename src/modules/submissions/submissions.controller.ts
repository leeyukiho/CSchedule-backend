import { Body, Controller, Post } from '@nestjs/common'

import { CreateSchoolSubmissionRequest, SubmissionsService } from './submissions.service'

@Controller('school-access-submissions')
export class SubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  @Post()
  createSubmission(@Body() input: CreateSchoolSubmissionRequest) {
    return this.submissionsService.createSubmission(input)
  }
}

