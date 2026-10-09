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
import { ReleaseReadiness } from './health/release-readiness';
import { diagnostic } from './diagnostics';
async function bootstrap() {
  const config = readConfig();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const webRoot = resolve(__dirname, '../../web/dist');
  if (existsSync(webRoot)) app.use(express.static(webRoot));
  try {
    await app.init();
    await app.get(ReleaseReadiness).check(true);
    await app.get(BillRolloverService).start();
    await app.listen(config.port, config.host);
    const server = app.getHttpServer();
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.setTimeout(60000);
    app.get(DailyWorkerService).start();
    diagnostic('application_started');
    // Bound Nest's worker/draining shutdown even after a broken connection.
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.once(signal, () => {
        diagnostic('application_stopping');
        setTimeout(() => {
          diagnostic('shutdown_deadline');
          process.exit(1);
        }, 90000).unref();
      });
  } catch (error) {
    await app.close();
    throw error;
  }
}
bootstrap().catch(() => {
  diagnostic('startup_failed');
  process.exitCode = 1;
});
