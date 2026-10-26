import { Field, Int, ObjectType } from '@nestjs/graphql';

/** Paging of every GraphQL list, the same fields as REST's `meta` (one type for the whole schema). */
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
