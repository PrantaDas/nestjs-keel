import { type GrpcOptions, Transport } from '@nestjs/microservices';
import { PROTO_LOADER_OPTIONS, PROTO_ROOT, protoFiles } from './grpc.transport';

/** Packages declared in proto/ (`examples.v1`), read from the files so a new proto needs no code change. */
export function protoPackages(): string[] {
  return protoFiles().map((file) => file.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.'));
}

/**
 * Nest gRPC server options: every proto under proto/, the same loader options as the client, and
 * limits that keep one slow or huge call from hurting the others.
 */
export function grpcServerOptions(port: number): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      url: `0.0.0.0:${port}`,
      package: [...new Set(protoPackages())],
      protoPath: protoFiles(),
      loader: { ...PROTO_LOADER_OPTIONS, includeDirs: [PROTO_ROOT] },
      maxReceiveMessageLength: 4 * 1024 * 1024,
      keepalive: { keepaliveTimeMs: 30_000, keepaliveTimeoutMs: 5_000 },
    },
  };
}
