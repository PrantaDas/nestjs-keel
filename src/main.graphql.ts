import './common/time/force-utc';
import './config/load-env';
import './infra/telemetry/instrument';
import './infra/sentry/instrument';
import { bootFailed, registerProcessHandlers, startGraphql } from './bootstrap/bootstrap';

registerProcessHandlers();
startGraphql().catch(bootFailed);
