import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { systemClock } from '@/common/time/clock';
import { transportConfig } from '@/config/configuration';
import { isRetryable } from '@/infra/queue/base.processor';
import { retryWithBackoff } from '@/integrations/resilience/backoff';
import { classifyFailure, IntegrationCallException } from '@/integrations/resilience/failure';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { MessageTransport, PublishOptions, RequestOptions, RpcCall } from '../message-transport';

export const PROTO_ROOT = join(process.cwd(), 'proto');

/** Every `.proto` under proto/, relative to it (loaded with `includeDirs: [PROTO_ROOT]`). */
export function protoFiles(root = PROTO_ROOT): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.proto'))
    .map((file) => relative(root, join(root, file)));
}

/** proto-loader options shared by the client and the Nest gRPC server, so both see the same messages. */
export const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
};

type UnaryMethod = (
  request: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => grpc.ClientUnaryCall;

/**
 * gRPC client side of `MessageTransport`: one channel per service address (GRPC_<SERVICE>_URL),
 * stubs built at runtime from proto/ (no generated client code needed). Every call has a deadline
 * (the whole budget, retries included), goes through the service's circuit breaker, and idempotent
 * calls are retried on UNAVAILABLE / DEADLINE_EXCEEDED with jittered backoff.
 */
@Injectable()
export class GrpcTransport extends MessageTransport implements OnApplicationShutdown {
  readonly driver = 'grpc' as const;
  private readonly logger = new Logger(GrpcTransport.name);
  private definition?: grpc.GrpcObject;
  private readonly clients = new Map<string, grpc.Client>();

  constructor(@Inject(transportConfig.KEY) private readonly config: ConfigType<typeof transportConfig>) {
    super();
  }

  async request<TResponse, TPayload = unknown>(
    call: RpcCall<TPayload>,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const timeoutMs = options.timeoutMs ?? this.config.grpc.deadlineMs;
    // gRPC deadlines are wall-clock instants on the wire; the system clock, not a test clock.
    const deadline = systemClock.now().getTime() + timeoutMs;
    const integration = `gRPC ${call.service}`;
    const attempt = () =>
      guardedCall(integration, () => this.unary<TResponse>(call, deadline), { deadlineMs: timeoutMs + 500 });
    if (!options.idempotent) return attempt();
    return retryWithBackoff(attempt, {
      retries: 2,
      baseMs: 100,
      maxMs: 1000,
      jitter: 0.5,
      // Never past the deadline: the remaining budget must allow another try.
      shouldRetry: (error) =>
        isRetryable(error) && classifyFailure(error).transient && systemClock.now().getTime() + 100 < deadline,
    });
  }

  publish(_topic: string, _message: object, _options?: PublishOptions): Promise<void> {
    // gRPC is request / response: events go through RabbitMQ (EVENTS_EXTERNAL=rabbitmq).
    return Promise.reject(new Error('[transport] gRPC does not publish events; use the RabbitMQ transport'));
  }

  onApplicationShutdown(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private unary<TResponse>(call: RpcCall, deadline: number): Promise<TResponse> {
    const [serviceName, methodName] = call.method.split('.');
    const client = this.client(call.service, serviceName);
    const method = (client as unknown as Record<string, UnaryMethod | undefined>)[lowerFirst(methodName)];
    if (typeof method !== 'function') {
      return Promise.reject(
        new IntegrationCallException(`gRPC ${call.service}`, {
          transient: false,
          ambiguous: false,
          reason: 'unknown_method',
        }),
      );
    }
    return new Promise<TResponse>((resolve, reject) => {
      method.call(client, call.payload, new grpc.Metadata(), { deadline }, (error, response) => {
        if (error) reject(error);
        else resolve(response as TResponse);
      });
    });
  }

  private client(service: string, serviceName: string): grpc.Client {
    const key = `${service}/${serviceName}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    const Service = this.lookup(serviceName);
    const address = this.address(service);
    const client = new Service(address, grpc.credentials.createInsecure(), {
      // Detect a dead peer between calls instead of on the next one.
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 5_000,
    });
    this.clients.set(key, client);
    this.logger.log({ service, address }, 'gRPC client created');
    return client;
  }

  /** `NotesStatsService` → its constructor, found in any loaded package. */
  private lookup(serviceName: string): grpc.ServiceClientConstructor {
    this.definition ??= grpc.loadPackageDefinition(protoLoader.loadSync(protoFiles(), PROTO_LOADER_OPTIONS));
    const found = findService(this.definition, serviceName);
    if (!found) throw new Error(`[transport] gRPC service ${serviceName} is not declared in proto/`);
    return found;
  }

  private address(service: string): string {
    if (service === 'examples') return this.config.grpc.examplesUrl;
    throw new Error(`[transport] no gRPC address configured for "${service}" (add GRPC_${service.toUpperCase()}_URL)`);
  }
}

function findService(node: grpc.GrpcObject, name: string): grpc.ServiceClientConstructor | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'function' && key === name && 'service' in value) {
      return value;
    }
    if (value && typeof value === 'object' && !('format' in value)) {
      const nested = findService(value, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
