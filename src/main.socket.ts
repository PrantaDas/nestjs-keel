import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { bootFailed, registerProcessHandlers, startSocket } from './bootstrap/bootstrap';

registerProcessHandlers();
startSocket().catch(bootFailed);
