import { Public } from '../modules/auth/access';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@dukanos/shared-types';
import { ReleaseReadiness } from './release-readiness';
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReleaseReadiness) {}
  @Get() live(): HealthResponse {
    return { status: 'ok', service: 'dukanos-api' };
  }
  @Get('ready') async ready(): Promise<HealthResponse> {
    try {
      await this.readiness.check();
    } catch {
      throw new ServiceUnavailableException({
        code: 'SERVICE_NOT_READY',
        message: 'Release prerequisites are unavailable',
      });
    }
    return this.live();
  }
}
