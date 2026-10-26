import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Socket } from 'socket.io';
import { bodyFieldsOf, mapException } from '@/common/exceptions/exception-mapper';
import { SOCKET_ERROR_EVENT } from './realtime.constants';
import type { SocketData } from './socket-auth.middleware';

/**
 * Socket counterpart of AllExceptionsFilter. Replies through the ack callback when the client
 * sent one, otherwise emits `exception` with the same error envelope used by REST.
 */
@Catch()
export class WsExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('WsExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const { body, isServerError } = mapException(exception, undefined, { bodyFields: bodyFieldsOf(ws.getData()) });

    if (isServerError) {
      this.logger.error(
        { err: exception, socketId: client.id, userId: (client.data as Partial<SocketData> | undefined)?.user?.id },
        'Unhandled socket error',
      );
      Sentry.captureException(exception);
    }

    const ack = host.getArgByIndex<unknown>(2);
    if (typeof ack === 'function') (ack as (response: unknown) => void)(body);
    else client.emit(SOCKET_ERROR_EVENT, body);
  }
}
