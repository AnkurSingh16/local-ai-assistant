# Mobile app

The Expo client. It uses the same headless client as the web app (`@local-ai/client`): the SSE parser, the turn reducer, the `useChat` hook and the answer splitter. So a turn streams, stops, cites and refuses the same way on both.

## Run it

The API has to be reachable from the phone, so I start it bound to my Mac's LAN address and allow that host (ADR-0010). The API logs a warning when it listens beyond loopback.

```bash
HOST=0.0.0.0 ALLOWED_HOSTS=192.168.1.20:8787,127.0.0.1:8787 npm run dev -w @local-ai/api
```

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 npm run dev:mobile
```

Replace `192.168.1.20` with the Mac's address on the Wi-Fi. This is plain HTTP, so anyone on the same network can read the session token and the messages: I use it only on a network I trust, and a public setup puts TLS in front of the API (ADR-0010). Scan the QR code with Expo Go. In the iOS Simulator, `EXPO_PUBLIC_API_URL` can stay unset: it defaults to `http://127.0.0.1:8787`.

## How it differs from the web app

- **Streaming.** React Native's built-in `fetch` does not stream response bodies, so the app passes `expo/fetch` to the client (ADR-0007).
- **Session.** The app gets a session token from `POST /v1/sessions` and keeps it in `expo-secure-store` (the iOS Keychain or Android Keystore). It sends the token as `Authorization: Bearer`; the web app uses an HttpOnly cookie instead (ADR-0009). Requests omit cookies, so the API's `Set-Cookie` never reaches the native cookie jar, and refuse redirects, so the token never follows one (`src/fetch.ts`). "Delete everything" removes the token from the device as well as the data on the server.
- **Sources** open in the system browser. Answers render as plain text, with code blocks in a monospace font. There is no HTML, no Markdown links and no images.
- Feedback is sent from the web app only for now.

## Tests

`npx vitest run --project mobile` runs the screens with React Native Testing Library. React Native's own entry point is Flow source that needs its Jest preset, and this repository uses Vitest, so the tests swap `react-native` for a small stand-in (`src/test/react-native.tsx`). The stand-in renders the same component tree onto host elements named as React Native names them. The streaming contract tests feed the shared fixtures from `@local-ai/contract` through the real client, in seven-byte chunks the way `expo/fetch` delivers a body, and check the screen shows what the web app shows. These tests check behaviour, not native rendering.

`npx expo export --platform ios` checks that Metro bundles the app with the shared packages read from source.

## Device check

The Expo source suggests `expo/fetch` honours `AbortSignal`, but the docs do not say so (ADR-0007). To confirm it on a device, I ask the real model for something long ("write a 600-word story"), tap Stop, and check that:

1. "Stopped." appears.
2. The API log shows the request closed by the client.
3. No further text arrives.

I have not recorded this check on a physical phone yet ([#50](https://github.com/AnkurSingh16/local-ai-assistant/issues/50)); until I do, Stop on mobile is covered only by the tests above, and Milestone 6 stays in progress.
