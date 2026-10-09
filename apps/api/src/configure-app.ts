import { InputBoundary, invalidInput } from './input-boundary';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';
import { requestDiagnostics } from './diagnostics';
export function trustedLocalProxy(address: string, hop: number) {
  return hop === 0 && ['127.0.0.1', '::ffff:127.0.0.1'].includes(address);
}
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // Production is bound to IPv4 loopback. Nginx must overwrite forwarding
  // headers; no other local service/user may be untrusted on this host.
  express.set(
    'trust proxy',
    process.env.NODE_ENV === 'production' ? trustedLocalProxy : false,
  );
  app.use(requestDiagnostics);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: invalidInput,
    }),
  );
  app.useGlobalInterceptors(new InputBoundary());
  app.useGlobalFilters(new HttpErrorFilter());
}
