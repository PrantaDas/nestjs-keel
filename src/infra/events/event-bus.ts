import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { DomainEvent } from '@/common/events/domain-event';
import { DOMAIN_EVENT_HANDLER, DomainEventHandler } from './on-domain-event.decorator';

/** Publishes events outside the process (RabbitMQ). Provided by the transport module; absent = local only. */
export abstract class ExternalEventPublisher {
  abstract publish(event: DomainEvent): Promise<void>;
}

/**
 * Delivers a domain event to every `@OnDomainEvent` handler of this process (found once at start)
 * and, when configured, to the external broker. Called by the outbox relay; feature code never
 * calls it directly (it writes to the outbox instead), so delivery survives a crash.
 */
@Injectable()
export class EventBus implements OnModuleInit {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, Array<{ name: string; handle: DomainEventHandler }>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = instance[method] as DomainEventHandler;
        const type = this.reflector.get<string | undefined>(DOMAIN_EVENT_HANDLER, handler);
        if (!type) continue;
        const list = this.handlers.get(type) ?? [];
        list.push({ name: `${instance.constructor.name}.${method}`, handle: handler.bind(instance) });
        this.handlers.set(type, list);
      }
    }
  }

  /** Types this process handles (the relay logs them at start). */
  handledTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Runs every local handler of the event; throws the first failure after all ran, so the relay
   * retries the event (handlers that already succeeded see it again: they must be idempotent).
   */
  async dispatch(event: DomainEvent, external?: ExternalEventPublisher): Promise<void> {
    const failures: unknown[] = [];
    for (const { name, handle } of this.handlers.get(event.type) ?? []) {
      try {
        await handle(event);
      } catch (err) {
        this.logger.warn({ err, eventId: event.eventId, type: event.type, handler: name }, 'Event handler failed');
        failures.push(err);
      }
    }
    if (external) await external.publish(event);
    if (failures.length) throw failures[0];
  }
}
