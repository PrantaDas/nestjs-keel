# Architecture decision records

Each record says what was decided, why, and what it costs. Add one when a decision is hard to reverse or differs from what a reader would expect; never edit an accepted one, supersede it.

| #                                                  | Decision                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [0001](0001-modular-monolith-and-process-model.md) | Modular monolith, one image, several processes                    |
| [0002](0002-mongodb.md)                            | MongoDB with Mongoose, as a replica set everywhere                |
| [0003](0003-response-envelope.md)                  | One envelope for every answer                                     |
| [0004](0004-soft-delete-and-audit-opt-in.md)       | Soft delete and audit trail are opt-in                            |
| [0005](0005-users-and-staff-in-one-collection.md)  | People and staff in one collection; one identity module           |
| [0006](0006-time-rules.md)                         | Time rules enforced by the build                                  |
| [0007](0007-redis-sessions.md)                     | Sessions in Redis with refresh-token rotation and reuse detection |
| [0008](0008-feature-switches.md)                   | Optional integrations are switched by configuration               |
| [0009](0009-transactional-outbox.md)               | Transactional outbox for domain events                            |
| [0010](0010-graphql-separate-process.md)           | GraphQL as its own process                                        |
| [0011](0011-one-transport-abstraction.md)          | One transport abstraction for gRPC and RabbitMQ                   |
| [0012](0012-scrypt-password-hashing.md)            | scrypt for passwords                                              |
| [0013](0013-otp-delivery-through-a-queue.md)       | One-time codes are delivered through a queue                      |
| [0014](0014-seaweedfs-local-s3.md)                 | SeaweedFS for local S3                                            |
| [0015](0015-ci-with-docker-compose.md)             | CI uses docker compose instead of service containers              |
| [0016](0016-web-push-with-vapid.md)                | Browser push with Web Push and VAPID                              |

Template: copy the newest record, keep the headings (Context, Decision, Consequences).
