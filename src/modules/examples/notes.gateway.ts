/*
 * ─── GATEWAY (socket process) ────────────────────────────────────────────────
 * `BaseGateway` gives every handler DTO validation, the error envelope in acks, and joins each
 * socket to `user:<id>` and `session:<id>` rooms at connection (the handshake is authenticated with
 * the same token and live-session check as REST). Handlers return data; the client's ack receives
 * `{ success: true, data }` or the error envelope. Server → client pushes do not come from here:
 * any process calls `RealtimeEmitter.toUser(...)` (NotesService does after every change).
 * Events are documented in docs/api/socket-events.md.
 */
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { BaseGateway } from '@/infra/realtime/base.gateway';
import type { SocketData } from '@/infra/realtime/socket-auth.middleware';
import { CreateNoteDto, NoteQueryDto } from './dto/note.dto';
import { NotesService } from './notes.service';
import { toNoteView } from './notes.views';

@WebSocketGateway()
export class NotesGateway extends BaseGateway {
  constructor(private readonly notes: NotesService) {
    super();
  }

  /** `notes:list` → ack `{ success, data: NoteView[], meta }` (same paging as REST). */
  @SubscribeMessage('notes:list')
  async list(@ConnectedSocket() socket: Socket, @MessageBody() query: NoteQueryDto) {
    const page = await this.notes.list(ownerOf(socket), query);
    return { success: true, data: page.items.map(toNoteView), meta: page.meta };
  }

  /** `notes:create` → ack `{ success, data: NoteView }`; other devices get `notes:changed`. */
  @SubscribeMessage('notes:create')
  async create(@ConnectedSocket() socket: Socket, @MessageBody() dto: CreateNoteDto) {
    return { success: true, data: toNoteView(await this.notes.create(ownerOf(socket), dto)) };
  }
}

const ownerOf = (socket: Socket): string => (socket.data as SocketData).user.id;
