# 0009. Transactional outbox for domain events

Status: accepted · Date: 2026-10-26

## Context

Publishing an event after a commit loses it if the process dies in between; publishing before can announce a change that rolled back.

## Decision

Events are written to an `outbox` collection in the same transaction as the change. The worker's relay claims batches, delivers them to `@OnDomainEvent` handlers (and to RabbitMQ when `EVENTS_EXTERNAL=rabbitmq`), and retries with backoff up to 10 attempts; failures are visible and retryable in ops. Handlers are idempotent on the event id.

## Consequences

- Good: At-least-once delivery that survives crashes; the same mechanism feeds other services after extraction.
- Cost: Delivery is asynchronous (around `OUTBOX_POLL_INTERVAL_MS`); handlers must tolerate duplicates.
