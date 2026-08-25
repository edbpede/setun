# Setun — operator guide

Everything needed to run a Setun installation: what the three operator files are, what the two
hostnames are for, how provider accounts are enrolled, how an educator password is recovered,
how a backup is restored, and what to check when the pinned gateway version moves.

This guide is operational. `docs/setun-prd.md` says what the system does and why; section
references like (§21) point there.

---

## 1. What is deployed

Three containers, one database file (PRD §6):

| Service | What it is | Reachable from |
| --- | --- | --- |
| `app` | The SvelteKit application — student UI, educator panel, all server logic | Caddy only |
| `cpa` | CLIProxyAPI, the model gateway, unmodified and pinned | the app only, over the internal network |
| `caddy` | A plain reverse proxy terminating TLS for both hostnames | the internet |

The browser reaches only Caddy. Caddy reaches the app and the static sandbox files. **CPA has
no published port and no management API** — it is unreachable from the host and from the
internet, which is the requirement of §9 and §21, not a hardening extra.

Four volumes: `db` (the SQLite file), `storage` (attachments and generated images, outside any
web root), `backups` (nightly snapshots), and `cpa-auth` (provider tokens, CPA's own).

---

## 2. The three operator files

Nothing else needs editing to run an installation.

### `docker-compose.yml`

Service definitions, volumes and networks. Edit it only to change ports or image versions; the
values an installation differs by all come from `.env`.

### `.env`

Copy `.env.example` and fill **every** variable. The application validates its environment
before the listener starts and fails with every missing variable listed at once — a Setun that
starts is a Setun that is configured (§6.2).

The two that deserve a note:

- `SETUN_STUDENT_CODE_PEPPER` — the key the access-code digests are computed under. High
  entropy, secret, and **permanent**: changing it invalidates every access code that has ever
  been issued, and there is no migration path, because plaintext codes are never stored (§7).
- `SETUN_CPA_LISTENER_KEY` — must equal the value under `api-keys:` in `cpa/config.yaml`. It
  is the only thing authenticating the gateway.

### `mcp.json`

The MCP servers this installation offers (§11). Copy `mcp.example.json`, edit, and mount it —
the Compose file already mounts `./mcp.json` read-only at `/config/mcp.json`.

An endpoint is a security decision, so it lives in reviewable configuration rather than in the
database or the panel. Credentials are referenced **by the name of an environment variable**,
never by value: add the variable to `.env` and to the `app` service's `environment:` block, and
name it in `mcp.json`. The panel switches configured servers on, chooses which of their tools a
class may use, and marks the ones that must ask before they run. It cannot add a server.

A deployment that offers no tools keeps the file with an empty `servers` object, or leaves
`SETUN_MCP_CONFIG_PATH` unset. A classroom with no tools is a valid installation.

---

## 3. The two hostnames

Setun needs **two DNS names pointing at the same host** (§6.2, §14):

| Variable | Example | Serves |
| --- | --- | --- |
| `SETUN_APP_HOSTNAME` | `setun.school.dk` | the application: everything authenticated |
| `SETUN_SANDBOX_HOSTNAME` | `artefakter.setun.school.dk` | the artifact sandbox: static files only |

They must be **different hosts**, not different paths. Origin separation is the entire artifact
isolation mechanism: student-generated code runs on the sandbox origin, in an iframe sandboxed
without `allow-same-origin`, under a policy that denies outbound network access. A session
cookie set on the application host is unreadable there, and the sandbox proxies nothing, so
generated code has no route back into the authenticated application (§14, §21).

`SETUN_APP_ORIGIN` and `SETUN_SANDBOX_ORIGIN` are the same two names with a scheme, and the
application reads those.

### TLS

The `Caddyfile` uses automatic HTTPS via ACME. Set `SETUN_ACME_EMAIL` and make sure both names
resolve publicly and ports 80 and 443 reach the host.

On a closed network — a school with no public DNS — replace the `tls` behaviour in each site
block with Caddy's internal CA:

```caddyfile
{$SETUN_APP_HOSTNAME} {
	tls internal
	encode zstd gzip
	reverse_proxy app:3000
}
```

Then distribute Caddy's root certificate to the Chromebooks through the school's device
management. Session cookies are marked `Secure` when the request arrives over HTTPS, so a plain
HTTP deployment is not supported.

---

## 4. Provider enrolment

Provider accounts are enrolled **on the host, in CPA**, never in Setun (§9). Setun holds no
provider credential, and none reaches the browser or the database.

1. Copy `cpa/config.example.yaml` to `cpa/config.yaml`.
2. Put the `.env` listener key under `api-keys:`.
3. Add API-key providers directly in that file, following CPA's own documentation
   (<https://github.com/router-for-me/CLIProxyAPI>).
4. For subscription providers that use OAuth, run CPA's login flow inside the container:

   ```sh
   docker compose exec cpa /CLIProxyAPI/cli-proxy-api --login
   ```

   The resulting tokens live in the `cpa-auth` volume and are backed up by nobody but you —
   they are not part of Setun's snapshot, because they are not Setun's data. Re-running the
   login flow is how they are replaced.

Three settings in `cpa/config.yaml` are not preferences and should not be changed:
`remote-management.secret-key` empty (the management routes then do not exist at all),
`debug: false` (debug logging carries prompt content), and `plugins.enabled: false`.

Setun's model aliases are configured in the educator panel under **Models**: a friendly name a
pupil sees, the gateway model identifier CPA knows, the dialect, and the flags — availability,
data-protection, image input, image generation, prices, utility designation. The panel's
dashboard shows whether the gateway is answering and how many models it reports.

---

## 5. Educator password recovery

There is no in-application password reset, by design (§7). The educator account is seeded from
deployment configuration, and re-seeding it is the recovery path:

1. Change `SETUN_EDUCATOR_SEED_USERNAME` and `SETUN_EDUCATOR_SEED_PASSWORD` in `.env`.
2. `docker compose up -d app`

The seed runs on **every** boot, not only the first, precisely so this works. The username in
the file is the account; changing the password in the file and restarting sets it.

Student access codes are not recoverable by anyone, including you. A pupil who has lost a card
gets a new code from the panel's roster (**New code**), which invalidates their old code and
signs them out of every session immediately.

---

## 6. Backups and restore

The application takes a snapshot itself — there is no cron container and no host script (§6).
Nightly, after 03:00 in the classroom timezone, the job writes to the `backups` volume:

- `setun-YYYY-MM-DD.sqlite` — the database, via SQLite's `VACUUM INTO` online backup. A plain
  file copy of a WAL-mode database is not safe; this is.
- `storage-YYYY-MM-DD/` — a copy of the storage tree: attachments and generated images.

Both halves are written under a `.partial` name and renamed into place, so a name without that
suffix is a finished snapshot. A night counts as taken only when both halves are there: a run
that dies after the database half is written takes the storage half on the next hourly tick.
Never restore from a `.partial` name — it is a snapshot that was still being written.

The storage volume and the backups volume must be separate trees; the job refuses to run if one
contains the other, rather than copying a directory into itself every night.

The last **14 days** are retained (Appendix A); older snapshots are pruned by the day in their
name, `.partial` leftovers included. Files the job did not write are never touched, so the
volume is safe to keep notes in.

Skill bodies and their bundled resources are database columns, so they travel in the snapshot.
CPA's provider tokens are not Setun's data and are not included; see §4 above.

### Restoring

```sh
docker compose stop app

# Pick a day, and put both halves back where they came from.
docker compose run --rm \
  -v setun_db:/restore/db -v setun_storage:/restore/storage -v setun_backups:/backups \
  --entrypoint sh app -c '
    cp /backups/setun-2026-08-25.sqlite /restore/db/setun.sqlite &&
    rm -rf /restore/storage/* &&
    cp -a /backups/storage-2026-08-25/. /restore/storage/'

docker compose start app
```

Two things to know. The database file is replaced, not merged — anything written after the
snapshot is gone, which is what restoring means. And the WAL and shared-memory sidecars of the
old file (`setun.sqlite-wal`, `setun.sqlite-shm`) must not survive the copy; a snapshot is a
complete database and an old WAL beside it is corruption. `docker compose stop app` before
copying is what makes sure they are checkpointed and closed.

Migrations are applied at boot, so restoring a snapshot from an older release into a newer
image upgrades it on the next start.

### Rehearsal

**Performed and passing.** The procedure above was exercised end to end against a real database
and storage tree: a classroom, a provisioned pupil, a conversation and a stored image were
created, the nightly job ran, the database file and the storage tree were deleted, and both
were restored from the snapshot. After the restore the classroom, the pupil, the conversation's
full-text search index and the stored image bytes were all present and correct.

The invariants that rehearsal establishes are asserted continuously in
`src/lib/server/jobs/backup.test.ts`: the snapshot is a database another connection can open,
the storage tree travels with it, one snapshot is taken a night however often the job ticks,
a night left half-written is finished on the next tick, and the fourteen-day window is applied
by name rather than by file timestamp.

Re-run the rehearsal after any change to the storage layout or the volume mapping. §21 requires
that backups "have been restored successfully at least once" — for *this* installation.

---

## 7. Upgrading

### Setun

```sh
git pull
docker compose build app
docker compose up -d app
```

Migrations run at boot, before the listener accepts anything, so there is no separate migration
step and no window where a request can observe a half-migrated schema. Take a snapshot first if
the release notes mention a schema change: run the job by restarting the app after 03:00, or
simply copy the current `setun-*.sqlite` aside.

### CLIProxyAPI

The image is **pinned** in `docker-compose.yml` (`eceasy/cli-proxy-api:v7.2.140`) and CPA's
self-update is off. This is deliberate: the gateway is the one component with credentials for
every provider, and an unattended update of it is an unattended change to that.

To move it:

1. Read the upstream changelog at <https://github.com/router-for-me/CLIProxyAPI/releases>,
   specifically for changes to the OpenAI-compatible and Anthropic-compatible endpoints, to
   streaming, and to the `api-keys` listener authentication.
2. Change the tag in `docker-compose.yml`.
3. `docker compose up -d cpa`
4. Check the panel dashboard: the gateway line should report reachable with a plausible model
   count. Send one message in a test classroom in each dialect an alias uses.

Setun talks to CPA over HTTP alone and knows two dialects; the adapter is the only module that
knows either. If an upgrade changes an event shape, the failure appears there and nowhere else.

---

## 8. Day-to-day

- **Logs.** `docker compose logs -f app`. At normal levels they carry internal identifiers,
  model aliases, latency, status and token counts — never prompt or response content, and never
  a credential (§16). Job lines are counts only.
- **Retention.** Conversations expire on each classroom's policy (30 days by default), enforced
  by the app's own hourly pass. Creations — artifacts and generated images — are kept until
  deleted unless a classroom sets a creations period: the gallery is the pupil's portfolio (§16).
- **Disk.** The database is one file and grows slowly; `storage` grows with attachments and
  generated images; `backups` holds 14 days of both.
- **Reading pupils' conversations.** There is no interface for it, deliberately (§16). The
  educator's instruments are the layered system prompt, the model allowlist, and classroom
  availability.
