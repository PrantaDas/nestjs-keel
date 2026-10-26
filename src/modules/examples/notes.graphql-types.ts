/*
 * ─── GRAPHQL TYPES ───────────────────────────────────────────────────────────
 * Output types for the resolver (code first: the SDL in schema.gql is generated from these). Input
 * types are the REST DTOs themselves (`CreateNoteInput`, `UpdateNoteInput`), so validation is shared.
 */
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

@ObjectType('NoteReminder')
export class NoteReminderType {
  @Field(() => Date, { description: 'When it fires (UTC)' })
  remindAt: Date;

  @Field(() => String)
  date: string;

  @Field(() => String)
  time: string;

  @Field(() => String)
  timeZone: string;

  @Field(() => Boolean)
  sent: boolean;
}

@ObjectType('NoteOwner', { description: 'Public profile of the note owner (batched with a DataLoader)' })
export class NoteOwnerType {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  avatarUrl: string | null;
}

@ObjectType('Note')
export class NoteType {
  @Field(() => ID)
  _id: string;

  @Field(() => String)
  title: string;

  @Field(() => String)
  body: string;

  @Field(() => [String])
  tags: string[];

  @Field(() => Boolean)
  pinned: boolean;

  @Field(() => NoteReminderType, { nullable: true })
  reminder: NoteReminderType | null;

  @Field(() => String, { description: 'Business day the note was created on (YYYY-MM-DD)' })
  createdDay: string;

  @Field(() => Int)
  version: number;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;

  /** Not stored on the view: resolved by `NotesResolver.owner` through a per-request DataLoader. */
  ownerId: string;
}

@ObjectType('PageInfo')
export class PageInfoType {
  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalDocs: number;

  @Field(() => Int)
  totalPages: number;

  @Field(() => Boolean)
  hasNextPage: boolean;

  @Field(() => Boolean)
  hasPrevPage: boolean;
}

@ObjectType('NotePage')
export class NotePageType {
  // A page holds at most 100 notes: the complexity estimate multiplies by it.
  @Field(() => [NoteType], { complexity: 100 })
  items: NoteType[];

  @Field(() => PageInfoType)
  meta: PageInfoType;
}

export enum NoteChangeAction {
  CREATED = 'created',
  UPDATED = 'updated',
  DELETED = 'deleted',
  RESTORED = 'restored',
}
registerEnumType(NoteChangeAction, { name: 'NoteChangeAction' });

@ObjectType('NoteChange', { description: 'Pushed to the owner when one of their notes changes' })
export class NoteChangeType {
  @Field(() => NoteChangeAction)
  action: NoteChangeAction;

  @Field(() => ID)
  noteId: string;

  @Field(() => Int)
  version: number;

  /** Used by the subscription filter; not exposed. */
  ownerId: string;
}
