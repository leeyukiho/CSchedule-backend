import { Body, Controller, Post } from '@nestjs/common'

import { FeedbackService, SubmitFeedbackRequest } from './feedback.service'

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  submitFeedback(@Body() input: SubmitFeedbackRequest) {
    return this.feedbackService.submitFeedback(input)
  }
}

