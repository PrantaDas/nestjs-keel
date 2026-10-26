/**
 * One way to call another service and to publish events, whatever carries them (ADR 0011). Ports
 * in `common/contracts` are implemented in-process by their module; when a module is extracted, a
 * client implements the same port on top of a `MessageTransport` (gRPC or RabbitMQ), chosen by
 * `TRANSPORT_ROUTES`: callers never change.
 */
export interface RpcCall<TPayload = unknown> {
  /** Logical service (`examples`), the key of TRANSPORT_ROUTES. */
  service: string;
  /** `<Service>.<Method>` as declared in proto/ (`NotesStatsService.CountByOwners`). */
  method: string;
  payload: TPayload;
}

export interface RequestOptions {
  /** Overall deadline, retries included (default GRPC_DEADLINE_MS). */
  timeoutMs?: number;
  /** Reads may be retried on transient failures; writes never are (default false). */
  idempotent?: boolean;
}

export interface PublishOptions {
  /** Broker message id: the domain event id, so consumers can dedupe. */
  messageId?: string;
  headers?: Record<string, string>;
}

export abstract class MessageTransport {
  abstract readonly driver: 'grpc' | 'rabbitmq';

  /** Request / response. Throws classified integration errors (transient, permanent, ambiguous). */
  abstract request<TResponse, TPayload = unknown>(
    call: RpcCall<TPayload>,
    options?: RequestOptions,
  ): Promise<TResponse>;

  /** Fire-and-forget publication of a fact (domain event) to whoever subscribed. */
  abstract publish(topic: string, message: object, options?: PublishOptions): Promise<void>;
}
