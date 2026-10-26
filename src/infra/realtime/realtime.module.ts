import { Global, Module } from '@nestjs/common';
import { RealtimeEmitter } from './realtime-emitter.service';
import { SocketAuthMiddleware } from './socket-auth.middleware';

@Global()
@Module({
  providers: [RealtimeEmitter, SocketAuthMiddleware],
  exports: [RealtimeEmitter, SocketAuthMiddleware],
})
export class RealtimeModule {}
