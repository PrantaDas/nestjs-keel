/*
 * ─── GRAPHQL RESOLVER (graphql process) ──────────────────────────────────────
 * Same service, same rules as REST. The global guards (token + live session, roles) and the global
 * ValidationPipe apply to resolvers as they do to controllers; errors reach clients with the same
 * `code` / `errorCode` / message as REST (infra/graphql/graphql-errors.ts). Related data is loaded
 * through the per-request DataLoaders (`context.loaders`), never one query per row.
 */
import { Args, Context, ID, Int, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import { CurrentUser } from '@/common/auth/auth.decorators';
import { UserDirectory } from '@/common/contracts/user-directory.contract';
import type { GraphqlContext } from '@/infra/graphql/graphql.module';
import { GraphqlPubSub } from '@/infra/graphql/graphql-pubsub';
import { CreateNoteDto, NoteQueryDto, UpdateNoteDto } from './dto/note.dto';
import { NOTES_CHANGED_EVENT, NotesService } from './notes.service';
import { NoteChangeType, NoteOwnerType, NotePageType, NoteType } from './notes.graphql-types';
import type { NoteDoc } from './notes.repository';
import { toNoteView } from './notes.views';

const toNoteType = (note: NoteDoc): NoteType => ({ ...toNoteView(note), ownerId: note.ownerId.toHexString() });

@Resolver(() => NoteType)
export class NotesResolver {
  constructor(
    private readonly service: NotesService,
    private readonly directory: UserDirectory,
    private readonly pubsub: GraphqlPubSub,
  ) {}

  @Query(() => NotePageType, { description: 'My notes, pinned first' })
  async notes(
    @CurrentUser('id') ownerId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('tag', { type: () => String, nullable: true }) tag?: string,
  ): Promise<NotePageType> {
    const query = Object.assign(new NoteQueryDto(), { page, limit: Math.min(limit, 100), tag });
    const result = await this.service.list(ownerId, query);
    return { items: result.items.map(toNoteType), meta: result.meta };
  }

  @Query(() => NoteType)
  async note(@CurrentUser('id') ownerId: string, @Args('id', { type: () => ID }) id: string): Promise<NoteType> {
    return toNoteType(await this.service.get(ownerId, id));
  }

  @Mutation(() => NoteType)
  async createNote(@CurrentUser('id') ownerId: string, @Args('input') input: CreateNoteDto): Promise<NoteType> {
    return toNoteType(await this.service.create(ownerId, input));
  }

  @Mutation(() => NoteType)
  async updateNote(
    @CurrentUser('id') ownerId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateNoteDto,
  ): Promise<NoteType> {
    return toNoteType(await this.service.update(ownerId, id, input));
  }

  @Mutation(() => Boolean, { description: 'Moves the note to the bin' })
  async deleteNote(@CurrentUser('id') ownerId: string, @Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.service.remove(ownerId, id);
    return true;
  }

  /** Batched: the owners of a whole page are fetched in one query per request. */
  @ResolveField(() => NoteOwnerType, { nullable: true })
  owner(@Parent() note: NoteType, @Context() context: GraphqlContext): Promise<NoteOwnerType | null> {
    return context.loaders.get('userProfiles', (ids) => this.directory.findPublicProfiles(ids)).load(note.ownerId);
  }

  /** Changes to my notes, from any process (Redis pub/sub); each subscriber sees only their own. */
  @Subscription(() => NoteChangeType, {
    filter: (payload: { noteChanged: NoteChangeType }, _args, context: GraphqlContext) =>
      payload.noteChanged.ownerId === context.req.user?.id,
  })
  noteChanged(): AsyncIterator<NoteChangeType> {
    return this.pubsub.asyncIterator<NoteChangeType>(NOTES_CHANGED_EVENT);
  }
}
