import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { bootFailed, registerProcessHandlers, startGrpc } from './bootstrap/bootstrap';

registerProcessHandlers();
startGrpc().catch(bootFailed);
