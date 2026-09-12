import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body =
      error instanceof HttpException ? error.getResponse() : undefined;
    const detail =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : undefined;
    if (status >= 500)
      this.logger.error(`Request failed with status ${status}`);
    response.status(status).json({
      code:
        typeof detail?.code === 'string'
          ? detail.code
          : status >= 500
            ? 'INTERNAL_ERROR'
            : `HTTP_${status}`,
      message:
        status >= 500
          ? status === 503
            ? 'Service is unavailable'
            : 'An unexpected error occurred'
          : typeof detail?.message === 'string'
            ? detail.message
            : 'Request could not be processed',
    });
  }
}
