# J5 Connect

J5 Connect signs people in to your J5 servers through an identity provider you choose: your
company's (Entra ID, Okta or another OIDC provider), GitHub, or Google. It's one container,
running Dex and Caddy, plus Postgres for Dex's state. The J5 servers run separately, and each one
trusts the J5 Connect it joins. [People and sharing](people-and-sharing.md#signing-in-through-j5-connect)
says what signing in does on a server.

## Run your own J5 Connect

You need Docker with Compose 2.24.4 or later, and a DNS name pointing at the host. Caddy listens
on ports 80 and 443 and gets a certificate for that name from a public authority, so both ports
must be reachable from the internet; for a host that isn't, see
[An internal deployment](#an-internal-deployment). The Compose file and its images live in
`infra/j5-connect/` of the J5 Code repository, and each image is pinned by digest.

In `infra/j5-connect/`, create your settings file with only you able to read it:

```bash
install -m 600 .env.example .env
```

Then fill in these values:

- `J5_CONNECT_ISSUER` is the public HTTPS origin, such as `https://connect.example.com`, with no
  path and no trailing slash. It can't carry a port unless you remap Caddy's: Caddy listens on 443
  inside the container.
- `POSTGRES_PASSWORD` is a password you generate for the stack's Postgres.
- `J5_CONNECT_PROVIDER` is `oidc`, `github` or `google`.
- `J5_CONNECT_UPSTREAM_CLIENT_ID` and `J5_CONNECT_UPSTREAM_CLIENT_SECRET` are J5 Connect's own
  credentials at that provider. Register the issuer followed by `/callback` as that application's
  redirect URI.
- For `oidc` only, `J5_CONNECT_UPSTREAM_ISSUER` is the provider's issuer, exactly as its discovery
  document gives it, and must be HTTPS. `J5_CONNECT_OIDC_SCOPES` defaults to
  `profile email offline_access`; J5 Connect adds `openid`. `J5_CONNECT_OIDC_GET_USER_INFO` is
  `true` (the default) or `false`; leave it `true` so J5 Connect reads the person's details from
  the provider's UserInfo endpoint when a refresh brings no ID token.
- `J5_CONNECT_CLIENTS` lists the J5 servers that may sign people in, as a JSON array. Each entry
  has exactly `id`, `name`, `secret` and `redirectURIs`. Put the value in single quotes, so that a
  `$` in a secret stays as it is.

Keep the two named volumes across upgrades. Back up Postgres, which holds the signing keys and
everyone's sign-in state, and keep your `.env` and Caddy's data where you can recover them.

J5 Connect is configured so that a disabled account stops being confirmed. Keep its Dex settings as
the image sets them.

### Choose an identity provider

- **Entra ID, Okta and other OIDC providers:** choose `oidc`, and let your application request
  `offline_access` and receive refresh tokens. Entra's ID token has no `email_verified`, so for
  Entra set `J5_CONNECT_OIDC_SCOPES` to `profile offline_access`. Sign-ins then reach J5 without an
  email, and Owners see a name or username when they let someone in.
- **Google or Google Workspace:** choose `google`. For a Workspace-only J5 Connect, set the OAuth
  application's audience to your organization.
- **GitHub:** choose `github`, and register a GitHub OAuth app.

J5 servers know each account by the provider's issuer and the person's id there, never by email.
Changing the upstream issuer gives everyone a new account, which an Owner binds again.

GitHub and Google accounts outlive a job, and they can't tell J5 that someone left. With those,
an Owner removes the person on each server.

### An internal deployment

On a host the internet can't reach, give Caddy your own certificate. Write a Caddyfile that serves
`{$J5_CONNECT_HOST}` with `tls /certs/cert.pem /certs/key.pem`, or with `tls internal` for Caddy's
own authority. It can use only `{$J5_CONNECT_HOST}` and its own certificate paths; Caddy is given
no other settings. Mount it over `/opt/j5-connect/Caddyfile` with a read-only volume in your
Compose file, and mount your certificate files the same way.

Every J5 server that joins must trust that authority: start the server with `NODE_EXTRA_CA_CERTS`
set to its certificate. So must every browser and phone people sign in from.

## Join from a J5 server

A J5 server trusts one J5 Connect, and you register each server with it by hand. For a first
install:

1. On the J5 server, as an Owner, print the redirect URIs it needs:

   ```bash
   j5 auth connect redirect-uris
   ```

   There's one per address the server is reached at, each ending in
   `/api/j5/identity/callback`. Add `--address <url>` for an address the server can't find
   itself, such as an HTTPS name in front of it; repeat it for several.

2. Pick a client id for the server, and generate its secret with `openssl rand -base64 32`. Keep
   the secret in a file only you can read on the server, and give it to whoever runs J5 Connect.
3. On J5 Connect, add the server to `J5_CONNECT_CLIENTS` with that id, secret and redirect URIs,
   and start it with `docker compose up -d --build`. After a later change to the clients, run
   `docker compose up -d connect`.
4. On the J5 server, join:

   ```bash
   j5 auth connect join https://connect.example.com \
     --client-id j5-server --client-secret-file ./connect-client-secret
   ```

   Pass `-` as the file to read the secret from stdin. Joining checks the secret and every
   redirect URI first. If one is missing, it prints the full list and changes nothing.

An Owner can also join from **Settings → People → Sign-in**, with the same three values; it lists
the redirect URIs to register, including the address you opened J5 Code at when that server serves
the page. When a server gains an address,
add its redirect URI and join again. To stop trusting a J5 Connect, run `j5 auth connect leave`, or
choose **Leave** under **Sign-in**.

## How long access lasts

Each J5 server checks every signed-in account with J5 Connect every hour. Someone whose account
is disabled at your identity provider loses access within a day while J5 Connect is reachable, and
within 48 hours at worst. An outage doesn't sign anyone out until it has lasted a day; after
that, people sign in again once J5 Connect is back. Removing someone from a server cuts them off
at once.
