/** The parts of an `ErrorDefinition` the docs show. */
export interface DocumentedError {
  code: number;
  key: string;
  message: string;
}

export interface ErrorExample {
  summary: string;
  value: { success: false; errorCode: number; error: string; errorMessage: string; requestId: string };
}

const EXAMPLE_REQUEST_ID = '3f1c2d9e-5b7a-4c1e-9f0a-2b6d8e4c7a10';

/** One example per error code, keyed by the error key, valued as the real error envelope. */
export function errorExamples(errors: readonly DocumentedError[]): Record<string, ErrorExample> {
  const examples: Record<string, ErrorExample> = {};
  for (const { code, key, message } of [...errors].sort((a, b) => a.code - b.code)) {
    examples[key] = {
      summary: `${key} (${code})`,
      value: { success: false, errorCode: code, error: key, errorMessage: message, requestId: EXAMPLE_REQUEST_ID },
    };
  }
  return examples;
}

/** Markdown list of the codes in a response's examples, used as the response description. */
export function describeErrorExamples(examples: Record<string, unknown>): string {
  return Object.values(examples)
    .map((example) => {
      const { value } = example as ErrorExample;
      return `- \`${value.error}\` (${value.errorCode}): ${value.errorMessage}`;
    })
    .join('\n');
}
