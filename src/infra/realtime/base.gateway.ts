import { Logger, UseFilters, UsePipes } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { createValidationPipe } from '@/common/pipes/validation.pipe';
import { Rooms } from './realtime.constants';
import type { SocketData } from './socket-auth.middleware';
import { WsExceptionsFilter } from './ws-exceptions.filter';

/**
 * Base for every gateway: DTO validation, error envelope, and automatic join of the user's
 * private room (`user:<id>`, so RealtimeEmitter.toUser / disconnectUser reach every device) and of
 * the session's room (`session:<id>`, so revoking a session closes its sockets).
 */
@UsePipes(createValidationPipe())
@UseFilters(new WsExceptionsFilter())
export abstract class BaseGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  protected readonly server: Server;

  protected readonly logger = new Logger(this.constructor.name);

  async handleConnection(client: Socket): Promise<void> {
    const { user } = client.data as SocketData;
    await client.join(user.sessionId ? [Rooms.user(user.id), Rooms.session(user.sessionId)] : Rooms.user(user.id));
    this.logger.debug({ socketId: client.id, userId: user.id }, 'Socket connected');
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug({ socketId: client.id, userId: (client.data as SocketData)?.user?.id }, 'Socket disconnected');
  }
}
