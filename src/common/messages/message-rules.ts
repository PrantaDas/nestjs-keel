/**
 * The rules every message shown to people must follow (error `errorMessage` / `details[].message`
 * and success `message`): a plain sentence that names no internals. Checked by the message guard
 * tests over the error registry, every validation rule and every route's success message.
 */

/** Internals that must never appear in a public message. */
export const FORBIDDEN_IN_MESSAGES =
  /E11000|mongo|mongoose|redis|bullmq|queue|cron|objectid|s3|stack|undefined|null|\bkey\b|snapshot/i;

/** Provider names and technical jargon a person should not have to read. */
export const JARGON_IN_MESSAGES =
  /\b(wati|msg91|twilio|firebase|fcm|unsplash|apitemplate|proxycheck|smtp|aws|sentry|http|endpoint|header|payload|json|bearer|idempoten\w*|enum|regex|boolean|e164|iso[ -]?8601|claim(ed|s)?|lock(ed|s)?|cache[ds]?|database|collection|index|schema|dto|webhook|ttl)\b/i;

/**
 * A sentence: starts with a capital letter, a digit or a brand-style word such as "iOS" (after an
 * opening quote), and ends with a period.
 */
export const SENTENCE = /^["“(]?([A-Z0-9]|i[A-Z])[\s\S]*\.$/;

/**
 * Words the checks above would flag that are product language people see in the UI. Keep this
 * short and justify each entry.
 */
const ALLOWED_EVERYWHERE: ReadonlyArray<{ word: RegExp; why: string }> = [
  // A status value of exports and notification deliveries; the admin panel shows it as "Queued".
  { word: /\bqueued\b/gi, why: 'export and delivery status shown in the admin panel' },
];

/** Allowed only in the message with this id (error key, or `Dto.property` for validation rules). */
export const MESSAGE_ALLOWLIST: Readonly<Record<string, RegExp>> = Object.freeze({
  // "Locked" is the account state people see after too many failed sign-ins.
  ACCOUNT_LOCKED: /\blocked\b/gi,
});

/** Problems with one message, empty when it is fine. `id` selects allowlist entries. */
export function messageProblems(message: string, id?: string): string[] {
  const problems: string[] = [];
  if (!message.trim()) return ['is empty'];
  if (!SENTENCE.test(message)) problems.push('is not a sentence (capital letter first, period last)');

  let checked = ALLOWED_EVERYWHERE.reduce((text, { word }) => text.replace(word, ''), message);
  const allowed = id ? MESSAGE_ALLOWLIST[id] : undefined;
  if (allowed) checked = checked.replace(allowed, '');

  const forbidden = FORBIDDEN_IN_MESSAGES.exec(checked);
  if (forbidden) problems.push(`mentions "${forbidden[0]}"`);
  const jargon = JARGON_IN_MESSAGES.exec(checked);
  if (jargon) problems.push(`uses jargon "${jargon[0]}"`);
  if (/\s{2,}|\s,|\s+\.$/.test(message)) problems.push('has stray spaces');
  return problems;
}
