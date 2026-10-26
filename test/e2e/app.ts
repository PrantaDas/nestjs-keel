import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { ApiModule } from '@/app/api.module';
import { configureHttpApp } from '@/bootstrap/http-app';
import { Clock } from '@/common/time/clock';
import { MailSender } from '@/integrations/mail/mail.port';
import { PushSender } from '@/integrations/push/push.port';
import { SmsSender } from '@/integrations/sms/sms.port';
import { FileStorage } from '@/integrations/storage/storage.port';
import { PaymentGateway } from '@/integrations/stripe/payment-gateway.port';
import { createFakes, Fakes } from './fakes';
import { resetState } from './helpers';

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  fakes: Fakes;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Root module (default: the api process). */
  module?: Type<unknown> | DynamicModule;
  /** Extra modules (e.g. a process's job module, to run processors in the same app). */
  imports?: ModuleMetadata['imports'];
  /** Replace the clock (FixedClock) to test expiry and day boundaries. */
  clock?: Clock;
  /** Further overrides. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * Boots a real process module against the docker compose MongoDB and Redis (an isolated database and
 * key prefix per run and per Jest worker, see setup-env.ts), with every provider replaced by a fake.
 * State is wiped before the suite and after it.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const fakes = createFakes();
  let builder = Test.createTestingModule({ imports: [options.module ?? ApiModule, ...(options.imports ?? [])] })
    .overrideProvider(MailSender)
    .useValue(fakes.mail)
    .overrideProvider(SmsSender)
    .useValue(fakes.sms)
    .overrideProvider(PushSender)
    .useValue(fakes.push)
    .overrideProvider(FileStorage)
    .useValue(fakes.storage)
    .overrideProvider(PaymentGateway)
    .useValue(fakes.payments);
  if (options.clock) builder = builder.overrideProvider(Clock).useValue(options.clock);
  if (options.configure) builder = options.configure(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  configureHttpApp(app);
  await app.init();
  await resetState(app);
  await app.get<Connection>(getConnectionToken()).syncIndexes();
  return {
    app,
    http: request(app.getHttpServer()),
    fakes,
    close: async () => {
      await resetState(app);
      await app.close();
    },
  };
}
