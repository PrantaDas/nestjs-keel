# Queues and scheduled jobs

Background work runs in the **worker** process (BullMQ on the core Redis); scheduled triggers in
the **cron** process. Requests never wait on providers: they enqueue (or write an outbox event) and
answer.

## One policy table

`src/infra/queue/queue-policies.ts` is the only place queue behaviour is set. Every queue has a row:

| Field                       | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `purpose`, `owner`          | What it does and which module owns producers and the processor         |
| `attempts`, `backoffMs`     | Retries: exponential (`backoffMs · 2^(n−1)`) with 50 % jitter          |
| `concurrency`               | Jobs at once per worker process                                        |
| `limiter`                   | Queue-wide rate across all workers, for provider quotas                |
| `lockMs`, `maxStalledCount` | Stalled-job handling (default 60 s lock, moved back once, then failed) |
| `idempotency`               | **Required prose**: why re-running a job cannot repeat a side effect   |

Completed jobs are kept a day (the dedupe window of deterministic job ids, at most 1000), failed
jobs a week (at most 5000) for review and retry in ops (`/api/v1/admin/ops/queues`). Processors declare
`@Processor(QueueName.X)` without options: `PolicyWorker` applies the table.

| Queue              | Owner         | Attempts | Concurrency | Limiter |
| ------------------ | ------------- | -------- | ----------- | ------- |
| `otp-delivery`     | identity      | 3 (2 s)  | 10          | 20/s    |
| `account-deletion` | identity      | 5 (30 s) | 2           |         |
| `notifications`    | notifications | 3 (5 s)  | 5           | 10/s    |
| `notes`            | examples      | 3 (5 s)  | 5           |         |
| `stripe-events`    | payments      | 8 (10 s) | 2           |         |

## Writing a processor

```ts
@Processor(QueueName.NOTES)
export class NotesProcessor extends BaseProcessor<ReminderJob> {
  protected async handle(job: Job<ReminderJob>) {
    return this.notes.sendReminder(job.data.noteId, new Date(job.data.remindAt));
  }
}
```

- **Every job is idempotent.** Retries, stalled jobs and duplicate enqueues happen. Use a
  deterministic `jobId` (no `:`; BullMQ 6 refuses it) to dedupe enqueues, a conditional update to
  claim the work (`reminderSentAt: null → now`), and `sendOnce()` (`integrations/resilience`) around
  non-idempotent provider calls: an ambiguous outcome is never repeated automatically.
- **Payloads carry ids, not documents**, and never secrets or personal data beyond what is needed.
- `BaseProcessor` logs start/finish with the job id, fails at once when retrying cannot help
  (`retryable: false`, `INTEGRATION_NOT_CONFIGURED`), and reports to Sentry once, when the job failed
  for good.
- New queue: add the name to `queue.constants.ts`, a row to the policy table (the unit test fails
  without one), register it in the module (`BullModule.registerQueue`) and export the registration
  when cron or another process module enqueues.

## Scheduled jobs

```ts
@LockedCron('0 3 * * *', { name: 'notes-purge-deleted', timeZone: 'business' })
async purgeDeleted() { await this.notes.purgeDeleted(); }
```

- `timeZone` is required: `'business'`, `'UTC'` or an IANA name (see [time.md](time.md)).
- A Redis lock (renewed while the run lasts) means **one run per tick across all cron replicas**;
  if Redis is down the tick is skipped and logged, never run unlocked.
- Crons stay short: find the work, enqueue jobs, return. Heavy lifting belongs to the worker.
- Each run logs start, finish (with duration) or skip, and reports failures to Sentry. On shutdown,
  runs in progress get until the deadline to finish; no new run starts.
- Every cron process sends a heartbeat: `GET /api/v1/admin/ops/processes` shows which are alive.

## Domain events and the outbox

A change other modules care about is written as an outbox event **in the same transaction** as the
change (`OutboxService.add(event, session)`); the worker's relay delivers it to `@OnDomainEvent`
handlers (and to RabbitMQ when `EVENTS_EXTERNAL=rabbitmq`) at least once, retrying up to 10 times.
Handlers are idempotent (the event id is stable). Failed events are listed and retried in ops (`/api/v1/admin/ops/outbox`).
ADR: [0009](../adr/0009-transactional-outbox.md).
