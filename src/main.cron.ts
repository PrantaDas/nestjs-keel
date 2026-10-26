import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { CronModule } from './app/cron.module';
import { bootFailed, registerProcessHandlers, startContext } from './bootstrap/bootstrap';

registerProcessHandlers();
startContext(CronModule, 'Cron').catch(bootFailed);
