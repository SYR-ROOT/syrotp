## What & why

<!-- One paragraph: what does this change do, and why does it matter? -->

## Protocol impact

- [ ] No protocol change (default)
- [ ] Protocol change — `openapi.yaml` updated, `docs/protocol.md` updated, T1–T22 still pass

## Security impact

- [ ] None
- [ ] Adds / changes auth, HMAC, rate limit, redaction, or at-rest encryption — see SECURITY.md, added regression test

## Tests

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated (`pnpm test:integration`)
- [ ] `pnpm syrotp smoke` passes locally

## Checklist

- [ ] No secrets in diffs (search for `pk_live_`, `sk_live_`, hex blobs).
- [ ] CHANGELOG entry under "Unreleased".
- [ ] Public API change → SDK README updated.
