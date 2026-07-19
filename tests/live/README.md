# Opt-in live provider tests

These tests make paid network calls and are intentionally excluded from
Vitest's default `*.test.*` / `*.spec.*` discovery. `npm test` never runs them.

Configure an ignored project-root `.env` file:

```dotenv
DEEPSEEK_KEY=...
DEEPSEEK_MODEL=...
DEEPSEEK_BASE_URL=... # optional; defaults to https://api.deepseek.com/v1
```

Run them explicitly:

```sh
npm run test:live:deepseek
```

The suite uses only in-memory tools. It has no project-write or shell tools,
does not retry failed tests, caps each model response, applies per-call
timeouts, and aborts after a small fixed number of HTTP requests.
