import {
  BadRequestException,
  Injectable,
  SetMetadata,
  UnsupportedMediaTypeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';

/** Transport shape only; field/domain validation remains in DTOs and services. */
export const JsonInput = () => SetMetadata('input:body', 'json');
export const MultipartInput = () => SetMetadata('input:body', 'multipart');
/** Every query-bearing route must bind a class-validated @Query() DTO. */
export const QueryInput = () => SetMetadata('input:query', true);
export const invalidInput = () =>
  new BadRequestException({
    code: 'INVALID_INPUT',
    message: 'Request fields or values are invalid.',
  });
@Injectable()
export class InputBoundary implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const handler = context.getHandler();
    if (
      !Reflect.getMetadata('input:query', handler) &&
      Object.keys(request.query).length
    )
      throw invalidInput();
    const mode = Reflect.getMetadata('input:body', handler);
    if (mode === 'json') {
      if (!request.is('application/json'))
        throw new UnsupportedMediaTypeException({
          code: 'INVALID_CONTENT_TYPE',
          message: 'Use application/json for this request.',
        });
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body)
      )
        throw invalidInput();
    } else if (mode === 'multipart') {
      if (!request.is('multipart/form-data'))
        throw new UnsupportedMediaTypeException({
          code: 'INVALID_CONTENT_TYPE',
          message: 'Use multipart/form-data with one image file.',
        });
    } else if (
      (request.body !== undefined &&
        (typeof request.body !== 'object' ||
          request.body === null ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length)) ||
      Number(request.headers['content-length'] ?? 0) > 0 ||
      request.headers['transfer-encoding']
    ) {
      throw invalidInput();
    }
    return next.handle();
  }
}
