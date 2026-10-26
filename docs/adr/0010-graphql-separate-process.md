# 0010. GraphQL as its own process

Status: accepted · Date: 2026-10-26

## Context

GraphQL queries have a very different cost profile from REST and long-lived subscription sockets.

## Decision

A `graphql` process serves `/graphql` (Apollo 5, code first) and `graphql-ws` subscriptions fed by Redis pub/sub, reusing the same services, DTOs, guards and error registry as REST. The schema is generated and committed (`schema.gql`) and checked by a test. Depth and complexity limits, per-request DataLoaders, introspection off in production.

## Consequences

- Good: Expensive queries cannot slow the REST API; each scales on its own.
- Cost: One more process to deploy (skip it if no client uses GraphQL).
