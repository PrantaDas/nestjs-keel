import { randomUUID } from 'node:crypto';

/**
 * A fact that happened in one module and that others may react to (`user.deactivated`). Events are
 * written to the outbox in the same transaction as the state change and delivered at least once:
 * handlers must be idempotent (use `eventId` to dedupe when a repeat would matter).
 */
export interface DomainEvent<TPayload extends object = Record<string, unknown>> {
  /** Unique id; also the RabbitMQ message id. */
  eventId: string;
  /** `<module>.<past-tense verb>`, e.g. `user.deactivated`, `note.created`. */
  type: string;
  payload: TPayload;
  occurredAt: Date;
}

export interface EventDefinition<TPayload extends object> {
  readonly type: string;
  /** Builds an event of this type (the instant comes from the caller's TimeService). */
  (payload: TPayload, occurredAt: Date): DomainEvent<TPayload>;
}

/**
 * Declares an event type and its payload in one place (`<module>.events.ts`, or
 * `common/contracts` when other modules handle it).
 *
 * @example
 * export const UserDeactivated = defineEvent<{ userId: string }>('user.deactivated');
 * await outbox.add(UserDeactivated({ userId }, time.now()), session);
 */
export function defineEvent<TPayload extends object>(type: string): EventDefinition<TPayload> {
  const create = (payload: TPayload, occurredAt: Date): DomainEvent<TPayload> => ({
    eventId: randomUUID(),
    type,
    payload,
    occurredAt,
  });
  return Object.assign(create, { type });
}
