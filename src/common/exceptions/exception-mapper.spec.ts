import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { messageProblems } from '@/common/messages/message-rules';
import { IntegrationNotConfiguredException, ResourceNotFoundException, ValidationException } from './domain.exceptions';
import { defineDuplicateKeys } from './duplicate-keys';
import { mapException } from './exception-mapper';

/** E11000 as the driver throws it for `db.<collection>` and index `<index>`. */
const duplicateKey = (collection: string, keyPattern: Record<string, 1>, keyValue: Record<string, unknown>) =>
  Object.assign(new Error(`E11000 duplicate key error collection: app.${collection} index: x_1 dup key: { ... }`), {
    name: 'MongoServerError',
    code: 11000,
    keyPattern,
    keyValue,
  });

/** Nothing internal in the whole public envelope. */
const INTERNALS = /E11000|mongo|redis|titleKey|_1\b|index|collection|keyValue|stack|ObjectId|Path `/i;

defineDuplicateKeys('mapper_spec_items', [
  {
    fields: ['titleKey'],
    field: 'title',
    message: 'An item with this title already exists. Choose a different title.',
  },
]);

describe('mapException', () => {
  it('maps domain exceptions to their catalogue entry', () => {
    const { status, body, isServerError } = mapException(new ResourceNotFoundException('Note'), 'req-1');
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(isServerError).toBe(false);
    expect(body).toEqual({
      success: false,
      errorCode: 2005,
      error: 'RESOURCE_NOT_FOUND',
      errorMessage: 'Note not found.',
      requestId: 'req-1',
    });
  });

  it('uses the single validation message as errorMessage, and a pointer to the fields for several', () => {
    const one = mapException(new ValidationException([{ field: 'title', message: 'Title is required.' }]));
    expect(one.body.errorMessage).toBe('Title is required.');

    const many = mapException(
      new ValidationException([
        { field: 'email', message: 'Enter a valid email address.' },
        { field: 'age', message: 'Age must be 13 or more.' },
      ]),
    );
    expect(many.body.errorMessage).toBe('Please check the highlighted fields.');
    expect(many.body.details).toHaveLength(2);
  });

  it.each([
    [new NotFoundException('Cannot GET /api/v6/nope'), 404, 'ROUTE_NOT_FOUND'],
    [new ThrottlerException(), 429, 'RATE_LIMITED'],
    [new BadRequestException('Unexpected token } in JSON at position 3'), 400, 'BAD_REQUEST'],
    [new PayloadTooLargeException('File too large'), 413, 'PAYLOAD_TOO_LARGE'],
    [
      new ServiceUnavailableException({ error: { mongodb: { status: 'down', message: 'not connected' } } }),
      503,
      'SERVICE_UNAVAILABLE',
    ],
  ])('maps Nest HttpException %#', (exception, status, error) => {
    const mapped = mapException(exception);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error).toBe(error);
    // Framework messages and readiness details never leak to clients.
    expect(JSON.stringify(mapped.body)).not.toMatch(/Unexpected token|Cannot GET|File too large|mongodb|not connected/);
    expect(mapped.body.details).toBeUndefined();
    expect(messageProblems(mapped.body.errorMessage)).toEqual([]);
  });

  describe('duplicate keys', () => {
    it('never echoes the index, internal key names or values', () => {
      const { status, body } = mapException(
        duplicateKey('unknown_things', { titleKey: 1 }, { titleKey: 'secret@example.com' }),
        'req-2',
        { bodyFields: ['title'] },
      );
      expect(status).toBe(409);
      expect(body).toEqual({
        success: false,
        errorCode: 2006,
        error: 'DUPLICATE_RESOURCE',
        errorMessage: 'This already exists. Change it and try again.',
        requestId: 'req-2',
      });
      expect(JSON.stringify(body)).not.toMatch(INTERNALS);
      expect(JSON.stringify(body)).not.toContain('secret@example.com');
    });

    it('gives a registered unique index its own message and names the request field the client sent', () => {
      const { body } = mapException(duplicateKey('mapper_spec_items', { titleKey: 1 }, { titleKey: 'morning' }), 'r', {
        bodyFields: ['title', 'description'],
      });
      expect(body.errorMessage).toBe('An item with this title already exists. Choose a different title.');
      expect(body.details).toEqual([
        { field: 'title', message: 'An item with this title already exists. Choose a different title.' },
      ]);
      expect(JSON.stringify(body)).not.toMatch(INTERNALS);
    });

    it('leaves details out when the field was not in the request (a socket event, another route)', () => {
      const { body } = mapException(duplicateKey('mapper_spec_items', { titleKey: 1 }, { titleKey: 'morning' }));
      expect(body.errorMessage).toBe('An item with this title already exists. Choose a different title.');
      expect(body.details).toBeUndefined();
    });

    it('recognises an E11000 wrapped as the cause of another error (transactions)', () => {
      const wrapped = new Error('Transaction failed', {
        cause: duplicateKey('unknown_things', { userId: 1, day: 1 }, {}),
      });
      expect(mapException(wrapped).body.error).toBe('DUPLICATE_RESOURCE');
    });
  });

  it('maps a Mongoose CastError without naming internal paths', () => {
    const cast = {
      name: 'CastError',
      path: 'noteId',
      message: 'Cast to ObjectId failed for value "x" at path "noteId"',
    };
    const hidden = mapException(cast);
    expect(hidden.body).toMatchObject({
      error: 'INVALID_ID',
      errorMessage: "This link isn't valid. Please check it and try again.",
    });
    expect(hidden.body.details).toBeUndefined();

    const sent = mapException(cast, undefined, { bodyFields: ['noteId'] });
    expect(sent.body.details).toEqual([{ field: 'noteId', message: "Note isn't valid." }]);
    expect(JSON.stringify(sent.body)).not.toMatch(INTERNALS);
  });

  it('maps a Mongoose ValidationError to human messages, never "Path `x` is required"', () => {
    const error = {
      name: 'ValidationError',
      message: 'Sample validation failed: title: Path `title` is required., titleKey: Path `titleKey` is required.',
      errors: {
        title: { path: 'title', kind: 'required', message: 'Path `title` is required.' },
        titleKey: { path: 'titleKey', kind: 'required', message: 'Path `titleKey` is required.' },
      },
    };
    const { body } = mapException(error, undefined, { bodyFields: ['title'] });
    expect(body).toMatchObject({
      error: 'VALIDATION_FAILED',
      errorMessage: 'Title is required.',
      details: [{ field: 'title', message: 'Title is required.' }],
    });
    expect(JSON.stringify(body)).not.toMatch(INTERNALS);

    const internalOnly = mapException(error).body;
    expect(internalOnly.errorMessage).toBe("Some of the details aren't valid. Please check them and try again.");
    expect(internalOnly.details).toBeUndefined();
  });

  it('hides unknown errors behind a calm INTERNAL_ERROR and flags them for Sentry', () => {
    const { status, body, isServerError } = mapException(
      new Error('connection string mongodb://user:pw@host'),
      'req-3',
    );
    expect(status).toBe(500);
    expect(isServerError).toBe(true);
    expect(body).toEqual({
      success: false,
      errorCode: 9000,
      error: 'INTERNAL_ERROR',
      errorMessage: 'Something went wrong on our side. Please try again in a moment.',
      requestId: 'req-3',
    });
  });

  it.each([
    [Object.assign(new Error('getaddrinfo ENOTFOUND mongo'), { name: 'MongoServerSelectionError' }), 'mongodb', 9100],
    [
      Object.assign(new Error('Reached the max retries per request limit'), { name: 'MaxRetriesPerRequestError' }),
      'redis',
      9101,
    ],
  ])('answers a dependency outage with 503 that names no dependency %#', (error, dependency, code) => {
    const mapped = mapException(error, 'req-4');
    expect(mapped).toMatchObject({ status: 503, dependency, body: { errorCode: code } });
    expect(mapped.body.errorMessage).toBe('Our service is busy right now. Please try again in a moment.');
    expect(mapped.body.details).toBeUndefined();
    // The machine-readable key (DATABASE_UNAVAILABLE / REDIS_UNAVAILABLE) is part of the contract.
    expect(`${mapped.body.errorMessage} ${JSON.stringify(mapped.body.details ?? null)}`).not.toMatch(
      /mongo|redis|ENOTFOUND|retries/i,
    );
  });

  it('names what an unconfigured integration does, never the provider', () => {
    const { status, body } = mapException(new IntegrationNotConfiguredException('Twilio SMS'));
    expect(status).toBe(503);
    expect(body.errorMessage).toBe(
      "The text message service isn't set up yet, so this can't be done right now. Please contact support.",
    );
    expect(messageProblems(body.errorMessage)).toEqual([]);
  });
});
