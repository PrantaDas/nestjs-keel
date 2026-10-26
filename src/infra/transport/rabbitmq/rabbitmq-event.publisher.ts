import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@/common/events/domain-event';
import { ExternalEventPublisher } from '@/infra/events/event-bus';
import { RabbitMqTransport } from './rabbitmq.transport';

/**
 * Outbox → RabbitMQ (`EVENTS_EXTERNAL=rabbitmq`): the relay hands every delivered event here too.
 * Routing key = event type (`user.deactivated`), message id = event id (consumers dedupe on it).
 * The relay marks an event published only after the broker confirmed it.
 */
@Injectable()
export class RabbitMqEventPublisher extends ExternalEventPublisher {
  constructor(private readonly transport: RabbitMqTransport) {
    super();
  }

  publish(event: DomainEvent): Promise<void> {
    return this.transport.publish(event.type, event, {
      messageId: event.eventId,
      headers: { 'x-event-type': event.type },
    });
  }
}
