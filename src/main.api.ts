import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { bootFailed, registerProcessHandlers, startApi } from './bootstrap/bootstrap';

registerProcessHandlers();
startApi().catch(bootFailed);
