import { DailyWorkerService } from './modules/daily-reports/daily-worker.service';
import 'reflect-metadata';
import { BillRolloverService } from './modules/bills/bill-rollover.service';
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
  try {
    await app.init();
    await app.get(BillRolloverService).start();
    await app.listen(config.port, config.host);
    app.get(DailyWorkerService).start();
  } catch (error) {
    await app.close();
    throw error;
  }
}
bootstrap().catch(() => {
  console.error(
    'API startup failed. Check environment configuration and port availability.',
  );
  process.exitCode = 1;
});
