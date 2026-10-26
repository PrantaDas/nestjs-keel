# 0011. One transport abstraction for gRPC and RabbitMQ

Status: accepted · Date: 2026-10-26

## Context

The prompt asks for gRPC and RabbitMQ "behind one abstraction". Callers must not change when a module moves out of the process.

## Decision

`MessageTransport` offers `request` (with deadline and idempotency hint) and `publish`. `GrpcTransport` uses `@grpc/grpc-js` with types generated from `proto/` (ts-proto, buf); `RabbitMqTransport` uses amqp-connection-manager (publisher confirms, direct reply-to RPC, manual ack, dead-letter exchange). Ports in `common/contracts` are implemented in-process by default; `TRANSPORT_ROUTES` (`examples=grpc`) binds a network client implementing the same port. Failures are classified like provider failures (transient / ambiguous).

## Consequences

- Good: Extraction is a configuration change plus deployment; the e2e test proves both transports.
- Cost: Two transports to understand; most teams will use only one. RabbitMQ is optional (empty `RABBITMQ_URL`).
