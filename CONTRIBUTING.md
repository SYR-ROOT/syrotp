# Contributing to SYROTP

Thanks for your interest! SYROTP is a protocol-first project — the most valuable contributions are usually one of:

1. **Spec clarity** — improvements to `openapi.yaml` or `docs/protocol.md`.
2. **New SDK** — a faithful port of `packages/sdk-js` to another language.
3. **New gateway** — Linux/Windows USB modem gateway, or hardened Android gateway features.
4. **Security review** — see SECURITY.md for the threat model.

## Ground rules

- The **protocol** (the shape of requests and responses, the auth scheme) is sacred. Breaking changes need an RFC issue first.
- New SDKs must implement at least: `startVerification`, `getVerification`, `cancelVerification`, plus an idiomatic `waitForVerification`. They must use the language's standard TLS stack and constant-time HMAC compare.
- Tests are not optional. New code paths need at least one happy-path test and one error-path test.
- We do not accept dependencies that aren't actively maintained or that pull in copy-left licenses.

## Local development

```bash
pnpm install
docker compose up -d postgres redis
pnpm --filter @syrotp/server migrate
pnpm --filter @syrotp/server dev
```

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). Keep PRs focused — one logical change per PR.
