# Fault tolerance

What happens when something breaks, and why. Every behaviour below has a test or was checked live.

## Dependencies

| Down / slow                                    | Effect                                                                                                                                                                                                                                                                                                                                                   | Recovery                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **MongoDB** at boot                            | Process boots degraded: `/api/ready` 503 (`mongodb: down`), queries answer 503 `DATABASE_UNAVAILABLE` with `Retry-After`                                                                                                                                                                                                                                 | Supervisor retries the first connection with backoff; the driver reconnects afterwards |
| **MongoDB** while running                      | Each query waits at most `MONGO_SERVER_SELECTION_TIMEOUT_MS` (failover included) or `MONGO_WAIT_QUEUE_TIMEOUT_MS` (pool busy), then 503                                                                                                                                                                                                                  | Automatic; Sentry gets one report a minute, not one per request                        |
| **Core Redis**                                 | Sessions (sign-in, refresh, token checks), OTP and failed-login limits, idempotency keys and enqueues answer 503 `REDIS_UNAVAILABLE` (fail closed: no unlimited code or password guesses); the general HTTP rate limit fails **open** (an outage must not take the whole API down); cron ticks are skipped and logged, never run unlocked; readiness 503 | ioredis reconnects; commands time out after `REDIS_COMMAND_TIMEOUT_MS`                 |
| **Cache Redis**                                | Every read is a miss (slower, still correct); one log line every 30 s per operation                                                                                                                                                                                                                                                                      | Reconnects in the background; stale entries expire by TTL                              |
| **A provider** (SMTP, Twilio, FCM, S3, Stripe) | Calls time out (`*_TIMEOUT_MS`); after `INTEGRATION_BREAKER_FAILURE_THRESHOLD` transient failures the breaker opens and calls fail fast for `INTEGRATION_BREAKER_OPEN_SECONDS`; jobs retry with jittered backoff                                                                                                                                         | One probe call closes the breaker; failed jobs stay visible in ops for retry           |
| **Provider not configured**                    | That feature answers 503 `INTEGRATION_NOT_CONFIGURED` ("not set up yet"); jobs fail at once                                                                                                                                                                                                                                                              | Add the credential; nothing else is affected                                           |
| **RabbitMQ** (when used)                       | Publishing waits for confirms; RPC calls fail within their deadline as transient                                                                                                                                                                                                                                                                         | amqp-connection-manager reconnects and re-declares topology                            |
| **Remote port over gRPC**                      | Call fails within `GRPC_DEADLINE_MS`, classified transient; idempotent calls may retry                                                                                                                                                                                                                                                                   | Caller decides (cached value, 503)                                                     |

## Requests

- Every request has a timeout (`REQUEST_TIMEOUT_MS`, uploads `REQUEST_TIMEOUT_UPLOAD_MS`) → 503.
- `HTTP_KEEP_ALIVE_TIMEOUT_MS` (65 s) outlives the load balancer idle timeout (ALB 60 s), so the
  balancer never reuses a socket the app already closed (random 502s).
- Bodies above `BODY_LIMIT` → 413; malformed JSON → 400 with a human message.
- Retries by clients are safe on unsafe routes when they send `Idempotency-Key`.

## Background work

- **Jobs** are idempotent (policy table, `idempotency` column), retried with exponential backoff and
  jitter, and kept a week when failed. A worker that dies mid-job: the lock expires (60 s) and the job
  runs once more, then fails visibly.
- **Non-idempotent sends** (SMS, e-mail, push) are claimed in Redis before the call (`sendOnce`): a
  retry never sends twice; an ambiguous outcome (timeout after sending) is marked `unknown` and
  never repeated automatically.
- **Outbox**: events are written in the same transaction as the change, so an event is never lost
  or sent for a rolled-back change; the relay retries up to 10 times, then marks it failed (ops).
- **Crons**: one run per tick across replicas (Redis lock, renewed while running); a crashed run's
  lock expires within 30 s.

## Shutdown (SIGTERM)

All within one deadline, `SHUTDOWN_TIMEOUT_MS` (25 s), below the platform's kill timeout (30 s):

1. Readiness turns 503; answers carry `Connection: close`.
2. Optional `SHUTDOWN_DRAIN_DELAY_MS` (for balancers that poll readiness slowly), then the listener
   closes; in-flight requests finish (those still running near the deadline get 503).
3. Workers stop taking jobs and finish the running ones; cron runs finish and release their locks;
   sockets close so clients reconnect to another instance.
4. Queues, MongoDB and Redis close; Sentry and OpenTelemetry flush; exit 0.

A second signal exits at once. Past the deadline the process exits 1 anyway (a cut job is retried).

## Crashes

An unhandled rejection or uncaught exception is logged as fatal, sent to Sentry, and the process
shuts down gracefully and exits 1: its state can no longer be trusted, and the orchestrator restarts
it. Nothing is swallowed.

## Time

Server clocks drift: token checks accept `JWT_CLOCK_TOLERANCE_SECONDS`; every response carries
`x-server-time` so apps base countdowns on the server. Time zone and DST rules: [time.md](../conventions/time.md).
