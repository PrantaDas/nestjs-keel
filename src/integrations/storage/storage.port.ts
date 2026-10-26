export interface UploadInput {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
}

export interface PresignedUpload {
  /** PUT this URL with the same `Content-Type` (and size, when one was signed). */
  url: string;
  method: 'PUT';
  /** Headers the client must send unchanged (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectMetadata {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * Object storage. Clients upload and download directly with presigned URLs, so large files never
 * pass through (or block) the API servers; the server only signs, checks and deletes.
 * Bound to S3 in `IntegrationsModule`; tests bind an in-memory fake.
 */
export abstract class FileStorage {
  /** Presigned PUT; `Content-Type` and the exact size are signed, so nothing else can be uploaded. */
  abstract createUploadUrl(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>;

  /** Presigned GET for a private object; `downloadName` sets `Content-Disposition: attachment`. */
  abstract createDownloadUrl(key: string, options?: { downloadName?: string }): Promise<string>;

  /** Size and type of an object, or null when it does not exist (confirm an upload happened). */
  abstract headObject(key: string): Promise<ObjectMetadata | null>;

  abstract upload(input: UploadInput): Promise<void>;

  /** Deleting a missing object is not an error. */
  abstract delete(key: string): Promise<void>;

  abstract deleteMany(keys: readonly string[]): Promise<void>;

  /** Public URL when a CDN / public bucket is configured, else null (use a download URL). */
  abstract publicUrl(key: string): string | null;
}
