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
