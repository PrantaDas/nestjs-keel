# Progress log

Short, append-only notes on what was built per slice and what was decided along the way.

## 2026-10-26

- Plan written (`overview.md`). Reference implementation studied; its generic skeleton (bootstrap,
  common, infra, integrations/resilience, migrations) copied and stripped of domain concepts.
- Versions pinned to the newest stable releases published on or before 2026-10-12 (two weeks old).
- Slice 4 (database): soft-delete plugin + `SoftDeleteRepository` (opt-in), audit trail module
  (opt-in `@Audit`, automatic for staff writes), transactional outbox + relay + `@OnDomainEvent`.
- Slice 5 (identity): users and admins in one collection (ADR 0005); scrypt passwords; Redis
  sessions with refresh rotation and reuse detection; OTP (hashed, single use, constant time,
  per-code / per-recipient limits, no account discovery) delivered through a queue; sign-up,
  password and code sign-in, reset, verification, contact changes, deactivation, deletion with a
  grace period, admin list / detail / update / disable; super admin CLI.
- Integrations ported behind ports (`MailSender`, `SmsSender`, `FileStorage`, `PushSender`) with
  e2e fakes; notifications module (device registry, Notifier through a queue with claims, inbox,
  dead-token pruning, reachability checked twice) pulled forward because sign-in registers devices.
- Found while building: BullMQ 6 rejects `:` in job ids; Mongoose needs `type: String` on enum
  props under ts-jest; MinIO images are no longer pullable, so local S3 is SeaweedFS.
- Slice 6 (example module): `modules/examples` (notes) with every convention commented in place:
  schema, DTOs shared with GraphQL, errors, events, repository (optimistic concurrency, claims),
  views per API version, service, v1/v2 controllers with deprecation, resolver, gateway, processor,
  crons, event handlers, unit and e2e tests; an example migration with a real `down`.
- Slice 9 (GraphQL) pulled forward with it: separate process, code-first schema committed as
  `schema.gql` (+ staleness test), same guards / validation / error codes as REST, DataLoaders,
  depth and complexity limits, `graphql-ws` subscriptions over Redis pub/sub.
- Multi-version controllers duplicate operation ids in OpenAPI: older versions get a `V<n>` suffix.
- Found while building: core modules must export their queue registration, or a cron (producer
  in another module) cannot inject it; the cron process would not have booted.
