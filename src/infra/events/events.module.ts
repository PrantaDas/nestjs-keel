import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { EventBus } from './event-bus';
import { OutboxRelay } from './outbox-relay';
import { OutboxEvent, OutboxEventSchema } from './outbox.schema';
import { OutboxService } from './outbox.service';

const outboxModel = MongooseModule.forFeature([{ name: OutboxEvent.name, schema: OutboxEventSchema }]);

/** Every process can write events (`OutboxService`); part of CoreModule. */
@Global()
@Module({
  imports: [outboxModel],
  providers: [OutboxService],
  exports: [OutboxService, outboxModel],
})
export class EventsModule {}

/** Delivery side: only the worker process imports it, so exactly one kind of process relays. */
@Module({
  imports: [DiscoveryModule, outboxModel],
  providers: [EventBus, OutboxRelay],
  exports: [EventBus, OutboxRelay],
})
export class OutboxRelayModule {}
