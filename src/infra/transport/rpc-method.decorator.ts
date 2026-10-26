import { SetMetadata } from '@nestjs/common';

export const RPC_METHOD = 'transport:rpcMethod';

export interface RpcMethodMetadata {
  service: string;
  method: string;
}

/**
 * Exposes a provider method as `<service>/<method>` to RabbitMQ RPC (the gRPC server uses the
 * generated `...ControllerMethods()` decorator). Put both on the same handler class, so the module
 * answers on either transport with the same code.
 */
export const RpcMethod = (service: string, method: string): MethodDecorator =>
  SetMetadata(RPC_METHOD, { service, method } satisfies RpcMethodMetadata);
