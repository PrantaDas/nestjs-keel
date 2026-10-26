import { SetMetadata } from '@nestjs/common';
import type { DomainEvent, EventDefinition } from '@/common/events/domain-event';

export const DOMAIN_EVENT_HANDLER = 'events:handler';

/**
 * Marks a provider method as a handler of a domain event. Handlers run in the worker process (the
 * outbox relay delivers there), at least once, and must be idempotent. A handler that throws makes
 * the relay retry the whole event later with backoff; keep handlers small and enqueue heavy work.
 *
 * @example
 * @OnDomainEvent(UserDeactivated)
 * async onDeactivated(event: DomainEvent<{ userId: string }>) { ... }
 */
export const OnDomainEvent = <T extends object>(definition: EventDefinition<T> | string): MethodDecorator =>
  SetMetadata(DOMAIN_EVENT_HANDLER, typeof definition === 'string' ? definition : definition.type);

export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;
