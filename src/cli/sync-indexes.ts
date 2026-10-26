import '@/common/time/force-utc';
import '@/infra/sentry/instrument';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { parseArgs } from 'node:util';
import { ApiModule } from '@/app/api.module';

/**
 * Production runs with autoIndex off, so indexes declared in schemas are applied here, as a
 * deploy step. Default is a report only.
 *
 *   pnpm db:sync-indexes            show missing / extra indexes per collection
 *   pnpm db:sync-indexes --apply    create missing indexes (never drops)
 *   pnpm db:sync-indexes --drop     also drop indexes not declared in any schema (careful)
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, drop: { type: 'boolean' } } });
  const app = await NestFactory.createApplicationContext(ApiModule, { logger: ['error', 'warn'] });
  const connection = app.get<Connection>(getConnectionToken());

  try {
    for (const model of Object.values(connection.models)) {
      const diff = await model.diffIndexes();
      const toCreate = diff.toCreate.map((spec) => JSON.stringify(spec));
      console.log(
        `${model.collection.collectionName}: create ${JSON.stringify(toCreate)} drop ${JSON.stringify(diff.toDrop)}`,
      );

      if (values.drop) await model.syncIndexes();
      else if (values.apply) await model.createIndexes();
    }
    if (!values.apply && !values.drop) console.log('\nReport only. Re-run with --apply to create missing indexes.');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
