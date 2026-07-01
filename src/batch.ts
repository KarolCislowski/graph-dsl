import type { ParameterValue, Primitive } from "./ast.js";

/**
 * Item value that can be placed inside a batched parameter array.
 */
export type BatchParamItem = Primitive | Record<string, Primitive>;

/**
 * Metadata describing the current batch.
 */
export type BatchMeta = {
  /**
   * Zero-based batch index.
   */
  index: number;
  /**
   * Zero-based item offset for the first item in this batch.
   */
  offset: number;
  /**
   * Number of items in this batch.
   */
  size: number;
  /**
   * Total item count when known.
   */
  totalItems?: number;
  /**
   * Total batch count when known.
   */
  totalBatches?: number;
};

/**
 * Options for `chunk(...)`.
 */
export type ChunkOptions = {
  /**
   * Maximum number of items per batch.
   */
  batchSize: number;
};

/**
 * Options for `runBatches(...)`.
 */
export type RunBatchesOptions<T, R> = {
  /**
   * Maximum number of items passed to each `onBatch(...)` call.
   */
  batchSize: number;
  /**
   * Handler called once per batch. Batches are processed sequentially.
   *
   * @param batch - Current batch of items.
   * @param meta - Metadata describing the current batch.
   * @returns A result for this batch.
   */
  onBatch(batch: T[], meta: BatchMeta): R | Promise<R>;
};

/**
 * Options for `runParamBatches(...)`.
 */
export type RunParamBatchesOptions<T extends BatchParamItem, R> = {
  /**
   * Items to split into batches.
   */
  items: Iterable<T> | AsyncIterable<T>;
  /**
   * Name of the parameter that receives each batch.
   */
  batchParam: string;
  /**
   * Maximum number of items passed to each `onBatch(...)` call.
   */
  batchSize: number;
  /**
   * Parameters shared by every batch.
   */
  params?: Record<string, ParameterValue>;
  /**
   * Handler called once per batch with merged params.
   *
   * @param params - Shared params plus the current batch under `batchParam`.
   * @param meta - Metadata describing the current batch.
   * @returns A result for this batch.
   */
  onBatch(params: Record<string, ParameterValue>, meta: BatchMeta): R | Promise<R>;
};

/**
 * Splits a synchronous iterable into array batches.
 *
 * This helper does not materialize the full iterable, so it can process large
 * inputs incrementally.
 *
 * @param items - Items to split.
 * @param options - Chunk options.
 * @returns A generator yielding item batches.
 */
export function* chunk<T>(items: Iterable<T>, options: ChunkOptions): Generator<T[]> {
  assertBatchSize(options.batchSize);

  let batch: T[] = [];

  for (const item of items) {
    batch.push(item);

    if (batch.length === options.batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

/**
 * Runs a batch handler sequentially for a sync or async iterable.
 *
 * The returned array contains one result per processed batch. Batches are not
 * processed concurrently, which keeps memory usage predictable and avoids
 * overwhelming database drivers by default.
 *
 * @param items - Items to split into batches.
 * @param options - Batch execution options.
 * @returns Batch handler results in execution order.
 */
export async function runBatches<T, R>(
  items: Iterable<T> | AsyncIterable<T>,
  options: RunBatchesOptions<T, R>,
): Promise<R[]> {
  assertBatchSize(options.batchSize);

  const results: R[] = [];
  const knownTotal = getKnownTotal(items);
  const totalBatches =
    knownTotal === undefined ? undefined : Math.ceil(knownTotal / options.batchSize);
  let index = 0;
  let offset = 0;
  let batch: T[] = [];

  for await (const item of toAsyncIterable(items)) {
    batch.push(item);

    if (batch.length === options.batchSize) {
      results.push(await options.onBatch(batch, createMeta(index, offset, batch.length, knownTotal, totalBatches)));
      index += 1;
      offset += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    results.push(await options.onBatch(batch, createMeta(index, offset, batch.length, knownTotal, totalBatches)));
  }

  return results;
}

/**
 * Runs a batch handler with query parameter objects.
 *
 * This is useful for `UNWIND` queries: pass the large item collection here,
 * and each batch will be exposed under `batchParam` while shared params are
 * preserved.
 *
 * @param options - Parameter batch execution options.
 * @returns Batch handler results in execution order.
 */
export async function runParamBatches<T extends BatchParamItem, R>(
  options: RunParamBatchesOptions<T, R>,
): Promise<R[]> {
  return runBatches(options.items, {
    batchSize: options.batchSize,
    onBatch: (batch, meta) =>
      options.onBatch(
        {
          ...(options.params ?? {}),
          [options.batchParam]: batch,
        },
        meta,
      ),
  });
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer.");
  }
}

function createMeta(
  index: number,
  offset: number,
  size: number,
  totalItems: number | undefined,
  totalBatches: number | undefined,
): BatchMeta {
  return {
    index,
    offset,
    size,
    ...(totalItems === undefined ? {} : { totalItems }),
    ...(totalBatches === undefined ? {} : { totalBatches }),
  };
}

function getKnownTotal<T>(items: Iterable<T> | AsyncIterable<T>): number | undefined {
  if (Array.isArray(items)) {
    return items.length;
  }

  if (items instanceof Set || items instanceof Map) {
    return items.size;
  }

  return undefined;
}

async function* toAsyncIterable<T>(items: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  if (Symbol.asyncIterator in items) {
    yield* items;
    return;
  }

  yield* items;
}
