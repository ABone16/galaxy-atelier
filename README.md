<div align="center">
  <img src="docs/assets/galaxy-atelier-promo.jpg" alt="Galaxy Atelier - a self-hosted creative workspace">

  <h1>Galaxy Atelier</h1>
  <p><strong>A self-hosted workspace for model services, account-separated sessions, and image workflows.</strong></p>
  <p>
    <a href="README.zh.md">简体中文</a> ·
    <a href="#workspace-overview">Overview</a> ·
    <a href="#screenshots">Screenshots</a> ·
    <a href="#getting-started">Getting started</a> ·
    <a href="#ubuntu-deployment">Ubuntu deployment</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-24.9%2B-43853d?logo=node.js&logoColor=white" alt="Node.js 24.9 or newer">
    <img src="https://img.shields.io/badge/React-18-149eca?logo=react&logoColor=white" alt="React 18">
    <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/SQLite-built--in-003b57?logo=sqlite&logoColor=white" alt="SQLite">
  </p>
</div>

Galaxy Atelier is a self-hosted workspace for teams that need to manage model services, provision users, and keep each member's sessions and usage separate. Administrators configure the prompt and image APIs and oversee activity; members work in their own searchable sessions with prompt-model controls, image context, and persistent request queues.

The application is deliberately limited to this workflow. Its prompt model does not receive tools for controlling the host computer.

**Category:** Self-hosted image-workspace and service administration<br>
**Best for:** Individuals and small teams who want to manage accounts, choose compatible model APIs, and review their workspace activity on infrastructure they operate.

## Contents

- [Workspace Overview](#workspace-overview)
- [Screenshots](#screenshots)
- [Feature Guide](#feature-guide)
- [Image Workflow](#image-workflow)
- [Architecture](#architecture)
- [Security and Data Boundaries](#security-and-data-boundaries)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Provider Configuration](#provider-configuration)
- [Ubuntu Deployment](#ubuntu-deployment)
- [Operations and Backups](#operations-and-backups)
- [Development and Tests](#development-and-tests)
- [Repository Layout](#repository-layout)
- [Limitations](#limitations)

## Workspace Overview
<a id="preview-studio" href="docs/assets/ui-studio.png"><img src="docs/assets/ui-studio.png" alt="Image Studio with session navigation, prompt-model toggle, canvas sizing, and composer" width="100%"></a>
<p align="center"><strong>Image Studio and Prompt Model</strong><br>Session navigation, prompt-model on/off control, canvas sizing, and the conversation composer.</p>

| Area | What it provides |
| --- | --- |
| **Accounts and separation** | Admin-created accounts with member/admin roles; sessions, uploaded images, generated images, queues, and personal usage are scoped to the signed-in account. |
| **Prompt and image services** | Separate compatible API settings, editable endpoints and model IDs, model discovery, connectivity checks, configurable pricing, and editable prompt instructions. |
| **Sessions and Prompt Model** | Searchable conversations with optional prompt refinement, direct-to-image mode, edit/reference image context, model-selected canvas sizing, and a persistent queue. |
| **Operations and preferences** | Per-user usage, admin traffic and model analytics, exportable audit logs, English/Chinese language selection, and nine themes plus system appearance. |

The interface also supports English and Simplified Chinese, browser-language detection, nine named themes (four light and five dark), and a system-following appearance option.

For the complete capability register, code evidence, and the editorial decisions behind this README, see the [feature inventory](docs/FEATURE_INVENTORY.md).

<a id="screenshots"></a>
## Feature Screenshots

The screenshots are full-viewport captures from the running application using synthetic demo data. Compact previews keep the feature overview scannable; open any image to inspect the original full-size page.

<table>
  <tr>
    <td width="33.33%" valign="top">
      <a id="preview-language" href="docs/assets/ui-language.png"><img src="docs/assets/ui-language.png" alt="Language selector with English and Simplified Chinese options" width="100%"></a>
      <p align="center"><strong>Language selection</strong><br>Choose English or Simplified Chinese, or use automatic browser-language detection.</p>
    </td>
    <td width="33.33%" valign="top">
      <a id="preview-overview" href="docs/assets/ui-overview.png"><img src="docs/assets/ui-overview.png" alt="Administrator overview with traffic, usage and time-range controls" width="100%"></a>
      <p align="center"><strong>Administrator overview</strong><br>Service traffic, success, estimated cost, model usage, and period detail.</p>
    </td>
    <td width="33.33%" valign="top">
      <a id="preview-accounts" href="docs/assets/ui-accounts.png"><img src="docs/assets/ui-accounts.png" alt="Account management page with account creation, roles, status, and controls" width="100%"></a>
      <p align="center"><strong>Account management</strong><br>Provision accounts, set roles, disable access, reset passwords, or remove an account and its data.</p>
    </td>
  </tr>
  <tr>
    <td width="33.33%" valign="top">
      <a id="preview-usage" href="docs/assets/ui-account-usage.png"><img src="docs/assets/ui-account-usage.png" alt="Member usage page with request totals, model usage, and cost summary" width="100%"></a>
      <p align="center"><strong>Account-scoped usage</strong><br>Members see their own requests, model consumption, response time, and estimated cost.</p>
    </td>
    <td width="33.33%" valign="top">
      <a id="preview-audit" href="docs/assets/ui-audit.png"><img src="docs/assets/ui-audit.png" alt="Filtered audit log with event details and CSV export controls" width="100%"></a>
      <p align="center"><strong>Audit logs</strong><br>Filter operational events, inspect metadata, export matching rows, or delete entries.</p>
    </td>
    <td width="33.33%" valign="top">
      <a id="preview-themes" href="docs/assets/ui-themes.png"><img src="docs/assets/ui-themes.png" alt="Theme selector showing light, dark, and system-following options" width="100%"></a>
      <p align="center"><strong>Theme selection</strong><br>Nine named palettes, with an option to follow the operating system.</p>
    </td>
  </tr>
</table>

## Feature Guide

<a id="conversation-to-image"></a>
### Sessions and Requests

**Purpose:** Keep prompts, outputs, model feedback, and follow-up work organized by session.

Members can search sessions by title or message, rename, archive, restore, and permanently delete them. Conversation history loads in pages while preserving the reader's position. Each session can hold up to 12 pending requests; members can edit or remove queued items, or return one to the composer to change its options. The queue is persisted across service restarts.

The session shows user messages and uploaded images, request status, available model feedback, results, and failure details together. A first-turn prompt-model response can suggest a session title; returned image names are used for downloads when available. Users can stop an active request and retry failures.

**Screenshots:** [Image Studio](#preview-studio) · [Account-scoped usage](#preview-usage)

### Prompt Model and Image Context

The Prompt Model is optional on every request. When enabled, it turns a natural-language description into an English image prompt; administrators can edit its system instructions. When disabled, the user's text goes directly to the image API. The model is a prompt-preparation step, not a computer-control agent: it has no shell, filesystem, browser, plugin, or arbitrary URL-fetching tools.

Attached images can be treated as an edit target or a visual reference. Users can choose a file, drag and drop, or paste an image; supported inputs are normalized to PNG before submission. With prompt refinement enabled, the attached image can be included in the prompt-model request. A follow-up can reuse the latest successful prompt-refined image and prompt context as an edit target; without prompt refinement, attach an image explicitly.

Choose a model-decided, square, portrait, or landscape canvas size when the image workflow allows it. With a reference image, the output follows the input orientation. The session shows the actual output dimensions and available model feedback; images can be previewed in-app, downloaded, or used for a follow-up edit.

**Screenshot:** [Image Studio](#preview-studio)

<a id="workspace-operations"></a>
### Accounts and Data Separation

There is no public registration. Administrators create accounts, assign member or admin roles, enable or disable access, reset passwords, and delete accounts. A member's sessions, messages, queue items, images, and personal usage are isolated from other accounts. Deleting an account removes its associated workspace data.

Members can inspect their own request counts, success rate, response time, model usage, and estimated cost. Administrators can inspect service-wide activity and account-level breakdowns.

**Screenshots:** [Account management](#preview-accounts) · [Account-scoped usage](#preview-usage)

### Provider Configuration

Administrators configure the Prompt Model and image API separately. Each can have its own compatible API base URL, credential, model ID, and usage pricing. The **Models & keys** page can fetch a provider's model list, let the administrator select an available ID, and test connectivity. The Prompt Model's system instructions are editable; an empty custom value restores the bundled `AGENT.md` instructions. Saved credentials and endpoint overrides are encrypted at rest.

Model discovery only reports IDs returned by the provider; it does not guarantee that every listed model supports the image-generation contract the application needs. See [provider request requirements](#provider-configuration).

### Operations and Audit

The administrator overview reports requests, success rate, average response time, token usage, and estimated cost. Traffic can be grouped by minute, hour, day, or month, with account, model, request-mode, and failure breakdowns. Members see only their own usage page.

Administrators can filter audit logs by account, event, and outcome; load older entries; export matching records as CSV; or delete entries. Logs omit raw API keys and full prompts, but provider-configuration events may include configured base URLs.

**Screenshots:** [Operations overview](#preview-overview) · [Member usage](#preview-usage) · [Audit logs](#preview-audit)

<a id="interface-preferences"></a>
### Language and Themes

The interface supports English and Simplified Chinese. Browser language is detected automatically by default; a manual choice is remembered locally. Nine named themes are available (four light and five dark), alongside a system-following option.

**Screenshots:** [Theme selector](#preview-themes) · [Language selector](#preview-language)

## Image Workflow

1. Sign in to an account provisioned by the administrator and open an image session.
2. Describe the scene. Optionally attach a reference image and select edit or reference mode.
3. Choose whether to use prompt refinement and select an aspect-ratio preset or model-selected sizing.
4. If enabled, the configured language model receives the current request, the most recent successful prompt-refined turn's user prompt and refined prompt when available, and any attached image as multimodal input. When no image is attached, a follow-up can reuse that turn's image as its edit target. If prompt refinement is disabled, attach an image explicitly to provide image context.
5. The server sends a generation or edit request to the configured image API. When prompt refinement is disabled, the user's text goes directly to the image API; an explicitly attached reference is still forwarded for the selected image workflow.
6. The result, actual image dimensions, provider/model metadata, usage when reported, and generation status appear in the session. Failed requests retain the model's available text response for inspection.

The prompt model is not a source of hidden tool access. The application does not give it a shell, filesystem, browser, plugin, or arbitrary URL-fetching tool.

## Architecture

```text
Browser
  └─ React + TypeScript client
       └─ same-origin /api requests
            └─ Node.js HTTP service
                 ├─ SQLite: accounts, sessions, messages, queue, usage, audit
                 ├─ DATA_DIR/images: generated and retained edit images
                 ├─ configured OpenAI-compatible chat-completions endpoint
                 └─ configured OpenAI-compatible image endpoint
```

The frontend is built with Vite. The backend uses Node.js's built-in HTTP and SQLite APIs; there is no separate database server or provider SDK to install. In production the Node service serves the built frontend and API from one origin.

## Security and Data Boundaries

- There is no public registration. The first administrator is created from server environment variables; administrators provision subsequent accounts.
- Passwords are scrypt-hashed. Session cookies are `HttpOnly` and `SameSite`; production cookies also use `Secure`.
- Login is temporarily rate-limited after repeated failed attempts for the same email and client IP.
- Provider credentials and administrator-overridden endpoints are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY`. The key must remain stable for stored provider settings to remain decryptable. API responses do not return saved provider keys.
- Session, message, queue, image, and usage reads are scoped to the authenticated account. Administration routes require the administrator role.
- Uploaded reference images are signature-checked, bounded by size and dimensions, and sent only to the configured providers needed for the selected workflow. Queued references are encrypted in SQLite while waiting and removed when consumed or deleted; audit entries retain metadata rather than image bytes.
- Application files and the database are stored under `DATA_DIR`. The prompt model has no local machine-control capability.
- The included systemd service runs as a dedicated unprivileged user, restricts writable paths to the data directory, and enables operating-system hardening.

Self-hosting does not mean provider-free: when generation is requested, the prompt (and, where applicable, the reference image and conversation context) is transmitted to the provider endpoint configured by the administrator. Review that provider's data-handling terms and configure outbound network access accordingly.

## Requirements

- Node.js **24.9 or newer** (the project uses the built-in `node:sqlite` module).
- npm (bundled with Node.js).
- A compatible chat-completions API and image-generation API for real image creation.
- For Ubuntu service deployment: systemd **247 or newer** for every hardening directive used by the included unit.

## Getting Started

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/ABone16/galaxy-atelier.git
cd galaxy-atelier
npm ci
```

Create an environment file and generate a fresh encryption key:

```sh
cp .env.example .env
openssl rand -hex 32
```

Edit `.env`. Replace the example encryption key with the 64-character value you generated, set a unique initial administrator email and password, and set the provider base URLs if required. The example provider URLs are placeholders and are not working services.

Start the development client and API:

```sh
npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves the client; the API listens on `127.0.0.1:4318` by default. Sign in with the initial administrator credentials and configure both providers under **Models & keys**. The providers can be OpenAI-compatible services; the base URL, API key, and model ID are set by the administrator, and available models can be fetched from the provider's `/models` endpoint.

To run the built service locally instead:

```sh
npm run build
npm start
```

Production mode serves the compiled client and API from the Node.js service. Set `NODE_ENV=production` and use a reverse proxy with TLS for remote access.

## Provider Configuration

Both providers use an OpenAI-compatible request shape:

| Purpose | Request |
| --- | --- |
| List models | `GET {BASE_URL}/models` |
| Refine a prompt | `POST {BASE_URL}/chat/completions` |
| Generate a new image | `POST {BASE_URL}/images/generations` |
| Edit with a reference image | `POST {BASE_URL}/images/edits` |

Configure the exact provider base URL, key, and model ID in the protected management page. Do not append the endpoint path (such as `/chat/completions`) to the base URL. The provider must support the request and response fields used by this application. Image generation currently expects a base64-encoded PNG in `data[0].b64_json`; arbitrary remote image URLs are not fetched. Model discovery shows IDs exposed by the provider; it does not guarantee every listed model implements the required image contract.

There is one explicit image-model compatibility fallback: if `gpt-image-2.6` returns HTTP 404 and is absent from the provider's model list, the server may retry with `gpt-image-2.5` or `gpt-image-2` when that ID is listed as available. The result and audit record report the model actually used. This is not a general provider switch or retry policy.

Environment defaults are documented in [.env.example](.env.example). Default service URLs are intentionally placeholders; endpoint overrides made by an administrator are encrypted together with provider credentials.

## Ubuntu Deployment

Build on the target Ubuntu server. Do not copy `node_modules` built on Windows or another operating system. The repository includes a hardened systemd template at [`deploy/atelier-agent.service`](deploy/atelier-agent.service) and a placeholder environment template at [`deploy/atelier-agent.env.example`](deploy/atelier-agent.env.example).

Install Node.js 24.9 or newer using your preferred trusted distribution, then prepare an application directory and system account:

```sh
sudo useradd --system --home /var/lib/atelier-agent --shell /usr/sbin/nologin atelier-agent
sudo install -d -o atelier-agent -g atelier-agent -m 700 /var/lib/atelier-agent
sudo install -d -m 700 /etc/atelier-agent
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /opt/atelier-agent
```

Clone a clean source checkout into the empty application directory. The current user owns this directory so the dependency install and build do not need to run as root:

```sh
git clone https://github.com/ABone16/galaxy-atelier.git /opt/atelier-agent
cd /opt/atelier-agent
npm ci
npm run typecheck
npm test
npm run build
npm run test:production
```

Create `/etc/atelier-agent/atelier-agent.env` from `deploy/atelier-agent.env.example`. Set production values, a new key from `openssl rand -hex 32`, a unique initial administrator, and provider endpoint defaults. Keep the file root-readable:

```sh
sudo chown root:root /etc/atelier-agent/atelier-agent.env
sudo chmod 600 /etc/atelier-agent/atelier-agent.env
```

Install and validate the service unit:

```sh
sudo install -o root -g root -m 644 deploy/atelier-agent.service /etc/systemd/system/atelier-agent.service
sudo systemd-analyze verify /etc/systemd/system/atelier-agent.service
```

The unit assumes the service source and build are at `/opt/atelier-agent`, data at `/var/lib/atelier-agent`, and Node.js at `/usr/bin/node`. Adjust the unit if your paths differ. Then enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now atelier-agent
sudo systemctl status atelier-agent
sudo journalctl -u atelier-agent -n 100 --no-pager
```

After confirming that the initial administrator can sign in, remove `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from the environment file and restart:

```sh
sudo systemctl restart atelier-agent
```

The application binds to loopback (`127.0.0.1:4318`) by default. Put it behind a reverse proxy that terminates TLS; do not expose the application port directly to the public internet. The systemd unit requires systemd 247+ because it uses `ProtectProc` and `ProcSubset`.

## Operations and Backups

- Keep `APP_ENCRYPTION_KEY` stable and store a protected backup separately from the database. Without it, saved provider credentials and endpoint overrides cannot be decrypted.
- Back up the complete contents of `DATA_DIR`, including `atelier.sqlite`, SQLite's WAL files when present, and the `images/` directory. For a consistent online backup use SQLite's backup API or stop the service before copying files.
- Restrict the environment file, data directory, and backups to the service administrator. Never publish `.env`, database files, logs, or private images.
- Configure TLS and suitable proxy request/body/time limits for image-reference uploads. The application accepts a reference image up to 10 MiB and a larger generation request body to accommodate its encoding.
- Use `systemctl status` and `journalctl -u atelier-agent` for service health and diagnostics. `/api/health` is a process health check, not a provider-connectivity test.

## Development and Tests

```sh
npm run typecheck
npm test
npm run build
npm run test:production
```

`npm test` runs the Node.js test suite. The production smoke test starts a temporary production service with an isolated data directory and mocked provider requests; it exercises bootstrap, login, configuration, generation, image retrieval, usage, audit, and logout without contacting a real model provider. Run the typecheck, test suite, build, and smoke test before releasing changes.

## Repository Layout

```text
src/                         React client, API types, localization, and UI styles
server/index.ts              HTTP API, SQLite schema, auth, generation, and provider calls
tests/                       Unit and security/integration test suites
scripts/                     Production smoke test and isolated provider mock
deploy/                      systemd and environment-file templates
docs/assets/                 README artwork, generated examples, and UI screenshot
AGENT.md                     Prompt-writing role and tool boundary for the host
.env.example                 Local and production environment variable template
```

For the full feature register and README editorial rationale, see [`docs/FEATURE_INVENTORY.md`](docs/FEATURE_INVENTORY.md).

## Limitations

- Galaxy Atelier does not include an image model, translation model, or API credits. Configure compatible provider services to generate real images.
- Provider-compatible does not mean universally interchangeable: endpoint paths, authentication, image-edit support, output formats, and usage reporting vary. Confirm the contract with your provider.
- The current deployment template targets a single Node.js process with a local SQLite database and filesystem image storage. It is not a horizontally scaled or object-storage deployment.
- Usage cost figures are estimates based on configured prices and provider-reported usage; a provider may omit token or cost data.
- Provider terms, rate limits, model IDs, and Linux package availability are controlled by their respective maintainers and can change independently of this project.

<a id="generated-examples"></a>
<details>
  <summary>View generated-image samples</summary>

  These samples are secondary examples of the image workflow; the screenshots above focus on product features.

  - [Skyborne Botanical Greenhouse](docs/assets/greenhouse-over-clouds.jpg) · 3344 × 1882
  - [Rainy Night Tokyo Record Shop](docs/assets/tokyo-vinyl-shop-rain.jpg) · 2804 × 2244
  - [Coastal Lighthouse Screen Print](docs/assets/coastal-lighthouse-screen-print.jpg) · 2048 × 3072
</details>
