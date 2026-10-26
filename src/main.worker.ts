import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { WorkerModule } from './app/worker.module';
import { bootFailed, registerProcessHandlers, startContext } from './bootstrap/bootstrap';

registerProcessHandlers();
startContext(WorkerModule, 'Worker').catch(bootFailed);
