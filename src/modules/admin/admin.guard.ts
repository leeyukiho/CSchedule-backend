import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingRequest>()
    const token = this.extractToken(request)
    const expected = this.configService.get<string>('ADMIN_API_KEY')

    if (!expected) {
      throw new UnauthorizedException('ADMIN_API_KEY not configured')
    }

    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid admin credentials')
    }

    return true
  }

  private extractToken(request: IncomingRequest): string | undefined {
    const header = request.headers['x-admin-api-key']
    if (typeof header === 'string' && header.length > 0) {
      return header
    }
    const auth = request.headers['authorization']
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7)
    }
    return undefined
  }
}
