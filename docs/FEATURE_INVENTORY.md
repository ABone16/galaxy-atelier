# Galaxy Atelier Feature Inventory

This document separates two tasks: first, a code-verified register of the project's capabilities; second, an editorial decision about which capabilities belong in the public README. The register is the complete reference. The README is a shorter introduction, not a replacement for it.

## Step 1: Complete Feature Register

### Product and workspace

| Area | Verified capability | Evidence |
| --- | --- | --- |
| Product boundary | Galaxy Atelier is a self-hosted web workspace for conversational image generation and image-guided editing. It connects to prompt and image services selected by the operator. It is not a general-purpose computer agent and exposes no shell, filesystem, browser, plugin, or arbitrary URL-fetching tools to the prompt model. | `AGENT.md`; `src/App.tsx`; `server/index.ts` |
| Sign-in | Users sign in to accounts provisioned by an administrator and can sign out. There is no public registration flow. The initial administrator is bootstrapped from environment variables. Eight failed attempts for an email-and-client-IP bucket trigger a 15-minute login lockout. | `src/App.tsx`; `server/index.ts` (`bootstrapAdmin`, `/api/auth/*`, `login_failures`); `tests/security-flow.test.mjs` |
| Roles and account administration | Administrators can create accounts, assign member or administrator roles, enable or disable accounts, reset passwords, and permanently delete accounts. Deleting an account also deletes its sessions, generation records, queued items, stored images, and login sessions. The current administrator cannot disable or demote itself. | `src/App.tsx` (`UsersPage`); `server/index.ts` (`/api/admin/users`); `tests/security-flow.test.mjs` |
| Account isolation | Session, message, queue, generated-image, uploaded-image, and personal-usage reads are scoped to the signed-in account. Administrative routes require administrator access. | `server/index.ts` ownership checks and authenticated routes; `tests/security-flow.test.mjs` |
| Image Studio | Users create image sessions and send natural-language image requests from a conversation composer. A session presents user messages, uploaded images, generation status, completed images, available model feedback, and failure/retry actions together. Users can stop an active request. | `src/App.tsx` (`Studio`, `MessageItem`); `server/index.ts` generation routes |
| Prompt-model refinement | Each request can use the configured prompt model to prepare an English image prompt. The administrator can replace the system instructions; an empty custom prompt restores the bundled `AGENT.md` default. On a new session's first request, the model may also return a session title and image name. | `src/App.tsx` (`Studio`, `ProvidersPage`); `server/index.ts` (`translatePrompt`); `AGENT.md` |
| Direct-to-image mode | Users can skip prompt refinement per request. Their text goes directly to the configured image API. For a text-only request with model-decided sizing, the direct mode uses the landscape preset. | `src/App.tsx`; `server/index.ts` generation handler; `tests/security-flow.test.mjs` |
| Edit and reference modes | An attached image can be treated as an edit target, where unrequested visual attributes should be preserved, or as a visual reference, where only named attributes guide the new output. The two modes are passed distinctly through prompt preparation and image requests. | `src/App.tsx` (`Studio`); `server/index.ts` image request mode; `tests/security-flow.test.mjs` |
| Image input | Users can choose, drag and drop, or paste an image. The client checks the file signature, decodes browser-supported formats, normalizes the image to PNG, validates dimensions, and enforces a 10 MiB limit. Uploaded and generated images open in an in-app enlarged preview. | `src/App.tsx` (`normalizeImageFile`, `Studio`, `ImagePreviewModal`); `server/index.ts` (`parseReferenceImage`); `tests/security-flow.test.mjs` |
| Follow-up image context | With prompt refinement enabled, a follow-up that has no new attachment can reuse the image from the latest successful prompt-refined turn as an edit target; the prompt model also receives that turn's original and refined text prompts. With refinement disabled, the user must attach an image explicitly. | `server/index.ts` generation handler (`previousGeneration`, `previousImage`); `tests/security-flow.test.mjs` |
| Canvas sizing | Users can choose model-decided sizing or square, portrait, and landscape presets. When a reference image is attached, the selector is disabled and output follows the input orientation. The application records the dimensions actually returned by the provider. | `src/App.tsx` size selector; `server/index.ts` generation handler; `tests/security-flow.test.mjs` |
| Generation queue | Each session can hold up to 12 persistent queued requests processed in order. Users can edit a queued prompt and its prompt-model choice, remove an item, or move it back to the composer to adjust its size or reference image. Stopping an active generation pauses that session's queue. | `src/App.tsx` (`QueueDock`, `editQueuedGeneration`); `src/generation-queue.ts`; `server/index.ts`; `tests/generation-queue.test.mjs` |
| Results and feedback | Results show the generated image, a descriptive model-provided name when available, actual image model and dimensions, status, available model feedback, and reported usage or estimated cost. Images can be enlarged, downloaded, or used to continue editing. Failed requests also retain available model text feedback. | `src/App.tsx` (`MessageItem`, `WorkedSummary`); `server/index.ts` generation persistence and image route |
| Conversation history | Messages are paginated. Users can load older messages while preserving the visible scroll anchor, follow new messages, or jump back to the latest turn. | `src/App.tsx`; `src/chat-history.ts`; `src/chat-scroll.ts`; `tests/chat-history.test.mjs`; `tests/chat-scroll.test.mjs` |
| Session organization | Users can search sessions by title or message text, rename, archive, restore, and permanently delete sessions. Archived sessions are read-only until restored. Deleting a session removes its associated records and stored images. | `src/App.tsx` (`SessionRow`); `server/index.ts` `/api/sessions`; `tests/security-flow.test.mjs` |
| Keyboard and responsive behavior | The workspace adapts to narrow screens. `Ctrl+K` or `Cmd+K` creates a session. `Escape` closes an enlarged preview and can stop an active request when the composer is empty. | `src/App.tsx` keyboard handling; `src/styles.css` responsive rules |
| Member usage | Members can review their own request totals, success rate, response time, prompt/image token usage, model breakdown, and estimated cost. Cost estimates depend on configured prices and provider-reported usage. | `src/App.tsx` (`UsagePage`, `ModelTable`); `server/index.ts` `/api/usage` |
| Localization | The interface is available in English and Simplified Chinese. It detects the browser language by default, follows browser-language changes while automatic mode is active, and remembers a user-selected language locally. | `src/i18n.ts`; `src/App.tsx` language state and `LanguageSwitcher` |
| Themes and motion | There are nine named palettes (four light and five dark) plus a system-following option. The system option responds to the operating-system light/dark preference. Transitions respect reduced-motion preferences. | `src/App.tsx` (`themeOptions`); `src/styles.css` theme and motion rules |

### Administration and providers

| Area | Verified capability | Evidence |
| --- | --- | --- |
| Provider configuration | Administrators configure separate compatible API base URLs, keys, and model IDs for prompt and image services. They can set prompt instructions, token rates, and per-image cost. Provider settings, including saved credentials and endpoint overrides, are encrypted at rest; saved keys are not returned to the browser. | `src/App.tsx` (`ProvidersPage`); `server/index.ts` (`/api/admin/providers`, `seal`, `providersForAdmin`); `tests/security-flow.test.mjs` |
| Model discovery and connectivity check | Administrators can request a provider's `/models` list, select a returned model ID, or enter an ID directly. The check reports whether the request succeeded; it does not establish that every listed model supports the image contract required by the application. | `src/App.tsx` (`ProvidersPage`); `server/index.ts` (`providerModels`, `/api/admin/providers/test`); `tests/security-flow.test.mjs` |
| Traffic overview | Administrators can inspect service-wide request totals, estimated costs, token usage, success rate, and response time. The chart and bucket table cover the last 60 minutes, 24 hours, 30 days, or 12 months and report request status, accounts, sessions, tokens, cost, and average duration per period. | `src/App.tsx` (`AdminStatsPage`); `server/index.ts` `/api/admin/stats`; `src/api.ts` (`AdminStats`, `TrafficBucket`); `tests/security-flow.test.mjs` |
| Account and model analytics | The administrator overview groups usage by account, actual/requested image model, prompt model, generation/edit/reference mode, and normalized failure code. | `src/App.tsx` (`AccountTable`, `ModelTable`, `ModeTable`, `ErrorTable`); `server/index.ts` statistics query |
| Audit logs | Administrators can filter logs by account, event, and outcome; load older entries; export matching rows as CSV; and delete individual entries. Logs contain operational metadata rather than full prompts or raw API keys. Provider-configuration update events can include configured base URLs, model IDs, and key-updated flags. | `src/App.tsx` (`LogsPage`); `server/index.ts` audit routes and `auditLogsCsv`; `tests/security-flow.test.mjs` |

### Deployment and maintenance

| Area | Verified capability | Evidence |
| --- | --- | --- |
| Runtime and storage | One Node.js service serves the production frontend and API. The application uses local SQLite and filesystem-backed images under `DATA_DIR`; it does not require a separate database server. | `package.json`; `server/index.ts`; `.env.example` |
| Health and deployment | The service provides a process health endpoint and development/production scripts. The repository includes an Ubuntu/systemd template that runs under an unprivileged account with filesystem hardening; the default listener is loopback. | `server/index.ts`; `package.json`; `deploy/atelier-agent.service`; `.env.example` |
| Automated checks | Tests cover statistics helpers, authentication and security flows, queue behavior, conversation history, and scrolling. A production smoke test uses mocked provider requests and an isolated data directory. There is no dedicated chart-rendering test. | `tests/`; `scripts/production-smoke.mjs`; `scripts/production-provider-mock.mjs`; `package.json` |

## Product Boundaries and Constraints

- The prompt model prepares image prompts; the host application owns authentication, sessions, persistence, provider calls, and image delivery. The model receives no local-computer control tools.
- When prompt refinement is enabled, the configured prompt provider may receive the user's text, applicable prior prompt context, and an attached reference image. The configured image provider receives the generation request and any applicable reference image. Self-hosting keeps application data on the operator's server, but does not prevent these selected request contents from being sent to provider APIs.
- Provider compatibility is contract-based, not universal. Image generation expects base64 PNG output in `data[0].b64_json`; arbitrary remote image URLs are not fetched.
- A discovered model ID is not guaranteed to implement the endpoint, image-edit behavior, payload fields, and output format required by the application.
- Reported costs are estimates based on administrator-configured prices and provider usage fields. Providers may omit usage data.
- The UI shows prompt preparation summaries, prompts, provider revisions, and returned model feedback. It does not expose hidden chain-of-thought or a full serialized provider request.
- The deployment model is a single Node.js process with local SQLite and filesystem image storage. Horizontal scaling and object-storage support are not included.
- Audit logs omit raw provider keys and full prompts, but provider-settings update records can include configured base URLs. Treat the audit database and exports as operational data and protect them accordingly.

## Step 2: README Editorial Decisions

The README should introduce the real product as a managed, self-hosted workspace. Its main story should explain how people use and operate the application, rather than presenting generated art as the product itself.

### Worth Explaining

| Topic | How to present it |
| --- | --- |
| Self-hosted workspace and account boundaries | Explain who runs the service, that accounts are administrator-provisioned, and what data is scoped per account. Pair this with the workspace and account-management screenshots. |
| Provider choice and setup | Explain the separate prompt and image provider settings, editable API base URLs, model discovery, and the compatibility caveat. Keep credential handling and exact endpoint requirements in setup/security documentation. Do not publish configured endpoints or credentials. |
| Operational visibility | Highlight personal usage, the administrator traffic overview, and exportable audit logs. Use real UI screenshots with synthetic demo data. Describe costs as estimates. |
| Session and request organization | Summarize searchable sessions, archive/restore/delete, and the persistent request queue as practical workflow features. |
| Language and theme choices | Mention English/Chinese, browser-language detection, nine palettes, and following system appearance. Pair with the settings-menu screenshots. |
| Image workflow | Explain prompt-model on/off control, edit versus reference intent, uploads, and follow-up context accurately. Show the composer as a workspace control, not as a generated-art hero. |

### Mention Briefly

- Generated-image previews, names, dimensions, downloads, and continuation into an edit are important results of the workflow, but should follow the workspace and operations overview.
- Queue capacity, the 10 MiB upload limit, direct-mode sizing fallback, and detailed context reuse rules belong in a feature note or relevant workflow section, not the opening pitch.
- Self-hosting, account isolation, provider transmission, encrypted settings, and deployment limits need concise, accurate security notes; avoid absolute privacy claims.

### Keep Out of the Product Story

These details remain useful to operators or maintainers, but do not need individual promotional treatment:

- Every API route, database column, migration, response field, or helper function.
- Every traffic-chart metric and bucket calculation.
- Password-hash algorithms, cookie attributes, login-lockout internals, image signature checks, codecs, and queue encryption implementation.
- CSS tokens, animation names, breakpoints, keyboard shortcuts, and icon behavior.
- Fallback implementation details, error-code taxonomies, test fixtures, environment-variable inventories, and systemd hardening directives.
- Claims that the UI reveals hidden model reasoning, every field of provider requests, universal provider compatibility, or provider-free/private-by-default generation.

## README Structure and Screenshots

Use this sequence in both language-specific READMEs:

1. The supplied promotional artwork and a concise description of the self-hosted workspace.
2. A short capability overview centered on accounts, provider configuration, the workbench, operations, and interface preferences.
3. Screenshots of the running application: the studio, administrator overview, account management, member usage, themes, and filtered audit logs.
4. A short explanation of the conversational image workflow and its boundaries.
5. Generated-image examples as secondary evidence of the workflow, not the lead section.
6. Architecture, security/data boundaries, setup, Ubuntu deployment, operations, limitations, and developer verification.

The screenshots in `docs/assets/ui-*.png` were captured from the running application using a synthetic demonstration account. They are intended to show functional UI; do not add configured provider URLs, credentials, or private user content to public screenshots.
