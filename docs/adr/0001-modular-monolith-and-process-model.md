# 0001. Modular monolith, one image, several processes

Status: accepted · Date: 2026-10-26

## Context

The template must serve small teams on day one and survive growth: REST, GraphQL, sockets, background jobs and schedules have very different scaling and failure profiles, but separate services from the start cost a lot (deployments, contracts, distributed debugging).

## Decision

One codebase and one Docker image. Each workload is its own process with its own root module on top of a shared `CoreModule`: `api`, `graphql`, `socket`, `worker`, `cron` (and an optional `grpc`). Feature modules are split by layer into `*CoreModule` (data, services), `*ApiModule`, `*JobsModule`, `*CronModule`, `*RealtimeModule`, `*GraphqlModule`, so each process loads only what it serves. Module boundaries are enforced by lint (see ADR 0011 and microservices.md).

## Consequences

- Good: Each workload scales and fails on its own (a stuck job never slows the API; a socket storm never starves cron).
- Good: One build, one version, one set of migrations.
- Cost: More moving parts locally (the compose `app` profile and `pnpm dev:*` help).
- Cost: Process modules must import every feature's right sub-module; `pnpm g:module` wires it.
