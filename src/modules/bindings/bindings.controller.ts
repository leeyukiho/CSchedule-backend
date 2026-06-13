import { Controller, Delete, Get, Param, Query } from '@nestjs/common'

import { BindingsService } from './bindings.service'

@Controller('bindings')
export class BindingsController {
  constructor(private readonly bindingsService: BindingsService) {}

  @Get()
  listBindings(@Query('userId') userId?: string) {
    return this.bindingsService.listBindings(userId)
  }

  @Get(':bindingId')
  getBinding(@Param('bindingId') bindingId: string) {
    return this.bindingsService.getBinding(bindingId)
  }

  @Delete(':bindingId')
  unbind(@Param('bindingId') bindingId: string) {
    return this.bindingsService.unbind(bindingId)
  }
}

