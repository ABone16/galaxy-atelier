# Galaxy Atelier

An account-isolated web image-generation agent with a DSH-inspired conversation flow. The server translates a user's request with a configured LLM, invokes one configured image API, then returns the image as a session result.

## Requirements

- Node.js 24.9 or newer
- npm

## Local development

1. Copy `.env.example` to `.env`.
2. Set a unique `APP_ENCRYPTION_KEY` (64 hexadecimal characters) and initial administrator credentials.
3. Run `npm install` for first-time setup (`npm ci` after the lockfile is created).
4. Run `npm run dev`, then open `http://127.0.0.1:5173`.

The API listens on `127.0.0.1:4318`. The service environment provides default
API base URLs; administrators can override both compatible endpoints, provider
keys, model names, and usage prices in the protected management page. Keys and
overridden endpoints are encrypted at rest, and keys are never returned by the
API.

## Public release hygiene

- Keep `.env`, `data/`, `dist/`, `node_modules/`, database files, and logs out
  of public repositories. The project `.gitignore` covers these runtime and
  build artifacts.
- Start from `.env.example` and generate a new `APP_ENCRYPTION_KEY` for every
  deployment. Never copy a local `.env` into a release archive.
- Configure provider API keys through protected server-side settings or a
  deployment secret store. Do not place credentials in source files, tests,
  client code, screenshots, or issue reports.
- Before publishing, run `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run test:production`.

## Provider contract

Both configured providers use OpenAI-compatible endpoints:

- Translation: `POST {translation_base_url}/chat/completions`
- Image generation: `POST {image_base_url}/images/generations` for new images and `POST {image_base_url}/images/edits` when a reference image is attached

The image endpoint defaults to `gpt-image-2.6` and must return a base64 PNG in
`data[0].b64_json`. The server verifies the PNG signature and IHDR dimensions,
stores the actual dimensions and any `revised_prompt`, and records provider
usage when reported. It does not fetch remote image URLs or silently switch
models. Model IDs are configurable rather than hard-coded; provider testing
uses the compatible `/models` endpoint and exposes discovered IDs as suggestions.
The management page fetches model IDs automatically for saved providers and can
refresh them with the current unsaved endpoint and API key before saving.
The composer also supports `size: "auto"` for model-selected canvas sizing. If
translation is disabled while that option is selected, the server falls back to
the provider's supported landscape preset (`1536x1024`) before calling the
image provider.

For a follow-up request with translation enabled, the translation model
receives the current request, the same session's most recent successful user
description and translated prompt as text context, and the most recent
successful image as a multimodal edit target. The same image is forwarded to
the image provider's edit endpoint, so small changes such as replacing a
newspaper headline preserve the rest of the composition. If translation is
disabled, a follow-up remains a direct text-to-image request unless the user
explicitly attaches an image.
Users may attach one PNG, JPEG, or WebP image up to 10 MiB and choose whether
it is an edit target or a visual reference. The translation model receives the
attached image as an image URL content part, and the image provider receives it
as a data URL. If the request waits in the generation queue, its reference
image is encrypted with AES-256-GCM in SQLite and is deleted when the item is
consumed or removed. The reference image is never written to audit logs.
Reference-image requests use the source image's orientation; the requested
generation size is not sent to the edit endpoint.

While a generation is running, the composer exposes a stop action. The
session-scoped `POST /api/sessions/:id/cancel` endpoint aborts the in-flight
translation or image request, records `generation.cancel_requested` and
`generation.cancelled` audit events, removes any partially written image, and
keeps the original request available for retry. Cancellations are reported
separately from provider failures in usage and administrator statistics.
Each active generation also has a persisted `pending` assistant record, so a
session can be refreshed without losing its running state; unfinished records
are recovered as `server-restarted` failures on the next service start.
Each session has a FIFO queue of up to 12 waiting requests, persisted in
SQLite and isolated by account. Queue items can be removed or moved back into
the composer for editing. Stopping a generation parks the remaining queue;
the next submitted request appends at the tail and resumes it. Queue items
remain available after a service restart.

Sessions can be archived from the sidebar action menu and restored from the
archived-session filter. Archiving preserves messages, usage history, and
generated images; archived sessions are read-only until restored. A session
with an active generation cannot be archived.
The sidebar search matches session titles and prior conversation text within
the selected recent or archived view; each result remains scoped to the
signed-in account.
Message history uses a stable cursor page: `GET
/api/sessions/:id/messages?limit=50` returns `{ items, hasMore, nextCursor }`.
Pass `before=<nextCursor>` to load older messages. The cursor orders equal
timestamps by message ID, so prepending pages does not duplicate or reorder
conversation turns while a pending generation is being polled.

## Security boundary

- There is no public registration. The first administrator is bootstrapped from environment variables; administrators create and disable accounts.
- Passwords are scrypt-hashed. Browser sessions use HttpOnly, SameSite cookies; API keys are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`.
- Session and image queries are scoped to the authenticated user. Admin routes require the administrator role.
- Queue reads and mutations require ownership of both the account and session. Queue item consumption is committed with its pending generation record, preventing duplicate execution across tabs.
- The agent has one server-owned operation: translate a prompt, then request an image. It has no filesystem, shell, browser, plugin, or arbitrary URL tool.
- Reference images are signature-validated and forwarded only to the configured image provider. Queued references are encrypted at rest; only the operation mode and byte count are retained in generation history and audit logs.
- Persisted files are confined to `DATA_DIR`. Production should run as an unprivileged account with a private writable data directory, read-only application files, TLS, and outbound network rules limited to the configured model providers.

## Kali / Ubuntu deployment

Use Node.js 24.9 or newer and systemd 247 or newer. The included unit uses
`ProtectProc` and `ProcSubset`; on older systemd these hardening directives are
not available. Check `node --version`, `systemd --version`, and validate the
unit with `systemd-analyze verify` on the target. Build on the target Linux
system; do not copy Windows `node_modules`. For a first deployment, place the
source at `/opt/atelier-agent` and run:

The repository includes ready-to-copy templates at
`deploy/atelier-agent.service` and `deploy/atelier-agent.env.example`.

```sh
cd /opt/atelier-agent
npm ci
npm run typecheck
npm test
npm run build
npm run test:production
```

The production smoke test needs the build output. It starts the built service
with a temporary data directory and isolated fake provider credentials. A
child-process fetch mock allows only the expected translation and image
generation calls, verifies the embedded `AGENT.md` instructions, confirms
provider keys are not returned, checks usage, administrator statistics, and
audit records, and retrieves the generated PNG. It never contacts a real
provider.

Create a dedicated service account and private data directory:

```sh
sudo useradd --system --home /var/lib/atelier-agent --shell /usr/sbin/nologin atelier-agent
sudo install -d -o atelier-agent -g atelier-agent -m 700 /var/lib/atelier-agent
sudo install -d -m 700 /etc/atelier-agent
```

Create `/etc/atelier-agent/atelier-agent.env`, restrict it to root, and set
`NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=4318`,
`DATA_DIR=/var/lib/atelier-agent`, a 64-character `APP_ENCRYPTION_KEY`, and
the initial admin email and a password of at least 8 characters. Generate
the encryption key with `openssl rand -hex 32`. Keep the key stable: changing
it makes previously encrypted provider keys unreadable. Keep the initial
admin values in the file for the first service start.

Install the included systemd unit:

```sh
sudo install -o root -g root -m 644 deploy/atelier-agent.service /etc/systemd/system/atelier-agent.service
sudo systemd-analyze verify /etc/systemd/system/atelier-agent.service
```

Adjust `ExecStart` if Node.js is installed somewhere other than `/usr/bin/node`.
Then enable and check the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now atelier-agent
sudo systemctl status atelier-agent
sudo journalctl -u atelier-agent -n 100 --no-pager
```

Confirm the journal reports that the initial administrator was created. Then
remove `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from the environment
file and lock down its permissions:

```sh
sudo chown root:root /etc/atelier-agent/atelier-agent.env
sudo chmod 600 /etc/atelier-agent/atelier-agent.env
sudo systemctl restart atelier-agent
```

The app listens only on loopback by default. Put it behind a reverse proxy
that terminates TLS; do not expose port 4318 directly to the internet. Keep
the environment file root-readable only, back up `/var/lib/atelier-agent`,
and allow outbound connections only to the configured model providers where
your network policy permits.
#   g a l a x y - a t e l i e r  
 