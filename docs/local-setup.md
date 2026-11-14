# Local setup

Everything runs on one Mac. I use an M1 Pro with 16 GB of RAM.

## Prerequisites

- Node.js 24 (`.nvmrc` pins the major version; `nvm use` picks it up)
- Docker Desktop, for SearXNG (`npm run dev` starts it)
- Ollama 0.40.15 or newer

## Ollama and models

I pick the chat model by RAM. Check yours with:

```bash
sysctl -n hw.memsize | awk '{ printf "%.0f GB\n", $1 / 1024 / 1024 / 1024 }'
```

With about 16 GB or more I use `qwen2.5:7b`. With less, use `llama3.2:3b`.

```bash
ollama pull qwen2.5:7b
```

On 16 GB I use the 1B guard, because the 8B guard cannot stay loaded next to the chat model ([ADR-0006](adr/0006-guard-model-size.md)). With 24 GB or more, pull `llama-guard3:8b` instead.

```bash
ollama pull llama-guard3:1b
```

```bash
ollama pull nomic-embed-text
```

The database lives in `data/`. Exclude that folder from Time Machine, or deleted conversations survive in backups.

## Ollama settings

The guard and the chat model must stay loaded together, and Ollama should run one request at a time ([ADR-0006](adr/0006-guard-model-size.md), [ADR-0011](adr/0011-search-cache-and-rate-limits.md)). The API asks for a 30-minute `keep_alive` on every call. Set parallelism for the Ollama app, then quit and reopen it:

```bash
launchctl setenv OLLAMA_NUM_PARALLEL 1
```

`npm run doctor` (run automatically before `npm run dev`) checks the Ollama version, that the configured models are pulled, that their digests match the ones pinned in ADR-0010, and that SearXNG answers. It also checks that ports 8787 and 5173 are free. Every failure comes with the command that fixes it.

## SearXNG

SearXNG runs in Docker Compose (`compose.yaml`) and needs no API key. It is published on `127.0.0.1:8888` only, with a read-only filesystem, no Linux capabilities and the image pinned by digest; `searxng/settings.yml` turns on JSON output and strict safe search, turns off the bot limiter (it is reachable only from this machine), the image proxy and metrics, and shortens the outgoing timeouts; the rest stays at SearXNG's defaults. The container runs as SearXNG's own unprivileged user with memory and process limits. `npm run dev` starts it, or start and stop it yourself:

```bash
npm run searxng:up
```

```bash
npm run searxng:down
```

`searxng:up` generates a fresh random `SEARXNG_SECRET` on every start, so no secret is stored, and does nothing when `PROVIDERS=mock` is set in the shell (it does not read `.env`). The doctor checks that SearXNG answers on its health endpoint.

## Running the assistant

```bash
npm run dev
```

This starts SearXNG, runs the doctor, then starts the API on `http://127.0.0.1:8787` and the web app on `http://127.0.0.1:5173`. Open the web app in a browser. The web dev server proxies `/v1` to the API, so the browser only ever talks to one origin. Both bind to loopback only. The dev server runs without the Content Security Policy, because Vite's fast refresh needs an inline script; the production build adds the policy, and the end-to-end tests run against that build.

The first answer after a restart takes longer while Ollama loads the models. The API loads the guard model at startup, and `GET /readyz` turns ready once it answers.

To try the app without Ollama, run the mock providers. Answers are a fixed sentence, and messages containing `MOCK_FLAG` are refused:

```bash
PROVIDERS=mock npm run dev -w @local-ai/api
```

If port 5173 is taken by another project's dev server, the doctor says so. The web app does not move to another port silently; pick one with `WEB_PORT` (see [Troubleshooting](#troubleshooting)).

## Mobile app with Expo Go

The Expo app runs on a phone with Expo Go on the same Wi-Fi network: the API is started bound to the Mac's Wi-Fi address with that address in `ALLOWED_HOSTS`, and `npm run dev:mobile` is pointed at it with `EXPO_PUBLIC_API_URL`. [apps/mobile/README.md](../apps/mobile/README.md) has the exact commands and the device check of Stop. The connection is plain HTTP, so I only do this on a network I trust.

## Troubleshooting

When something goes wrong that I have hit before, the API prints a `hint` line in the terminal (a pino warning with `"event":"hint"` and a `problem` name) saying what happened and what to do. The advice is fixed text for each problem, so it never contains message text or anything from the request. At start-up the API also runs the doctor's Ollama checks and prints each failure with its fix. This section has the longer version of each.

### "I can't answer safely right now because my safety check isn't available"

The safety model has to answer before any message reaches the chat model, and a turn is refused rather than answered unchecked when it does not. This happened on my first turns from the phone. The terminal shows a `guard_unavailable` hint. The usual causes:

- **The models are still loading.** After a restart, or after Ollama has unloaded them, the first turn loads the guard and the chat model, which can take a minute on 16 GB. Wait until `GET /readyz` reports ready, then try again:

  ```bash
  curl -s http://127.0.0.1:8787/readyz
  ```

- **Ollama is not running, or the model is not pulled.** `ollama ps` should list the guard model. If it does not answer, open the Ollama app; if the model is missing, pull it (`ollama pull llama-guard3:1b`).
- **Another app loaded the guard at a different context size.** The API counts the guard as warm only when Ollama has it loaded at the context size the API asks for. If another project shares Ollama and loads the same model with other options, Ollama reloads it on every switch and the API waits for the slow, cold timeout instead. Check the `CONTEXT` column of `ollama ps`, and stop the other app while testing.
- **Ollama runs requests in parallel.** With more than one request at a time, the chat model and the guard compete for memory. Set `OLLAMA_NUM_PARALLEL` to 1 as in [Ollama settings](#ollama-settings).

### "The assistant is not available right now" or "That took too long to answer."

A `chat_model_unavailable` hint means the API could not reach the chat model: start Ollama, and pull the chat model if `npm run doctor` says it is missing. A `turn_timeout` hint means a turn ran past `TURN_TIMEOUT_MS` (60 seconds by default), usually because a model was loading or another app was keeping Ollama busy. Try again once `ollama ps` shows both models loaded, or raise `TURN_TIMEOUT_MS`.

### The API will not start: port in use

If port 8787 is taken, the API prints which command shows the process holding it and exits. Either stop that process or run the API on another port:

```bash
lsof -i :8787
```

```bash
PORT=8788 npm run dev -w @local-ai/api
```

The web dev server proxies to `127.0.0.1:8787` by default; point it at the new port with `API_TARGET=http://127.0.0.1:8788`.

### The web app will not start: port 5173 in use

Another project's dev server often holds 5173. Pick another port with `WEB_PORT`, set for the whole command so the doctor, the API's allowed origins and the web dev server all agree. Set it on the command, not in `.env`: the API reads `.env`, but the web dev server does not.

```bash
WEB_PORT=5174 npm run dev
```

### Requests get 403 Forbidden

The API refuses a `Host` or `Origin` header it does not expect, which is what stops DNS rebinding and other sites calling it. The terminal shows a `request_rejected` line, and the first refusal of each kind in a run adds a hint. The hint never repeats the refused value as something to allow, because a page trying to reach the API through DNS rebinding causes exactly this refusal: I only allow an address I chose myself.

- **Host rejected** happens when the API is reached by an address that is not in `ALLOWED_HOSTS`, typically the Mac's Wi-Fi address from a phone. Find the address with `ipconfig getifaddr en0`, add it with the port to `ALLOWED_HOSTS`, keeping the loopback entry, and bind beyond loopback with `HOST=0.0.0.0`.
- **Origin rejected** happens when the web app runs on a port the API does not expect. Use `WEB_PORT` as above. If neither applies, something else tried to call the API and the refusal is doing its job.

### The phone cannot reach the API

Expo Go loads the app but turns fail, or `/healthz` never answers. I work through these in order:

1. **Use the Mac's real address.** Find it with `ipconfig getifaddr en0` and use the number it prints in both `ALLOWED_HOSTS` and `EXPO_PUBLIC_API_URL`. Type it out: the commands in [apps/mobile/README.md](../apps/mobile/README.md) use an example address, and a placeholder such as `<IP>` makes zsh treat `<` as a file redirect (`no such file or directory`).
2. **Type plain ASCII.** Copying a command from a chat or a note on the phone can bring in look-alike characters, such as a full-width `＠` in a package name or curly quotes, which npm and the shell reject with confusing errors. Retype the command if it fails for no clear reason.
3. **Restart Expo after changing the address.** `EXPO_PUBLIC_API_URL` is read when the bundle is built. Stop `npm run dev:mobile`, start it again with the new value, and reload the app in Expo Go.
4. **Allow the connection in the macOS firewall.** The first time the API listens beyond loopback, macOS may ask whether `node` may accept incoming connections. Choose Allow; if it was denied, change it in System Settings, Network, Firewall.
5. **Be on the same network.** The phone and the Mac must be on the same Wi-Fi. Guest networks and some routers isolate clients from each other, and a phone on mobile data cannot reach the Mac at all.
6. **Check from the phone.** Open `http://<the Mac's address>:8787/healthz` in Safari on the phone. `{"status":"ok"}` means the network path works and the problem is in the app's settings; no answer means the firewall or the network is in the way.

This is plain HTTP, so I only do it on a network I trust ([ADR-0010](adr/0010-process-topology-and-pinning.md)).

### SearXNG does not answer

The doctor reports it, and answers that need the web fail. Check that Docker Desktop is running, then restart the container with `npm run searxng:down` and `npm run searxng:up`. Answers from model knowledge still work without SearXNG.

### A harmless answer stops with "I can't help with that."

Each paragraph of an answer is checked by the safety model before it is shown, and a flagged paragraph ends the answer with this refusal. The small guard used on 16 GB sometimes flags harmless text, most often first-aid advice, headings and short lead-ins such as "Here are the steps:". Asking again can give an answer worded differently enough to pass. [ADR-0014](adr/0014-output-guard-stand-in.md) has the measurements. To check the guard on my set of harmless and harmful paragraphs after changing the guard model or Ollama, I run:

```bash
npm run eval:guard:live
```

### Warnings that are safe to ignore

- `npm ci` may warn that install scripts were skipped for `esbuild`. Its binary ships as a platform package, so nothing is missing.
- The API logs a `server_exposed` warning whenever it listens beyond loopback. That is expected while testing on the phone and a reminder to stop it afterwards.
