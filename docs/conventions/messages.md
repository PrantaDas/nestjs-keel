# Messages shown to people

Apps and the admin panel display `message`, `errorMessage` and `details[].message` as they are, so
every one is written for a person. The full catalogue is generated:
[docs/api/messages.md](../api/messages.md) (`pnpm messages:export`).

## The rules

- **A plain sentence:** capital letter first, period last, the next step when there is one ("Choose
  a time in the future."). Short and friendly for people, specific for staff.
- **No internals:** no database, cache, queue, cron, index or field-key names, no ObjectIds, storage
  keys, provider names (say "the payment service", "the text message service"), stack traces,
  driver text, HTTP jargon or personal data. Ids a client needs go in their own `details` property.
- **Validation** messages are built from the rule and the field's human label, in one place
  (`common/pipes/validation-messages.ts`): `@MaxLength(200)` on `title` reads "Title must be 200
  characters or fewer.", `@IsMongoId({ each: true })` on `tagIds` reads "Tags contains an item that
  isn't valid.". The text next to a decorator is only used for rules the formatter does not know; a
  full sentence there is used as written. `details[].field` keeps the request path (`reminder.time`)
  so forms can highlight the field; `errorMessage` is that message when there is one problem, or
  "Please check the highlighted fields.".
- **Labels:** derived from the property name (`noteIds` → "Notes", `isPinned` → "Pinned"); special
  cases in `common/messages/field-labels.ts`.
- **Outages and unknown failures:** "Something went wrong on our side. Please try again in a moment."
  plus the `requestId` for support. Details stay in logs and Sentry.

## Enforced, not hoped for

`test/unit/api-messages.spec.ts` fails when:

- an error in the registry, a duplicate-key message, a validation rule of any DTO, a literal
  `message:` at a throw site, or a route's success message is not a sentence, or matches
  `/E11000|mongo|redis|bullmq|queue|cron|objectid|s3|stack|undefined|null|key|snapshot/i`, or uses
  jargon (`http`, `json`, `token`, provider names, `database`, `schema`, …);
- an enveloped route has no `@ResponseMessage`;
- `docs/api/messages.md` is not what `pnpm messages:export` would write.

A word that is product language (shown in the UI) can be allowed for one message in
`common/messages/message-rules.ts`, with the reason next to it.
