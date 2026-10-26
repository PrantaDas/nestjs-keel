/**
 * Human labels for request fields, used wherever a message names a field ("Title is required.").
 * `details[].field` keeps the real request path (forms map errors by it); only the wording changes.
 *
 * Most labels are derived from the property name (`showAnswerDuringActivity` → "Show answer during
 * activity", `questionIds` → "Questions", `imageKey` → "Image"). List a field here only when the
 * derived label would read badly or name an internal concept.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  id: 'Item',
  _id: 'Item',
  ids: 'Items',
  from: 'Start date',
  to: 'End date',
  createdFrom: 'Joined from',
  createdTo: 'Joined until',
  dob: 'Date of birth',
  q: 'Search',
  limit: 'Page size',
  phoneE164: 'Phone number',
  phone: 'Phone number',
  countryCode: 'Country code',
  dialCode: 'Country code',
  otp: 'Code',
  s3Key: 'File',
  uploadKey: 'Uploaded file',
  mediaKey: 'Uploaded media',
  imageKey: 'Image',
  backgroundImageKey: 'Background image',
  blankKey: 'Blank',
  fcmToken: 'Notification token',
  pushToken: 'Notification token',
  deviceId: 'Device',
  appVersion: 'App version',
  osVersion: 'System version',
  idempotencyKey: 'Request reference',
  occurrenceKey: 'Occurrence',
  dedupeKey: 'Reference',
  cursor: 'Page',
  jobId: 'Job',
  url: 'Link',
  deepLink: 'Link',
  deepLinkType: 'Link type',
  groupBy: 'Grouping',
  key: 'Uploaded file',
  header: 'Heading level',
  s3BucketUrl: 'File storage link',
  firebaseTopics: 'Notification topics',
  smtp: 'Email settings',
  twilio: 'Text message settings',
  msg91: 'Text message settings',
  wati: 'WhatsApp settings',
  isLocked: 'Locked',
  clientDurationMs: 'Time taken',
  sizeBytes: 'File size',
  htmlContent: 'Content',
  insert: 'Text',
  ops: 'Content',
  // Same property name, different meaning: `Dto.property` wins over the plain name.
  'SmtpSettingsDto.from': 'Sender address',
  'SmtpSettingsDto.user': 'Username',
  'SmtpSettingsDto.pass': 'Password',
  'SmtpSettingsDto.host': 'Server',
  startsAt: 'Start time',
  endsAt: 'End time',
  estimatedStartAt: 'Estimated start time',
  sendAt: 'Send time',
  scheduleAt: 'Scheduled time',
  publishAt: 'Publish time',
  expectedUpdatedAt: 'Last updated time',
});

/** Word-level replacements applied to derived labels (lower-case keys). */
const WORDS: Readonly<Record<string, string>> = Object.freeze({
  url: 'link',
  urls: 'links',
  uri: 'link',
  faq: 'FAQ',
  faqs: 'FAQs',
  otp: 'code',
  dob: 'date of birth',
  ios: 'iOS',
  sms: 'SMS',
  pdf: 'PDF',
  csv: 'CSV',
  xlsx: 'Excel',
  fcm: 'notification',
  bg: 'background',
  btn: 'button',
  qty: 'quantity',
  e164: '',
  sid: 'SID',
  html: 'HTML',
});

const NUMERIC = /^\d+$/;

/** Last meaningful segment of a request path: `items.0.title` → `title`. */
function lastSegment(path: string): string {
  const parts = path.split('.').filter((part) => part && !NUMERIC.test(part));
  return parts.at(-1) ?? path;
}

function stripTechnicalSuffix(name: string): string {
  const rules: Array<[RegExp, string]> = [
    [/^(.+)Ids$/, '$1s'],
    [/^(.+)Id$/, '$1'],
    [/^(.+)Keys$/, '$1s'],
    [/^(.+)Key$/, '$1'],
    [/^is([A-Z].*)$/, '$1'],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(name)) return name.replace(pattern, replacement);
  }
  return name;
}

/** Upper-cases the first letter, except in brand-style words such as "iOS". */
const capitalize = (text: string): string =>
  !text || /^[a-z][A-Z]/.test(text) ? text : text[0].toUpperCase() + text.slice(1);

/**
 * Human label for a request field path: `title` → "Title", `schedule.recurring.endDate` → "End date",
 * `questionIds` → "Questions". Never returns internal key names. `target` (the DTO class name)
 * selects a `Dto.property` label when one property name means different things in different DTOs.
 */
export function fieldLabel(path: string | undefined, target?: string): string {
  if (!path) return 'This field';
  const name = lastSegment(path);
  const known = (target && FIELD_LABELS[`${target}.${name}`]) || FIELD_LABELS[name];
  if (known) return known;

  const words = stripTechnicalSuffix(name)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((word) => {
      const lower = word.toLowerCase();
      return lower in WORDS ? WORDS[lower] : /^[A-Z\d]{2,}$/.test(word) ? word : lower;
    })
    .filter(Boolean);
  return capitalize(words.join(' ')) || 'This field';
}
