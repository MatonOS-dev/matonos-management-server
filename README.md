# MatonOS OTA API server

Node 24 HTTP server for update discovery, MatonOS accounts, ratings and
reviews, and immutable release files. Account sessions use the pinned `jose`
library; configured mail uses the pinned `nodemailer` package. See [the OTA contract](../install/OTA-CONTRACT.md)
for complete endpoint schemas and behavior.

## Run

```sh
export OTA_STORAGE_DIR=/srv/matonos-ota/storage
export OTA_CONFIG=/etc/matonos-ota/channels.json
export OTA_PORT=8080
export OTA_HOST=127.0.0.1   # default; the server sits behind a reverse proxy
export OTA_FDROID_DIR=/srv/matonos-ota/fdroid   # optional: serves the MatonOS F-Droid repo at /fdroid/
node src/server.ts
```

Promote an immutable update by editing the channels configuration through the
guarded CLI. It rejects a lower Android base than the channel currently
serves:

```sh
OTA_STORAGE_DIR=/srv/matonos-ota/storage \
OTA_CONFIG=/etc/matonos-ota/channels.json \
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
Description=MatonOS OTA API server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/matonos/ota-server
Environment=OTA_PORT=8080
Environment=OTA_STORAGE_DIR=%h/matonos-ota/storage
Environment=OTA_CONFIG=%h/.config/matonos-ota/channels.json
ExecStart=/usr/bin/node src/server.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Place this at `~/.config/systemd/user/matonos-ota.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now matonos-ota.service
```

Put TLS termination and the `/api` and `/storage` routes behind the deployment
proxy. API responses are `no-store`; immutable files may be cached for one
year. Forward `Range` and `If-Range` requests without rewriting them.

## Tests

```sh
npm test
python3 ../install/ota/test_ota.py
```

Node tests cover all four API endpoints, downgrade filtering and promotion,
the required add-on gate, fixed EOL response, malformed requests, and byte ranges. The Python test
checks publisher output and compatibility with the native slot-writer
manifest verifier.

## Installer downloads

With `OTA_DOWNLOAD_DIR` set, `/download/<file>` serves the flat files of that directory (no subdirectories,
byte ranges supported) as immutable. Name every file by update id, e.g. `matonos-<update_id>-x86_64.iso`
plus `.sha256`, and never replace a file in place.

## F-Droid repository

With `OTA_FDROID_DIR` set, `/fdroid/<path>` serves that directory as plain files (byte ranges supported).
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
Sessions are 30-day HS256 JWTs in the `maton_session` Secure, HttpOnly,
SameSite=Strict cookie. Each session is bound to the machine id sent in
`X-Maton-Machine-Id`; account devices can be listed with
`GET /api/account/devices` and revoked with `DELETE /api/account/devices/<id>`.
Login failures use per-IP-hash and per-account exponential backoff. Usernames
are case insensitive for uniqueness; e-mail is private and appears only in
the authenticated account response.

Verification and password-reset mail use `OTA_SMTP_URL` and `OTA_MAIL_FROM`.
Without both variables, reset requests return `503 mail_not_configured` and
accounts remain usable but unverified. Reset and verification tokens are
single-use and expire after one hour. Written review text is checked against
the committed multilingual
[LDNOOBW word list](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words),
licensed CC BY 4.0; the source attribution and license are in `src/data/`.
The filter normalizes Unicode, diacritics, common leetspeak, repeated letters,
and separators; it also rejects URLs, e-mail addresses, and blank reviews.

## F-Droid statistics

The F-Droid plugin reports successful installs to `POST /api/fdroid/install`
when its `share_stats` setting is enabled. Downloads deduplicate by app and a
salted SHA-256 hash of the client address. `GET /api/fdroid/stats` returns
all apps' download counts; `GET /api/fdroid/stats/<packageName>` returns one.
Responses use an ETag and one-hour public cache lifetime. Bodies are limited
to 64 KiB and event requests are limited to 60/minute per hashed address.

All account, session-device, reset-token, rate-limit, review, anonymous-rating,
and F-Droid download data live in `OTA_STORAGE_DIR/maton.db`, using Node's
built-in SQLite with WAL and foreign keys enabled. The database schema version
is `PRAGMA user_version`; ordered migrations are applied in one transaction.
The server sets umask 077 and keeps the database, WAL, SHM, JWT secret, and
backups mode 0600. The random 32-byte anonymous identity salt remains in
`fdroid-stats.salt` at mode 0600. The JWT signing key is generated on first
start as `jwt.secret` and never belongs in the repository or logs. Back up the
database with SQLite's online backup command:

```sh
sqlite3 /srv/matonos-ota/storage/maton.db '.backup /srv/matonos-ota/backups/maton.db'
chmod 0600 /srv/matonos-ota/backups/maton.db
```

Keep `jwt.secret` and `fdroid-stats.salt` with the database backup. No raw IP
address or machine id is persisted.
