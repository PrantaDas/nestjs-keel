import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { allConfigs } from './configuration';
import { envValidationSchema } from './env.validation';

/**
 * Validates the whole environment at boot (all problems at once) and exposes the typed namespaces.
 * `.env` is loaded by `./load-env` before anything else, so the file is not read a second time here.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: true,
      load: allConfigs,
      validationSchema: envValidationSchema,
      validationOptions: { libraryOptions: { abortEarly: false, allowUnknown: true } },
    }),
  ],
})
export class AppConfigModule {}
