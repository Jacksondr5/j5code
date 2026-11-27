# J5 Connect

J5 Connect lets people sign in to J5 servers through an identity provider
you choose. The Compose stack runs Dex and Caddy in one container and stores
Dex state in Postgres. The J5 agent server runs separately. Push and the
gateway are later phases.

## Run your own J5 Connect

Use Docker with Compose 2.24.4 or later. Point a DNS name at the host and
make TCP ports 80 and 443 reachable so Caddy can issue and renew TLS
certificates. Keep the two named volumes across upgrades. Back up
Postgres, which holds Dex signing keys and refresh state, and keep the
operator configuration and Caddy data available for recovery.

From this directory, copy `.env.example` to `.env` and fill in these values.
Keep the file private.

- `J5_CONNECT_ISSUER` is the public HTTPS origin, such as
  `https://connect.example.com`, with no path or trailing slash.
- `POSTGRES_PASSWORD` is a generated password for the stack's Postgres instance.
- `J5_CONNECT_PROVIDER` selects one of `oidc`, `github`, or `google`.
- `J5_CONNECT_UPSTREAM_CLIENT_ID` and `J5_CONNECT_UPSTREAM_CLIENT_SECRET`
  are the credentials for Connect's OAuth application at the upstream provider.
  Register the Connect issuer followed by `/callback` as the application's redirect URI.
- `J5_CONNECT_UPSTREAM_ISSUER` is the exact issuer from the provider's discovery
  document when you select `oidc`. The optional `J5_CONNECT_OIDC_SCOPES`
  defaults to `profile email offline_access`. Dex adds `openid`.
- `J5_CONNECT_CLIENTS` is a JSON array of confidential clients. Each server
  needs a unique `id`, a `name`, a generated `secret`, and its exact
  `redirectURIs`. Use a single-quoted value in `.env` to preserve literal dollar signs.

### Choose an identity provider

- Use the generic OIDC template for Entra ID and Okta. Allow your
  application to request `offline_access` and receive refresh tokens. If
  your provider omits `email_verified`, set the scopes to
  `profile offline_access` so Dex can accept the identity without a
  verified email claim. J5 binds accounts by issuer and subject. Changing
  the upstream issuer gives those accounts new subjects.
- For Google or Google Workspace, choose `google`. Dex uses
  `access_type=offline` and requests consent. For a Workspace-only
  installation, set the OAuth application's audience to your organization.
- For GitHub, choose `github` and register a GitHub OAuth app. Dex uses the
  upstream access token to recheck the account.

[Dex OIDC connector](https://dexidp.io/docs/connectors/oidc/) ·
[Dex Google connector](https://dexidp.io/docs/connectors/google/) ·
[Dex GitHub connector](https://dexidp.io/docs/connectors/github/)

## Join from a J5 server

A server trusts one J5 Connect. Register a client manually for each server.

1. Pick a client ID and generate a secret with `openssl rand -base64 32`.
   Store it in a private file on the J5 server and share it securely with
   the Connect operator.
2. As the server Owner, run the join command below. If the client still
   needs registration, use the exact redirect URIs the command prints.
   Each server address needs its own redirect URI ending in
   `/api/j5/identity/callback`.
3. On J5 Connect, add the client to `J5_CONNECT_CLIENTS` with that ID,
   secret and those redirect URIs. Start Connect with
   `docker compose up -d --build`. For subsequent client additions or
   redirect changes, run `docker compose up -d connect` to pick up the
   updated environment.
4. Run join again on the J5 server. Add a redirect URI to the client
   registration whenever the server gains an address.

```sh
j5 auth connect join https://connect.example.com \
  --client-id j5-server --client-secret-file ./connect-client-secret
```

J5 servers check each bound account hourly. After 24 hours without a
successful refresh, the server revokes the account's sign-in sessions. A
provider outage and a refusal can produce the same response. An Owner can
remove someone immediately.

## Public J5 Connect

The public deployment is planned for `connect.j5.codes` on a dedicated US
VPS with about 2 vCPU and 4 GB RAM, provisioned and paid for by the service
owner. Back up its Postgres data. The push relay will share that host. When
the gateway is added, server addresses will use wildcard DNS and a
wildcard certificate obtained through the DNS provider. Sign-up will begin
with an allow-list. For a person who leaves while their GitHub or Google
account remains active, a J5 server Owner removes their access.

## Test sign-in and offboarding locally

Run these commands in Bash with Docker Compose, Python 3 and curl.
This profile binds the two identity providers to loopback and uses an
invented upstream account. If either port is in use, set
`J5_CONNECT_TEST_HTTPS_PORT` or `J5_CONNECT_TEST_UPSTREAM_PORT` before
starting the stack.

```bash
compose=(docker compose -f compose.yaml -f compose.test.yaml --profile test -p j5-connect-test)
"${compose[@]}" up --build --wait
python3 test/offboarding.py "${compose[@]}"
"${compose[@]}" down --volumes
```

The test trusts the local Caddy CA, signs in to the upstream Dex, exchanges
the authorization code with PKCE, and refreshes the token. It deletes the
fixture account from the upstream password store while keeping both
providers running, then checks that Connect refuses the next refresh.
The test output redacts all tokens. The refusal is the input to the J5
server's 24-hour rule.

To provision the fixture account for manual sign-in, use the same test
project and run the following after it starts. The account is
`ada@example.test` with password `fixture-password`.

```bash
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U connect -d upstream \
  < test/upstream-user.sql
"${compose[@]}" exec -T connect cat /data/caddy/pki/authorities/local/root.crt \
  > /tmp/j5-connect-test-root.crt
```

Trust that CA in the test browser. The fixture's client is `j5-fixture`,
with secret `fixture-j5-secret` and callback `http://localhost/callback`.
Connect is at `https://localhost:8443` with the default port.
