This directory contains the J5 Connect container image, Compose stack, and local test profile.
The operator guide will land at `docs/j5/user/j5-connect.md` in a follow-up PR.

## Testing locally

From the repository root, run this in Bash with Docker Compose, Python 3, and curl.
The test profile runs a second Dex as the upstream provider. Both issuers are
published on loopback. Set `J5_CONNECT_TEST_HTTPS_PORT` or
`J5_CONNECT_TEST_UPSTREAM_PORT` if the default ports (8443 and 5557) are in use.

```bash
(
  cd infra/j5-connect
  compose=(docker compose -f compose.yaml -f compose.test.yaml --profile test -p j5-connect-test)
  trap '"${compose[@]}" down --volumes' EXIT
  "${compose[@]}" up --build --wait &&
    python3 test/offboarding.py "${compose[@]}"
)
```

The script trusts the fixture's Caddy CA, signs in, and refreshes the token.
It deletes the upstream account, then checks that refresh is refused while the
upstream issuer remains reachable. Tokens are redacted in the output.

For manual sign-in, keep the test stack running and seed the invented account
from `infra/j5-connect/` with the following commands.

```bash
compose=(docker compose -f compose.yaml -f compose.test.yaml --profile test -p j5-connect-test)
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U connect -d upstream \
  < test/upstream-user.sql
"${compose[@]}" exec -T connect cat /data/caddy/pki/authorities/local/root.crt \
  > /tmp/j5-connect-test-root.crt
```

Trust that CA in the test browser. The fixture account is `ada@example.test`
with password `fixture-password`. Connect runs at `https://localhost:8443` by
default. Use client ID `j5-fixture`, secret `fixture-j5-secret`, and callback
`http://localhost/callback`. Finish with `"${compose[@]}" down --volumes`.
