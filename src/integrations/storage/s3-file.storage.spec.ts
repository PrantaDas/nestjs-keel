import { DeleteObjectsCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { IntegrationFailedException, IntegrationNotConfiguredException } from '@/common/exceptions';
import { FixedClock } from '@/common/time/clock';
import { UTC_POLICY } from '@/common/time/time-policy';
import { TimeService } from '@/common/time/time.service';
import { S3FileStorage } from './s3-file.storage';

type StorageConfig = ConstructorParameters<typeof S3FileStorage>[0];

const CONFIG: StorageConfig = {
  region: 'eu-west-1',
  // Static, obviously fake credentials: presigning is computed locally, nothing reaches AWS.
  accessKeyId: 'AKIAUNITTESTEXAMPLE0',
  secretAccessKey: 'unit-test-secret-not-real',
  bucket: 'assets-bucket',
  endpoint: undefined,
  forcePathStyle: false,
  publicBaseUrl: 'https://cdn.test',
  presignExpiresSeconds: 900,
  maxUploadBytes: 10_000_000,
};

const time = new TimeService(new FixedClock('2026-10-26T10:00:00Z'), UTC_POLICY);
const storage = (overrides: Partial<StorageConfig> = {}) => new S3FileStorage({ ...CONFIG, ...overrides }, time);
const signedHeaders = (url: string) => new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];

describe('S3FileStorage', () => {
  let send: jest.SpyInstance;

  beforeEach(() => {
    send = jest.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => send.mockRestore());

  it('signs Content-Type and Content-Length into upload URLs (nothing else can be uploaded)', async () => {
    const upload = await storage().createUploadUrl('users/u1/avatar.png', 'image/png', 2048);
    expect(upload.url).toContain('assets-bucket');
    expect(signedHeaders(upload.url)).toEqual(expect.arrayContaining(['content-type', 'content-length', 'host']));
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '2048' });
    expect(upload.expiresAt.toISOString()).toBe('2026-10-26T10:15:00.000Z');
    expect(send).not.toHaveBeenCalled();
  });

  it('uses a custom endpoint with path-style URLs for S3-compatible stores', async () => {
    const upload = await storage({ endpoint: 'http://localhost:8333', forcePathStyle: true }).createUploadUrl(
      'a.png',
      'image/png',
      1,
    );
    expect(upload.url.startsWith('http://localhost:8333/assets-bucket/a.png?')).toBe(true);
  });

  it('sets an attachment file name on downloads when asked', async () => {
    const url = await storage().createDownloadUrl('files/x.pdf', { downloadName: 'Report "Q1".pdf' });
    const disposition = new URL(url).searchParams.get('response-content-disposition');
    expect(disposition).toBe(`attachment; filename="Report _Q1_.pdf"; filename*=UTF-8''Report%20%22Q1%22.pdf`);
  });

  it('reports a missing object as null, other errors as integration failures', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
    );
    await expect(storage().headObject('gone')).resolves.toBeNull();

    send.mockResolvedValueOnce({ ContentLength: 12, ContentType: 'image/png' });
    await expect(storage().headObject('there')).resolves.toEqual({ sizeBytes: 12, contentType: 'image/png' });
    expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(HeadObjectCommand);

    send.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    );
    await expect(storage().headObject('x')).rejects.toBeInstanceOf(IntegrationFailedException);
  });

  it('deletes in batches of 1000 and fails on per-key errors', async () => {
    send.mockResolvedValue({});
    await storage().deleteMany(Array.from({ length: 1500 }, (_, i) => `k${i}`));
    const batches = send.mock.calls.map(([command]) => command as DeleteObjectsCommand);
    expect(batches.map((c) => c.input.Delete?.Objects?.length)).toEqual([1000, 500]);

    send.mockResolvedValueOnce({ Errors: [{ Code: 'SlowDown', Key: 'k1' }] });
    await expect(storage().deleteMany(['k1'])).rejects.toMatchObject({ transient: true });
  });

  it('is "not configured" without a bucket, and has no public URL without a CDN', async () => {
    await expect(storage({ bucket: '' }).createUploadUrl('a', 'image/png', 1)).rejects.toBeInstanceOf(
      IntegrationNotConfiguredException,
    );
    expect(storage({ publicBaseUrl: '' }).publicUrl('a.png')).toBeNull();
    expect(storage().publicUrl('a.png')).toBe('https://cdn.test/a.png');
  });
});
