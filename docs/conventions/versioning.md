# API versioning

REST routes are versioned in the URL: `/api/v1/notes`, `/api/v2/notes`. `API_DEFAULT_VERSION` (1)
applies to controllers that do not declare one. Webhooks for providers are `VERSION_NEUTRAL`
(`/api/webhooks/stripe`). GraphQL is not versioned: fields are added, and removed only after
`@deprecated` (`deprecationReason`) and a check that no client still asks for them.

## When a new version is needed

Only for a **breaking** change: a field removed or renamed, a type or meaning changed, a stricter
rule on input that used to be accepted, a different status code. Adding optional input fields,
response fields or routes is not breaking and stays in the current version.

## How (the notes module is the worked example)

1. The routes that did not change serve both versions from one controller:
   `@Controller({ path: 'notes', version: ['1', '2'] })`.
2. Routes whose shape changed exist twice, in a v1 and a v2 controller, sharing the service. The v2
   response class has its own name (`NoteV2Response`); the OpenAPI document lists each version once
   and suffixes older operation ids (`notesGetV1`) so generated clients stay unique.
3. The old routes are marked:

   ```ts
   @Controller({ path: 'notes', version: '1' })
   @Deprecated({ sunset: '2027-06-30', since: '2026-10-26' })   // successor: '/api/v2/notes' optional
   ```

   Every answer then carries `Deprecation: @<unix time>` (RFC 9745), `Sunset: <HTTP date>`
   (RFC 8594) and `Link: <…>; rel="successor-version"` when a successor is given. After the sunset
   day (on the injected clock, in UTC) the route answers **410 `ENDPOINT_RETIRED`** before auth runs.

4. Announce the sunset in the changelog and to client teams; give at least two app release cycles
   (mobile clients update slowly). Watch for traffic on the old version in logs (the version is part
   of the path) before the sunset day, then delete the v1 controller.

## Client contract

- Clients send no version header; the version is the path.
- A `Deprecation` header means "plan the move"; `Sunset` is the last day.
- A 410 with `ENDPOINT_RETIRED` means "update the app" and is safe to show as such.
