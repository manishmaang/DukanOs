import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { readConfig } from './config';
async function bootstrap() {
  const config = readConfig();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const webRoot = resolve(__dirname, '../../web/dist');
  if (existsSync(webRoot)) app.use(express.static(webRoot));
  await app.listen(config.port, config.host);
}
bootstrap().catch(() => {
  console.error(
    'API startup failed. Check environment configuration and port availability.',
  );
  process.exitCode = 1;
});
