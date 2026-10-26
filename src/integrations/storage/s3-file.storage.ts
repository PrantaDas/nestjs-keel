import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import { resilienceConfig, storageConfig } from '@/config/configuration';
import { IntegrationCallException } from '@/integrations/resilience/failure';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import { FileStorage, ObjectMetadata, PresignedUpload, UploadInput } from './storage.port';

/** DeleteObjects accepts at most 1000 keys per call. */
const DELETE_BATCH = 1000;
const INTEGRATION = 'AWS S3';
const CONNECT_TIMEOUT_MS = 5_000;
/** SDK attempts per call (standard mode: exponential backoff with jitter; S3 calls are idempotent reads/writes). */
const MAX_ATTEMPTS = 3;

/**
 * S3 (or any S3-compatible store: SeaweedFS locally, MinIO, R2 via `S3_ENDPOINT`). Every call has
 * connect and socket timeouts, the SDK retries with jittered backoff (S3 operations are idempotent,
 * so retrying is safe here, unlike sends), and the `s3` circuit breaker fails fast while S3 is
 * unreachable. Presigning is local and makes no call.
 */
@Injectable()
export class S3FileStorage extends FileStorage implements OnApplicationShutdown {
  private client?: S3Client;
  private readonly timeoutMs: number;

  constructor(
    @Inject(storageConfig.KEY) private readonly config: ConfigType<typeof storageConfig>,
    private readonly time: TimeService,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).s3;
  }

  async createUploadUrl(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload> {
    const expiresIn = this.config.presignExpiresSeconds;
    const command = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    // The presigner leaves these unsigned by default; signing them pins the validated type and size.
    const url = await getSignedUrl(this.s3(), command, {
      expiresIn,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
      expiresAt: this.time.after(expiresIn * 1000),
    };
  }

  async createDownloadUrl(key: string, options: { downloadName?: string } = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ResponseContentDisposition: options.downloadName ? attachment(options.downloadName) : undefined,
    });
    return getSignedUrl(this.s3(), command, { expiresIn: this.config.presignExpiresSeconds });
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    const command = new HeadObjectCommand({ Bucket: this.bucket(), Key: key });
    const client = this.s3();
    return this.run(async () => {
      try {
        const result = await client.send(command);
        return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  async upload(input: UploadInput): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
    });
    await this.run(() => this.s3().send(command));
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.bucket(), Key: key });
    await this.run(() => this.s3().send(command));
  }

  /** Batches of 1000; missing keys are not an error, any per-key failure is (the batch is safe to retry). */
  async deleteMany(keys: readonly string[]): Promise<void> {
    const bucket = this.bucket();
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const command = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      });
      const result = await this.run(() => this.s3().send(command));
      if (result.Errors?.length) {
        const first = result.Errors[0].Code ?? 'unknown';
        throw new IntegrationCallException(
          INTEGRATION,
          { transient: first !== 'AccessDenied', ambiguous: false, reason: `delete_${first}` },
          new Error(`DeleteObjects failed for ${result.Errors.length} keys (first: ${first})`),
        );
      }
    }
  }

  publicUrl(key: string): string | null {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl.replace(/\/$/, '')}/${key}` : null;
  }

  onApplicationShutdown(): void {
    this.client?.destroy();
  }

  /** One S3 call through the breaker; SDK errors become a classified IntegrationCallException. */
  private run<T>(call: () => Promise<T>): Promise<T> {
    return guardedCall(INTEGRATION, call);
  }

  private bucket(): string {
    if (!this.config.bucket) throw new IntegrationNotConfiguredException(INTEGRATION);
    return this.config.bucket;
  }

  private s3(): S3Client {
    if (!this.config.bucket) throw new IntegrationNotConfiguredException(INTEGRATION);
    // No explicit keys → the SDK default chain (IAM role / instance profile), preferred in production.
    this.client ??= new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      maxAttempts: MAX_ATTEMPTS,
      retryMode: 'standard',
      requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: this.timeoutMs },
      credentials:
        this.config.accessKeyId && this.config.secretAccessKey
          ? { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey }
          : undefined,
    });
    return this.client;
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
