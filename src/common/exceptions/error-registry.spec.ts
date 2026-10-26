import { HttpStatus } from '@nestjs/common';
import { defineErrors } from './error-registry';

describe('defineErrors', () => {
  it('derives the key and domain from the declaration', () => {
    const errors = defineErrors('spec-a', [7100, 7199], {
      THING_MISSING: { code: 7100, status: HttpStatus.NOT_FOUND, message: 'Missing.' },
    });
    expect(errors.THING_MISSING).toEqual({
      code: 7100,
      status: HttpStatus.NOT_FOUND,
      message: 'Missing.',
      key: 'THING_MISSING',
      domain: 'spec-a',
    });
  });

  it('rejects codes outside the domain range at boot', () => {
    expect(() =>
      defineErrors('spec-b', [7200, 7299], { BAD: { code: 7300, status: HttpStatus.BAD_REQUEST, message: 'x' } }),
    ).toThrow(/outside range/);
  });

  it('rejects a code already owned by another error at boot', () => {
    defineErrors('spec-c', [7400, 7499], { FIRST: { code: 7400, status: HttpStatus.BAD_REQUEST, message: 'x' } });
    expect(() =>
      defineErrors('spec-d', [7400, 7499], { SECOND: { code: 7400, status: HttpStatus.BAD_REQUEST, message: 'y' } }),
    ).toThrow(/used by both spec-c.FIRST and spec-d.SECOND/);
  });
});
