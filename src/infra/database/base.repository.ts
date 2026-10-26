import type {
  AggregatePaginateModel,
  AnyBulkWriteOperation,
  ClientSession,
  Model,
  PaginateModel,
  PipelineStage,
  PopulateOptions,
  ProjectionType,
  QueryFilter,
  SortOrder,
  Types,
  UpdateQuery,
} from 'mongoose';
import { DEFAULT_PAGE_SIZE, PaginatedResult, PaginationMeta } from '@/common/dto/pagination.dto';

/** Plain object returned by lean reads. */
export type LeanDoc<T> = T & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };

export type SortSpec = Record<string, SortOrder>;
export type Populate = string | PopulateOptions | (string | PopulateOptions)[];

export interface FindOptions<T> {
  projection?: ProjectionType<T>;
  sort?: SortSpec;
  limit?: number;
  skip?: number;
  populate?: Populate;
  session?: ClientSession;
}

export interface PageOptions<T> {
  page?: number;
  limit?: number;
  sort?: SortSpec;
  projection?: ProjectionType<T>;
  populate?: Populate;
}

interface PluginPage<R> {
  docs: R[];
  totalDocs: number;
  limit: number;
  page?: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/**
 * Shared data-access layer. Feature repositories extend it and add query methods named
 * after intent (`findActiveByOwner`, ...) instead of leaking raw queries into services.
 * Reads are lean by default (plain objects, much cheaper than hydrated documents).
 */
export abstract class BaseRepository<T> {
  protected constructor(protected readonly model: Model<T>) {}

  async create(data: Partial<T>, session?: ClientSession): Promise<LeanDoc<T>> {
    const doc = await new this.model(data).save({ session });
    return doc.toObject() as LeanDoc<T>;
  }

  async insertMany(data: Partial<T>[], session?: ClientSession): Promise<number> {
    const docs = await this.model.insertMany(data, { session, ordered: false, lean: true });
    return docs.length;
  }

  findById(id: string | Types.ObjectId, options: FindOptions<T> = {}): Promise<LeanDoc<T> | null> {
    const query = this.model.findById(id, options.projection, { session: options.session });
    if (options.populate) query.populate(options.populate as PopulateOptions);
    return query.lean<LeanDoc<T>>().exec();
  }

  findOne(filter: QueryFilter<T>, options: FindOptions<T> = {}): Promise<LeanDoc<T> | null> {
    const query = this.model.findOne(filter, options.projection, { session: options.session });
    if (options.sort) query.sort(options.sort);
    if (options.populate) query.populate(options.populate as PopulateOptions);
    return query.lean<LeanDoc<T>>().exec();
  }

  find(filter: QueryFilter<T>, options: FindOptions<T> = {}): Promise<LeanDoc<T>[]> {
    const query = this.model.find(filter, options.projection, { session: options.session });
    if (options.sort) query.sort(options.sort);
    if (options.skip) query.skip(options.skip);
    if (options.limit) query.limit(options.limit);
    if (options.populate) query.populate(options.populate as PopulateOptions);
    return query.lean<LeanDoc<T>[]>().exec();
  }

  async exists(filter: QueryFilter<T>): Promise<boolean> {
    return (await this.model.exists(filter)) !== null;
  }

  count(filter: QueryFilter<T> = {}): Promise<number> {
    return this.model.countDocuments(filter).exec();
  }

  updateById(id: string | Types.ObjectId, update: UpdateQuery<T>, session?: ClientSession): Promise<LeanDoc<T> | null> {
    return this.model
      .findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true, session })
      .lean<LeanDoc<T>>()
      .exec();
  }

  updateOne(filter: QueryFilter<T>, update: UpdateQuery<T>, session?: ClientSession): Promise<LeanDoc<T> | null> {
    return this.model
      .findOneAndUpdate(filter, update, { returnDocument: 'after', runValidators: true, session })
      .lean<LeanDoc<T>>()
      .exec();
  }

  async updateMany(filter: QueryFilter<T>, update: UpdateQuery<T>, session?: ClientSession): Promise<number> {
    const result = await this.model.updateMany(filter, update, { runValidators: true, session }).exec();
    return result.modifiedCount;
  }

  deleteById(id: string | Types.ObjectId, session?: ClientSession): Promise<LeanDoc<T> | null> {
    return this.model.findByIdAndDelete(id, { session }).lean<LeanDoc<T>>().exec();
  }

  async deleteMany(filter: QueryFilter<T>, session?: ClientSession): Promise<number> {
    const result = await this.model.deleteMany(filter, { session }).exec();
    return result.deletedCount;
  }

  async paginate(filter: QueryFilter<T>, options: PageOptions<T> = {}): Promise<PaginatedResult<LeanDoc<T>>> {
    const result = (await (this.model as unknown as PaginateModel<T>).paginate(filter, {
      page: options.page ?? 1,
      limit: options.limit ?? DEFAULT_PAGE_SIZE,
      sort: options.sort ?? { _id: -1 },
      projection: options.projection,
      populate: options.populate as PopulateOptions,
      lean: true,
      leanWithId: false,
    })) as unknown as PluginPage<LeanDoc<T>>;
    return toPaginatedResult(result);
  }

  aggregate<R>(pipeline: PipelineStage[]): Promise<R[]> {
    return this.model.aggregate<R>(pipeline).exec();
  }

  async aggregatePaginate<R>(
    pipeline: PipelineStage[],
    options: Omit<PageOptions<T>, 'projection' | 'populate'> = {},
  ): Promise<PaginatedResult<R>> {
    const model = this.model as unknown as AggregatePaginateModel<T>;
    const result = await model.aggregatePaginate<R>(this.model.aggregate<R>(pipeline), {
      page: options.page ?? 1,
      limit: options.limit ?? DEFAULT_PAGE_SIZE,
      sort: options.sort,
      // The plugin's $facet mode counts only $match stages, so totals are wrong after
      // $group/$unwind (v1.1.5). A separate count over the full pipeline is correct.
      useFacet: false,
    });
    return toPaginatedResult(result);
  }

  bulkWrite(operations: AnyBulkWriteOperation[], session?: ClientSession) {
    return this.model.bulkWrite(operations as never, { session, ordered: false });
  }
}

function toPaginatedResult<R>(page: PluginPage<R>): PaginatedResult<R> {
  const meta: PaginationMeta = {
    page: page.page ?? 1,
    limit: page.limit,
    totalDocs: page.totalDocs,
    totalPages: page.totalPages,
    hasNextPage: page.hasNextPage,
    hasPrevPage: page.hasPrevPage,
  };
  return new PaginatedResult(page.docs, meta);
}
