# API reference

The API listens on `127.0.0.1:8787` by default. Every request must carry an allowed `Host` header, and browser requests an allowed `Origin` ([configuration](configuration.md)). Request bodies are JSON only and at most 16 KB.

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
- A refusal or a model error arrives as an event. A turn that cannot be delivered throws `ChatClientError`, whose `code` is `network`, `rate_limited`, `busy`, `rejected`, `server`, `protocol` or `incomplete`, and whose `message` is safe to show. `retryAfterMs` is set when the server sends one.
- `parseSse` implements the WHATWG event-stream format: LF, CR and CRLF line ends, multi-line data, comments, and a 1 MB frame cap.
- `reduceTurn` folds a turn's events into one `TurnView`, whose `text` is the deltas concatenated,, so both apps render refusals, errors and cut-off answers the same way.

The contract tests encode the shared fixture turns in `@local-ai/contract/fixtures` with the server's encoder, split them at many byte boundaries, including one byte at a time, and check the client reads back exactly the same events.
