# Dogfood runtime: self-hosted J5 Code server and clients

How Jackson's solo dogfood (phase 3 of [dogfood v0](worklog/dogfood-v0.md)) actually runs: one
source-built J5 Code server on a Linux box, reached over Tailscale, with the browser as the client.
This document is self-contained on purpose — dogfood agents have no access to the design sessions
that produced it. Decisions and their load-bearing reasons are recorded inline.

## Shape and rationale

- **One server, one Squadron.** A Squadron lives entirely on one server by design, so the dogfood
  fleet is single-server. The Linux box is that server.
- **The browser is the dogfood client.** The server serves its own web bundle, built from the same
  commit as the server itself (`apps/server/src/config.ts` resolves `dist/client`, the HTTP
  catch-all serves it with SPA fallback). A browser pointed at the server therefore has zero
  client/server version skew, and updating the server updates the UI atomically — reload the tab.
  The packaged desktop app is deliberately **not** the dogfood client: its UI is frozen at package
  time, and there is no client/server version handshake anywhere in the protocol. Under skew, a new
  variant in the orchestration event unions kills the affected subscription fiber silently, and a
  non-additive `ServerConfig` change prevents connecting at all. The browser path makes that entire
  class of failure unreachable.
- **Updates are manual, from source, at moments Jackson chooses.** Merges land on `j5/main` daily;
  an auto-deploy would restart the server — cancelling in-flight agent turns — at times nobody
  chose, on commits nobody watched boot. "Get latest and restart" via one script is the whole
  mechanism. No tagged checkpoints, no artifact pipeline.
- **Every update snapshots the database first.** Both migration lanes (upstream's and J5's) are
  forward-only with no downgrade guard — an older server binary starts silently against a
  newer-migrated database and fails later at query time. The only reliable rollback is
  previous-commit + restored snapshot, so the snapshot is not optional.
- **Restarts are survivable but not gentle.** On shutdown the server terminates provider
  subprocesses; on boot, recovery cancels every nonterminal run with the visible detail "Cancelled
  because the server restarted before the provider work completed." Nothing resumes. But nothing is
  lost either: checkpoint captures replay, and A2A delivery is a durable SQL queue drained at boot
  with idempotent retries. **A restart costs in-flight turns, never ledger messages or
  obligations.** Operating discipline: prefer updating when the fleet is quiet; restarting under
  load is acceptable when needed.
- **Managed like the box's other services.** The box already runs upstream T3 as an
  Ansible-reconciled per-user systemd service with an exact-version pin. J5 mirrors that template —
  dedicated service user, per-user unit, Ansible owns reconciliation — with one difference: the
  "pinned version" is a git checkout of `j5/main` instead of an npm package, because upstream's
  npm-based service updater cannot track a git branch.

## Deployment parameters

Defaults used throughout this document. All are adjustable; keep Ansible and this table in
agreement.

| Parameter        | Value                                   | Notes                                                        |
| ---------------- | --------------------------------------- | ------------------------------------------------------------ |
| Service user     | `j5dev`                                 | Non-sudo, lingering enabled, mirrors `t3dev`                 |
| Checkout         | `/home/j5dev/j5code`                    | Deploy-only clone of `j5/main`; never edited in place        |
| Development      | `/home/j5dev/src/j5code`                | Separate clone for agent work and development worktrees     |
| State dir        | `/home/j5dev/.j5code`                   | Set explicitly — see warning below                           |
| Listener         | `127.0.0.1:5773`                        | Loopback only; the existing T3 service keeps `3773`          |
| Tailnet exposure | Tailscale Serve HTTPS 8444 → 5773       | Applied by root via Ansible, not by the unit; 443/8443 taken |
| Unit             | `~/.config/systemd/user/j5code.service` | Journald logging (`journalctl --user -u j5code`)             |

> **Belt-and-braces state-dir check.** The J5 server now defaults to `~/.j5code`, separate from
> the real T3 install at `~/.t3`. The unit and commands below still set `J5CODE_HOME=$HOME/.j5code`
> explicitly so the intended location remains visible and safe if an older binary, wrapper, or
> future launch path bypasses the built-in default.

## One-time box setup

As `j5dev` (Ansible reconciles all of this):

1. **Toolchain.** `git`, `gh`, `sqlite3`, `build-essential`, `python3`, `fnm`, and via fnm the Node
   version in the checkout's `.nvmrc` (currently 24.14.0). Install the pnpm version from the repo's
   `packageManager` field under that
   Node; the server's Node distribution has no Corepack executable. Rust is **not** required —
   it is only used for desktop packaging. Codex CLI **≥ 0.151.0** is required: the server refuses an older app-server
   with a named turn failure instead of decoding its responses. The C/C++ toolchain and Python
   support native dependency builds; `gh` supports repository and pull-request work.
2. **Checkout and first build.**

   ```sh
   git clone --branch j5/main https://github.com/Jacksondr5/j5code.git ~/j5code
   cd ~/j5code
   fnm install
   package_manager="$(fnm exec --using "$(cat .nvmrc)" node -p 'require("./package.json").packageManager.split("+")[0]')"
   fnm exec --using "$(cat .nvmrc)" npm install --global "$package_manager"
   fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
   fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build
   ```

   The `t3` build task builds the web bundle first and copies it into
   `apps/server/dist/client` — that copy is what makes the served UI version-matched. If the build
   ever warns `Web dist not found — skipping client bundle`, the server will answer HTTP 503
   instead of serving the app; rebuild rather than start it.

   Keep agent work in a second clone so edits, branch switches, and development builds cannot
   replace the running server's files:

   ```sh
   mkdir -p ~/src
   git clone --branch j5/main https://github.com/Jacksondr5/j5code.git ~/src/j5code
   git -C ~/src/j5code remote add upstream https://github.com/pingdotgg/t3code.git
   ```

   Select `~/src/j5code` when creating the J5 development Squadron. Other initiatives get their
   own clones under `~/src`. Development servers use their worktrees' isolated homes.

3. **Unit.** `~/.config/systemd/user/j5code.service`:

   ```ini
   [Unit]
   Description=J5 Code dogfood server (source checkout)

   [Service]
   Type=simple
   WorkingDirectory=%h/j5code
   Environment=J5CODE_HOME=%h/.j5code
   ExecStart=/usr/bin/env bash -lc 'exec node apps/server/dist/bin.mjs serve --port 5773 --host 127.0.0.1'
   Restart=always
   RestartSec=5
   KillMode=mixed
   OOMPolicy=continue

   [Install]
   WantedBy=default.target
   ```

   Ansible configures `.profile` to prepend the checkout-pinned fnm Node installation's `bin`
   directory to PATH. The login shell resolves that Node, then `exec` makes Node systemd's main
   process so SIGTERM reaches the server for graceful shutdown. Keep that PATH aligned when the
   checkout's Node pin changes; verify the executable behind the unit's `MainPID` after startup.
   `serve` runs headless: no browser launch, no auto-bootstrap of a project from the working
   directory.

   The unit deliberately does **not** use the server's built-in `--tailscale-serve` flags: applying
   Serve config requires root or the machine's single Tailscale operator slot, and `j5dev` stays
   fully unprivileged. Tailnet exposure is a root-owned step instead (below).

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now j5code.service
   loginctl enable-linger j5dev   # once, if not already lingering
   ```

4. **Nightly snapshot timer.** `~/.config/systemd/user/j5code-snapshot.service` and `.timer`:

   ```ini
   # j5code-snapshot.service
   [Unit]
   Description=Nightly J5 Code dogfood database snapshot

   [Service]
   Type=oneshot
   ExecStart=%h/j5code/scripts/j5/dogfood-snapshot.sh nightly
   ```

   ```ini
   # j5code-snapshot.timer
   [Unit]
   Description=Run the J5 Code dogfood snapshot nightly

   [Timer]
   OnCalendar=daily
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now j5code-snapshot.timer
   ```

5. **Tailnet exposure (as root, not `j5dev`).** One Serve mapping on the node's existing
   tailscaled, alongside the T3 mapping — Serve config is a per-port map, so both coexist on one
   instance:

   ```sh
   ufw allow in on tailscale0 to any port 8444 proto tcp
   tailscale serve --bg --https=8444 http://127.0.0.1:5773
   ```

   In practice the homelab Ansible playbook owns this (with drift guards that refuse Serve entries
   outside the sanctioned T3 + J5 set); the commands above are what it converges to.

   **Tailnet policy is a separate prerequisite.** Add a grant from Jackson's identity to the
   server's tag for TCP 8444, retaining the existing T3 grant for 8443 and SSH access. Add policy
   tests accepting 8443 and 8444 while denying direct backend ports 3773 and 5773. The server
   remains bound to loopback; only its HTTPS proxy should be reachable remotely. Verify HTTPS
   from a second tailnet device: working Serve configuration and a successful request on the
   server itself do not prove that tailnet policy admits the client.

6. **Pairing.** Headless serve prints pairing details after startup — read them with
   `journalctl --user -u j5code -e`. The startup token carries admin scopes, and its link uses the
   loopback origin. For a fresh standard-scope client token with the private HTTPS origin already
   included, run:

   ```sh
   cd ~/j5code
   J5CODE_HOME=$HOME/.j5code fnm exec --using "$(cat .nvmrc)" \
     node apps/server/dist/bin.mjs auth pairing create \
     --base-url 'https://<box-tailnet-name>:8444' --ttl 1h --json
   ```

   Substitute the actual tailnet hostname, then open the returned pairing URL on the client
   before the token expires. If using a startup admin link instead, replace only its loopback
   origin with the private HTTPS origin, preserving `/pair#token=...`. Do not run `pair --tailscale`
   as `j5dev`; Ansible owns the Serve mapping. Token issuance alone does not verify client access.

7. **Provider CLIs and accounts.** Ansible installs pinned Codex and Claude CLIs globally under
   fnm's Node and adds its `bin` directory to the service account's PATH. Claude Fable 5.1 requires
   Claude CLI **≥ 2.1.257**. Authenticate as `j5dev`, the same account that runs provider turns;
   a login under `t3dev` or the SSH administrator does not authenticate J5's providers.

   ```sh
   codex --version
   claude --version
   codex login
   claude auth login
   codex login status
   claude auth status
   ```

   Complete the CLI login instructions from an interactive SSH session. Keep their credentials
   in `j5dev`'s own home; do not symlink T3's provider state. Check provider readiness in J5 and
   complete one real turn with each provider before treating the environment as ready for work.

## Connecting the client

Open the full private HTTPS pairing link above in a browser on any tailnet device; the browser
stores the session at `https://<box-tailnet-name>:8444`. For an app-like feel, install
the tab as a PWA/app shortcut — it is still the server-served, always-version-matched bundle.

After a server update, reload the tab. If the session is ever rejected after an update, re-pair
with a fresh token from `auth pairing create` above.

The ad-hoc-signed macOS desktop app (see [macos-packaging.md](macos-packaging.md)) remains a
packaging capability, not the dogfood client. If it is ever pointed at this server as a saved
remote environment, expect a persistent version-mismatch banner and the skew hazards described
under "Shape and rationale". Re-enabling its update feed is a known, config-only option
(`T3CODE_DESKTOP_UPDATE_REPOSITORY` at package time) deliberately not exercised for dogfood.

## Updating the server

When ready to pick up merged work — preferably while the fleet is quiet:

```sh
cd ~/j5code
./scripts/j5/dogfood-update.sh
```

The script, in order: prints the current commit (the rollback target), snapshots the database via
`VACUUM INTO` (safe while the server runs), fast-forwards `j5/main`, installs that commit's Node
and pnpm versions, reinstalls dependencies with the frozen lockfile, rebuilds server + web bundle,
restarts the unit, and waits until the server answers on the loopback port. Build happens before
restart, so downtime is the restart itself.

What everyone sees at restart: in-flight agent turns end as "Cancelled because the server
restarted before the provider work completed"; queued A2A deliveries drain on boot; nothing else
changes. Agents mid-task should simply be re-prompted to continue.

## Rollback

For when an update leaves the server broken or misbehaving. Deliberately manual — it should be
rare, and each step is a decision point.

```sh
systemctl --user stop j5code.service
cd ~/j5code
git checkout <previous-commit>        # printed by the update script; also in the snapshot dir name
fnm install "$(cat .nvmrc)"
package_manager="$(fnm exec --using "$(cat .nvmrc)" node -p 'require("./package.json").packageManager.split("+")[0]')"
fnm exec --using "$(cat .nvmrc)" npm install --global "$package_manager"
fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build
rm -f ~/.j5code/userdata/state.sqlite ~/.j5code/userdata/state.sqlite-wal ~/.j5code/userdata/state.sqlite-shm
cp ~/.j5code/db-snapshots/<pre-update-snapshot>/state.sqlite ~/.j5code/userdata/state.sqlite
systemctl --user start j5code.service
```

Restoring the snapshot is required whenever the bad version ran migrations, and safe otherwise —
when in doubt, restore. Ledger writes made between the snapshot and the rollback are lost; that is
the accepted cost, which is why updates happen at quiet moments. If the bad version never actually
started (build failure), skip the restore and just rebuild at the previous commit.

## Backups

Interim story until the client-pulled backup design lands: the nightly snapshot timer plus the
pre-update snapshots, both under `~/.j5code/db-snapshots/` with a retention cap enforced by the
snapshot script. Snapshots cover `state.sqlite` only — `secrets/` and `settings.json` change
rarely; copy them by hand after changing them. Off-box copies follow whatever backup regime the
box already has; the snapshot directory is the thing to include in it.
