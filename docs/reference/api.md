# API reference

The API listens on `127.0.0.1:8787` by default. Every request must carry an allowed `Host` header, and browser requests an allowed `Origin` ([configuration](configuration.md)). Request bodies are JSON only and at most 16 KB.

## Sessions

There are no accounts. `POST /v1/sessions` creates an anonymous session and answers `201` with `{ "token": "..." }`; it also sets the `lai_session` cookie (HttpOnly, SameSite=Strict, Secure off loopback, 30 days). The web app relies on the cookie; the mobile app keeps the token and sends `Authorization: Bearer <token>`. Only the token's SHA-256 hash is stored, and a session expires after 30 days without use. Creating sessions is limited to 10 per hour per IP.

`GET /v1/me` answers `200` with `{ "active": true }` while the session is in use, and `{ "active": false }` otherwise. A first visit has no session, so I do not treat it as an error.

With a session, `POST /v1/chat` remembers the conversation: the most recent turns that fit the history budget are sent with the next message, and the moderated message and the released answer are stored. A `conversationId` that belongs to another session is answered with `404`. Without a session every turn is stateless.

## Memory and deletion

All need a session ([ADR-0009](../adr/0009-sessions-and-memory-deletion.md)).

- `GET /v1/me/memory` lists everything remembered: `{ "items": [{ "id", "content", "createdAt" }] }`. Items appear only after I approve them.
- `DELETE /v1/me/memory/:id` forgets one item: `204`, or `404` if it is not this session's.
- `DELETE /v1/me` deletes the session and everything under it (conversations, memory, feedback, items waiting for review) and clears the cookie: `204`. Deletion cascades in the database, and a WAL checkpoint follows, so the text is gone from the files as well as the tables.

The web app shows the same list under "What I remember", with the wording promised in ADR-0009.

## `POST /v1/feedback`

Needs a session. Body: `{ "kind": "feedback" | "correction" | "preference", "text": "1 to 1,000 characters" }`. The text passes the same input guard as a chat message; a flagged item is dropped and only its category and time are recorded. The answer is always `202` with `{ "received": true }`, whether the item was queued or dropped, so the endpoint reveals nothing about moderation. Queued items wait for my review; only items I approve become memory.

## `POST /v1/chat`

Runs one turn and streams it as Server-Sent Events ([ADR-0007](../adr/0007-streaming-contract.md)). The schemas live in `packages/contract`.

Request:

```json
{ "message": "What is a rainbow?", "conversationId": "optional UUID" }
```

`message` is 1 to 4,000 characters. Unknown fields are rejected.

Response: `200` with `content-type: text/event-stream`. Each frame looks like this:

```text
event: delta
id: <messageId>:<seq>
data: {"type":"delta","text":"A rainbow is ..."}
```

| Event      | Payload                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`     | `conversationId`, `messageId`                                                                                                                |
| `status`   | `phase`: `moderating`, `searching`, `reading` or `answering`; optional `detail`                                                              |
| `delta`    | `text`: the next unit of the answer, already moderated. It keeps its trailing line breaks; concatenate deltas in order to rebuild the answer |
| `citation` | `n`, `url` (https only), `title`                                                                                                             |
| `refusal`  | `kind`: `policy`, `self_harm`, `unavailable` or `rate_limited`; a fixed `message`                                                            |
| `error`    | `code`: `bad_request`, `internal`, `model_unavailable` or `timeout`; generic `message`, `requestId`, `retryable`                             |
| `done`     | `finishReason`: `stop`, `length`, `refused` or `error`                                                                                       |

A turn always ends with `done`, unless the client disconnects. Disconnecting aborts the turn and stops generation. A `: ping` comment arrives every 15 seconds on a quiet stream. There is no resume: to retry, send the turn again.

A turn goes through these steps:

1. `meta`, then `status: moderating`.
2. The message is normalised and checked by the guard model. If it is flagged, the turn ends with `refusal` and `done: refused`, and the message never reaches the chat model. If the guard is down, the refusal kind is `unavailable`.
3. `status: answering`. The answer arrives one unit at a time: a paragraph, a sentence-aligned piece of a long paragraph, or a fenced code block. A long block arrives in line-aligned chunks of at most 2,000 characters. Each unit passes the guard before it is sent, while the model keeps generating the next. If a paragraph is flagged, generation stops, the paragraphs already sent stay, and the turn ends with `refusal`.

Errors before the stream starts come back as JSON:

```json
{
  "error": {
    "code": "bad_request",
    "message": "The request body is not valid.",
    "requestId": "..."
  }
}
```

| Status | `code`                   | When                                                     |
| ------ | ------------------------ | -------------------------------------------------------- |
| 400    | `bad_request`            | Invalid JSON or a body that fails the schema             |
| 403    | `forbidden`              | `Host` or `Origin` not allowed                           |
| 413    | `too_large`              | Body over 16 KB                                          |
| 415    | `unsupported_media_type` | Anything but `application/json`                          |
| 429    | `rate_limited`           | Too many turns from this IP; includes `retryAfterMs`     |
| 503    | `busy`                   | All turn slots and the queue are full; has `Retry-After` |

## `GET /healthz`

`200 {"status":"ok"}` while the process runs.

## `GET /readyz`

`200 {"status":"ready"}` once the guard model has answered its warm-up check at startup. `503 {"status":"starting"}` before that, or if the warm-up failed. Turns still work in that state, and they fail closed if the guard cannot answer.

## Headless client

`@local-ai/client` is what the web and mobile apps use to call the API. It depends only on `@local-ai/contract`, never on server code.

- `createChatClient({ baseUrl, fetch })` sends same-origin credentials only, until sessions arrive. It takes `fetch` as a parameter. The web app passes the browser's `fetch`, and the Expo app passes `expo/fetch`, which streams response bodies. `send(body, signal)` yields each event after validating it against the shared schema. Aborting the signal cancels the request, and with it the turn on the server.
- Two timeouts guard against a hung connection. If the response headers don't arrive within 30 seconds, `send` fails with `network`. If the stream then stays silent for 45 seconds, it fails with `incomplete`; that is three missed pings, which is how a half-open socket on a dropped Wi-Fi link shows up. Both errors are retryable, and both limits can be set with `connectTimeoutMs` and `idleTimeoutMs`.
- A refusal or a model error arrives as an event. A turn that cannot be delivered throws `ChatClientError`, whose `code` is `network`, `rate_limited`, `busy`, `rejected`, `server`, `protocol` or `incomplete`, and whose `message` is safe to show. `retryAfterMs` is set when the server sends one.
- `parseSse` implements the WHATWG event-stream format: LF, CR and CRLF line ends, multi-line data, comments, and a cap of 1,000,000 characters per frame.
- `reduceTurn` folds a turn's events into one `TurnView`, whose `text` is the deltas concatenated, so both apps render refusals, errors and cut-off answers the same way.

The contract tests encode the shared fixture turns in `@local-ai/contract/fixtures` with the server's encoder, split them at many byte boundaries, including one byte at a time, and check the client reads back exactly the same events.
