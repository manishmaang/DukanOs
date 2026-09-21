import { InputBoundary, invalidInput } from './input-boundary';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';
export function configureApp(app: INestApplication): void {
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
