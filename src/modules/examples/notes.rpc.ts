/*
 * ─── RPC HANDLERS (grpc process, and worker for RabbitMQ) ────────────────────
 * The module's port served over the network, once the module is extracted. One class answers both
 * transports: the generated `...ControllerMethods()` decorator registers it with the Nest gRPC
 * server (types generated from proto/ by `pnpm proto:gen`), `@RpcMethod` with the RabbitMQ RPC
 * server. Both call the same service method as the in-process port.
 */
import { Controller } from '@nestjs/common';
import type {
  CountByOwnersRequest,
  CountByOwnersResponse,
  NotesStatsServiceController,
} from '@/infra/transport/grpc/generated/examples/v1/notes_stats';
import { NotesStatsServiceControllerMethods } from '@/infra/transport/grpc/generated/examples/v1/notes_stats';
import { RpcMethod } from '@/infra/transport/rpc-method.decorator';
import { NotesService } from './notes.service';

@Controller()
@NotesStatsServiceControllerMethods()
export class NotesRpcController implements NotesStatsServiceController {
  constructor(private readonly notes: NotesService) {}

  @RpcMethod('examples', 'NotesStatsService.CountByOwners')
  async countByOwners(request: CountByOwnersRequest): Promise<CountByOwnersResponse> {
    const counts = await this.notes.countByOwners(request.ownerIds ?? []);
    return { counts: Object.fromEntries(counts) };
  }
}
