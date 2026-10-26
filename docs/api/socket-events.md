# Socket.IO events

The `socket` process (`SOCKET_PORT`, path `SOCKET_PATH`, default `/socket.io`) serves every gateway
on the default namespace. Broadcasts reach sockets on any socket instance through the Redis adapter;
any process (api, worker, cron) emits through `RealtimeEmitter` (Redis emitter), never by holding a
server.

## Connecting

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3001', {
  transports: ['websocket'],
  auth: { token: accessToken, timeZone: 'Asia/Dubai' }, // or Authorization / X-Timezone headers
});
socket.on('connect_error', (err) => console.log(err.data)); // the standard error envelope
```

The server accepts **WebSocket only** (no HTTP long-polling), so clients must pass
`transports: ['websocket']`, and any number of socket instances run without sticky sessions.

The handshake runs the same checks as REST: a valid access token **and** a live session (a revoked
session or disabled account cannot open a socket with a still-unexpired token). Each socket joins
`user:<userId>` and `session:<sessionId>`; signing out, a password change or an admin revocation
disconnects the session's sockets at once.

## Acks

Every client → server event takes an ack callback and answers with the envelope:

```js
socket.emit('notes:create', { title: 'Hi' }, (res) => {
  // { success: true, data: { ... } }  or  { success: false, errorCode, error, errorMessage, details? }
});
```

Payloads are validated with the same DTOs and messages as REST. Without an ack, a failure is emitted
as `exception` with the error envelope.

## Limits

`SOCKET_EVENTS_PER_WINDOW` events per `SOCKET_EVENT_WINDOW_MS` per socket (default 30 / 10 s). Extra
events are dropped; the client receives one `exception` (`RATE_LIMITED`, 2xxx) per window. Messages
above `SOCKET_MAX_BUFFER_BYTES` close the connection.

## Events

| Event           | Direction                          | Payload                                                                          | Answer / notes                                                                             |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `notes:list`    | client → server                    | `NoteQueryDto` (`page`, `limit`, `tag`)                                          | ack `{ success, data: NoteView[], meta }`                                                  |
| `notes:create`  | client → server                    | `CreateNoteDto`                                                                  | ack `{ success, data: NoteView }`                                                          |
| `notes:changed` | server → client (room `user:<id>`) | `{ action: 'created' \| 'updated' \| 'deleted' \| 'restored', noteId, version }` | Sent after every committed change from any process; refetch the note if `version` is newer |
| `exception`     | server → client                    | error envelope                                                                   | A failed event without ack, or the rate limit                                              |

New gateways extend `BaseGateway`, name events `<resource>:<verb>` and add a row here.
