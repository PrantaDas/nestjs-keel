# 0005. People and staff in one collection; one identity module

Status: accepted · Date: 2026-10-26

## Context

The prompt lists auth, users and admin as separate concerns. Separate collections for admins duplicate sign-in, sessions and OTP, and make "promote a user to staff" a data migration.

## Decision

One `users` collection; `role` (`user`, `admin`, `super_admin`) separates people and staff, and permissions map to roles in one table. Auth, users, sessions and OTP live in one `identity` module (they share the collection and its rules); admin routes are separate controllers with permission checks. Super admins are created only from the CLI.

## Consequences

- Good: One sign-in path, one session store, one reachability rule.
- Cost: Admin-only fields live on every user document (kept small and optional).
