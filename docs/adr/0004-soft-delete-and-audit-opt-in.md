# 0004. Soft delete and audit trail are opt-in

Status: accepted · Date: 2026-10-26

## Context

Global soft delete makes every query pay for a filter and surprises people with "deleted" rows in unique indexes; auditing every write floods storage with end-user noise.

## Decision

Soft delete is a schema plugin plus `SoftDeleteRepository`, used only where a bin or restore exists (notes). The audit trail records staff writes automatically, staff reads when marked with `@Audit`, and the before/after a service records; end-user requests are not audited. Audit entries expire after `AUDIT_RETENTION_DAYS`.

## Consequences

- Good: No hidden filters on collections that do not need them; the audit log stays useful.
- Cost: A module that needs a bin must remember to add the plugin and a purge cron (the example shows both).
