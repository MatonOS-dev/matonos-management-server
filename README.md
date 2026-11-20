# MatonOS management server

Node 24 HTTP server for updates, F-Droid statistics, ratings, reviews, MatonOS accounts, and immutable release files. Account sessions use the pinned `jose`
library; configured mail uses the pinned `nodemailer` package. The OTA protocol serves update discovery and immutable release files. See [the OTA contract](../install/OTA-CONTRACT.md) for its endpoint schemas and behavior.

## Run

```sh
export MATON_SERVER_STORAGE_DIR=/srv/matonos-server/storage
export MATON_SERVER_CONFIG=/etc/matonos-server/channels.json
export MATON_SERVER_PORT=8080
export MATON_SERVER_HOST=127.0.0.1   # default; the server sits behind a reverse proxy
export MATON_SERVER_FDROID_DIR=/srv/matonos-server/fdroid   # optional: serves the MatonOS F-Droid repo at /fdroid/
node src/server.ts
```

Promote an immutable update by editing the channels configuration through the
guarded CLI. It rejects a lower Android base than the channel currently
serves:

```sh
MATON_SERVER_STORAGE_DIR=/srv/matonos-server/storage \
MATON_SERVER_CONFIG=/etc/matonos-server/channels.json \
node src/promote.ts testing 1795430400
```

Configuration paths are supplied by environment variables. Example:

```json
{
  "channels": {
    "testing": { "update_id": 1795430400 },
    "main": { "update_id": 1795430400 }
  }
}
```

## systemd user unit

```ini
[Unit]
Description=MatonOS management server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/matonos/repos/matonos-ota
Environment=MATON_SERVER_PORT=8080
Environment=MATON_SERVER_STORAGE_DIR=%h/matonos-server/storage
Environment=MATON_SERVER_CONFIG=%h/.config/matonos-server/channels.json
ExecStart=/usr/bin/node src/server.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Place this at `~/.config/systemd/user/matonos-management-server.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now matonos-management-server.service
```

Put TLS termination and the `/api` and `/storage` routes behind the deployment
proxy. API responses are `no-store`; immutable files may be cached for one
year. Forward `Range` and `If-Range` requests without rewriting them.

## Tests

```sh
npm test
python3 ../install/ota/test_ota.py
```

Node tests cover the APIs, account refresh rotation and revocation, downgrade filtering and promotion,
the required add-on gate, fixed EOL response, malformed requests, and byte ranges. The Python test
checks publisher output and compatibility with the native slot-writer
manifest verifier.

## Installer downloads

With `MATON_SERVER_DOWNLOAD_DIR` set, `/download/<file>` serves the flat files of that directory (no subdirectories,
byte ranges supported) as immutable. Name every file by update id, e.g. `matonos-<update_id>-x86_64.iso`
plus `.sha256`, and never replace a file in place.

## F-Droid repository

With `MATON_SERVER_FDROID_DIR` set, `/fdroid/<path>` serves that directory as plain files (byte ranges supported).
Index files under `repo/` (`entry.*`, `index*.{jar,json,xml,html}`, `diff/`) get `Cache-Control: public, max-age=60`;
everything else (APKs, icons) is versioned by name and cached as immutable. Cloudflare follows these headers.

## Ratings, reviews, and accounts

All store sources share the same ratings and review API. Anonymous stars are
posted to `POST /api/reviews/ratings` as `{ "app": "<app key>", "stars": 1 }`
and are deduplicated by the salted client-address hash. Batch summaries are
`GET /api/reviews/ratings?apps=a,b`; one summary is
`GET /api/reviews/ratings/<app>`. Written reviews require an account:
`POST /api/reviews/apps/<app>` accepts `{ "stars": 1, "title": "...",
"body": "..." }`; `GET` lists newest first, and `DELETE` removes the caller's
review. A review contributes its stars to the rating summary. App keys are
source neutral: the store uses `packageName || id`, normalizing a Flatpak ref
`app/<app-id>/<arch>/<branch>` to `<app-id>` so arch, branch, and repository do
not split the same app.

Accounts use `POST /api/account/register` and `/login`, `POST /logout`,
`GET /api/account` for the signed-in user's own username, e-mail, and
verification state, and `DELETE /api/account` with a password confirmation.
Access tokens are one-hour HS256 JWTs in the `maton_session` Secure, HttpOnly,
SameSite=Strict cookie. Login also returns a random month-long refresh token in
JSON and the `maton_refresh` Secure, HttpOnly, SameSite=Strict cookie scoped to
`/api/account/refresh`. The refresh token is stored only as SHA-256 in the
device row and rotates on every refresh while keeping that device’s `jti`. A
reused previous refresh token revokes the device. A device that refreshes at
least once every 30 days stays signed in. Device `last_refreshed` is shown as
last active. Each session is bound to the machine id sent in
`X-Maton-Machine-Id`; account devices can be listed with
`GET /api/account/devices` and revoked with `DELETE /api/account/devices/<id>`.
Login failures use per-IP-hash and per-account exponential backoff. Usernames
are case insensitive for uniqueness; e-mail is private and appears only in
the authenticated account response.

Verification and password-reset mail use `MATON_SERVER_SMTP_URL` and `MATON_SERVER_MAIL_FROM`.
Without both variables, reset requests return `503 mail_not_configured` and
accounts remain usable but unverified. Reset and verification tokens are
single-use and expire after one hour. Review text rejects URLs, e-mail
addresses, and blank reviews. The previous CC BY 4.0 multilingual word list
was removed because it is incompatible with GPL-2.0-only; review word
filtering is currently omitted.

## Third-party

| Component or data | License |
| --- | --- |
| `jose` 6.2.18 (runtime) | MIT |
| `nodemailer` 10.6.0 (runtime) | MIT-0 |
| Bundled data files | None |
| LDNOOBW multilingual word list (removed) | CC BY 4.0; incompatible with GPL-2.0-only, no longer distributed |
| Node.js 24 runtime and built-in test modules | MIT |

The runtime dependency graph is fully represented by these two entries in `package-lock.json`; both licenses are GPLv2-compatible.

## License

This repository is licensed under GPL-2.0-only; see [`LICENSE`](LICENSE).

## F-Droid statistics

The F-Droid plugin reports successful installs to `POST /api/fdroid/install`
when its `share_stats` setting is enabled. Downloads deduplicate by app and a
salted SHA-256 hash of the client address. `GET /api/fdroid/stats` returns
all apps' download counts; `GET /api/fdroid/stats/<packageName>` returns one.
Responses use an ETag and one-hour public cache lifetime. Bodies are limited
to 64 KiB and event requests are limited to 60/minute per hashed address.

All account, session-device, reset-token, rate-limit, review, anonymous-rating,
and F-Droid download data live in `MATON_SERVER_STORAGE_DIR/maton.db`, using Node's
built-in SQLite with WAL and foreign keys enabled. The database schema version
is `PRAGMA user_version`; ordered migrations are applied in one transaction.
The server sets umask 077 and keeps the database, WAL, SHM, JWT secret, and
backups mode 0600. The random 32-byte anonymous identity salt remains in
`fdroid-stats.salt` at mode 0600. The JWT signing key is generated on first
start as `jwt.secret` and never belongs in the repository or logs. Back up the
database with SQLite's online backup command:

```sh
sqlite3 /srv/matonos-server/storage/maton.db '.backup /srv/matonos-server/backups/maton.db'
chmod 0600 /srv/matonos-server/backups/maton.db
```

Keep `jwt.secret` and `fdroid-stats.salt` with the database backup. No raw IP
address or machine id is persisted.
