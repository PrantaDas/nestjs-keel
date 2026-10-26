import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be a whole number' })
  @Min(1, { message: 'page must be 1 or greater' })
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number' })
  @Min(1, { message: 'limit must be 1 or greater' })
  @Max(MAX_PAGE_SIZE, { message: `limit must not exceed ${MAX_PAGE_SIZE}` })
  limit: number = DEFAULT_PAGE_SIZE;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  totalDocs: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** Normalised result of both paginate plugins; the response interceptor unwraps it into `data` + `meta`. */
export class PaginatedResult<T> {
  constructor(
    readonly items: T[],
    readonly meta: PaginationMeta,
  ) {}
}

/**
 * A page whose `data` is an object rather than a bare list: the rows (`items`) plus context that
 * belongs to the page (e.g. a leaderboard's `me` and period). The interceptor sends `data` as is
 * and the paging in the standard top-level `meta`, like every other paginated route.
 */
export class PaginatedObject<T extends object> {
  constructor(
    readonly data: T,
    readonly meta: PaginationMeta,
  ) {}

  /** A service page that carries its paging as `pagination` → that page with the paging in `meta`. */
  static fromPage<P extends { pagination: PaginationMeta }>(page: P): PaginatedObject<Omit<P, 'pagination'>> {
    const { pagination, ...data } = page;
    return new PaginatedObject(data, pagination);
  }
}
