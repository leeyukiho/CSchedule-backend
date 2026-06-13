import { Injectable } from '@nestjs/common'

@Injectable()
export class HealthService {
  check() {
    return {
      status: 'ok',
      service: 'cschedule-backend',
      database: 'postgresql',
      timestamp: new Date().toISOString(),
    }
  }
}
