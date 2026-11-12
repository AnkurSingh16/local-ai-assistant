# ADR-0009: Anonymous sessions, memory review and real deletion

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

The demo has no accounts, yet users need conversation memory, rate limits per session, and the ability to see and delete what the assistant remembers about them. The assistant must never learn from raw conversations: only items I approve become memory, eval cases or training examples. The Tay failure was learning straight from users.

## Options considered

1. **Accounts with passwords.** Real identity across devices, but sign-up, password storage and reset flows for a local demo.
2. **A bearer token in `localStorage` everywhere.** One mechanism, but any XSS can read it, and the app renders text derived from the web.
3. **An anonymous random session token: an HttpOnly cookie on web, a bearer header on mobile.**

## Decision

Option 3.

- `POST /v1/sessions` creates a session with a 256-bit random token (base64url). The database stores only its SHA-256 hash. Sessions expire after 30 days idle.
- **Web:** an HttpOnly, `SameSite=Strict` cookie (`Secure` when not on localhost), served same-origin through the Vite proxy in development and by the API in production. **Mobile:** `Authorization: Bearer`, with the token in `expo-secure-store`.
- Session creation is rate limited per IP (10 per hour), so per-session limits cannot be dodged by minting sessions.
- Endpoints: `GET /v1/me/memory` lists everything remembered, `DELETE /v1/me/memory/:id` removes one item, `DELETE /v1/me` deletes the session and all its data and invalidates the token.
- **Learning only through review.** Feedback, corrections and preference candidates are moderated before storage and wait in the review queue, tied to the session. A review command lists them; only items I approve become memory, and **approved memory stays tied to its session** and is deleted with it.
- **Eval cases never contain user words.** To turn something into an eval case, I type a new paraphrase. The promote command rejects it if it shares a run of five or more words with the source or matches personal-data patterns (email, phone, card-like numbers, URLs with query strings, six or more digits in a row), and writes only the paraphrase, a category and the expected behaviour, with no session id, timestamp or source id. Those cases are committed to git so CI can run them. Fine-tuning examples follow the same paraphrase rule; none are built for the demo.
- **What users are told** on the memory page: "Everything stored under your session (conversations, remembered items, feedback and items waiting for my review) is deleted for real when you delete it. If a conversation shows me a useful test, I may write a new, anonymised test case inspired by it. It contains none of your words or personal details and cannot be linked back to you. Your searches are sent through my search server to public search engines."

## Consequences

- A stolen token exposes that one session's conversations and memory, and nothing else.
- Memory does not follow a user across devices.
- Deletion is real ([ADR-0001](0001-storage-sqlite.md)): tests delete a session and then byte-scan the database file and WAL for a planted marker.

## Evidence

- OWASP LLM02:2025 Sensitive Information Disclosure (data sanitisation, transparency about data use): https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/ (accessed 2026-11-12).
- Microsoft on Tay: https://blogs.microsoft.com/blog/2016/03/25/learning-tays-introduction/ (accessed 2026-11-12).
