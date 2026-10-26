# 0014. SeaweedFS for local S3

Status: accepted · Date: 2026-10-26

## Context

The prompt suggests MinIO for local S3. The MinIO images could not be pulled in this environment (registry access denied).

## Decision

docker compose runs SeaweedFS (`chrislusf/seaweedfs`) with its S3 gateway on port 8333, and a one-shot `s3-init` container creates the `app-local` bucket. The app talks to it with the normal AWS SDK (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=true`). Production uses AWS S3 with an empty endpoint.

## Consequences

- Good: Same code path as production; presigned uploads work locally.
- Cost: SeaweedFS's S3 API differs from AWS in edge cases (policies, some headers); test them on real S3.
