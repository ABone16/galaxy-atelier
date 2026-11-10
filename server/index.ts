import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const scrypt = promisify(scryptCallback)
const moduleDir = dirname(fileURLToPath(import.meta.url))
const root = basename(dirname(moduleDir)) === 'dist' ? resolve(moduleDir, '../..') : resolve(moduleDir, '..')
const dataDir = resolve(process.env.DATA_DIR ?? join(root, 'data'))
const imageDir = join(dataDir, 'images')
let database: DatabaseSync
const port = Number(process.env.PORT ?? 4318)
const host = process.env.HOST ?? '127.0.0.1'
const requestTimeout = Math.min(Math.max(Number(process.env.REQUEST_TIMEOUT_MS ?? 90_000), 5_000), 180_000)
const sessionLifetime = 24 * 60 * 60 * 1000
const maxBodyBytes = 1024 * 1024
const maxGenerationBodyBytes = 15 * 1024 * 1024
const maxReferenceImageBytes = 10 * 1024 * 1024
const maxProviderResponseBytes = 24 * 1024 * 1024
const maxQueuedGenerations = 12
const encryptionKeyHex = process.env.APP_ENCRYPTION_KEY ?? ''
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
  throw new Error('APP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters')
}
type ActiveGeneration = {
  userId: string
  conversationId: string
  generationId: string
  controller: AbortController
}
const activeGenerations = new Map<string, ActiveGeneration>()

type Role = 'user' | 'admin'
type AuthUser = { id: string, email: string, role: Role }
type ProviderConfig = {
  translation: {
    apiKey: string
    baseUrl: string
    model: string
    systemPrompt: string
    inputPricePerMillion: number
    outputPricePerMillion: number
  }
  image: {
    apiKey: string
    baseUrl: string
    model: string
    inputPricePerMillion: number
    outputPricePerMillion: number
    costPerImage: number
  }
}

const defaultTranslationBaseUrl = process.env.TRANSLATION_API_BASE_URL ?? 'https://translation-provider.example/v1'
const defaultImageBaseUrl = process.env.IMAGE_API_BASE_URL ?? 'https://image-provider.example/v1'
const emptyProviders: ProviderConfig = {
  translation: { apiKey: '', baseUrl: defaultTranslationBaseUrl, model: 'gpt-4.1-mini', systemPrompt: '', inputPricePerMillion: 0, outputPricePerMillion: 0 },
  image: { apiKey: '', baseUrl: defaultImageBaseUrl, model: 'gpt-image-2.6', inputPricePerMillion: 0, outputPricePerMillion: 0, costPerImage: 0 },
}

await mkdir(dataDir, { recursive: true })
await mkdir(imageDir, { recursive: true })
database = new DatabaseSync(join(dataDir, 'atelier.sqlite'))
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'admin')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS login_sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    archived_at TEXT,
    queue_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_user_updated ON conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS generation_queue (
    queue_order INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    size TEXT NOT NULL CHECK(size IN ('auto', '1024x1024', '1024x1536', '1536x1024')),
    translation_enabled INTEGER NOT NULL DEFAULT 1,
    image_mode TEXT NOT NULL CHECK(image_mode IN ('generation', 'edit', 'reference')),
    reference_image TEXT,
    reference_image_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS generation_queue_session_order
    ON generation_queue(user_id, conversation_id, queue_order);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    image_mode TEXT NOT NULL DEFAULT 'generation' CHECK(image_mode IN ('generation', 'edit', 'reference')),
    reference_image_bytes INTEGER NOT NULL DEFAULT 0,
    generation_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_conversation_created_id ON messages(conversation_id, created_at, id);
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    translated_prompt TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed')),
    image_path TEXT,
    media_type TEXT,
    input_image_path TEXT,
    input_media_type TEXT,
    image_model TEXT NOT NULL,
    requested_image_model TEXT,
    translation_model TEXT NOT NULL,
    translation_enabled INTEGER NOT NULL DEFAULT 1,
    translation_input_tokens INTEGER NOT NULL DEFAULT 0,
    translation_output_tokens INTEGER NOT NULL DEFAULT 0,
    image_input_tokens INTEGER NOT NULL DEFAULT 0,
    image_output_tokens INTEGER NOT NULL DEFAULT 0,
    image_width INTEGER,
    image_height INTEGER,
    image_mode TEXT NOT NULL DEFAULT 'generation' CHECK(image_mode IN ('generation', 'edit', 'reference')),
    image_size TEXT,
    image_name TEXT,
    reference_image_bytes INTEGER NOT NULL DEFAULT 0,
    revised_prompt TEXT,
    model_feedback TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    translation_token_cost_usd REAL,
    image_token_cost_usd REAL,
    image_request_cost_usd REAL,
    duration_ms INTEGER,
    error_code TEXT,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS generations_user_created ON generations(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    user_id TEXT,
    email TEXT,
    event TEXT NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL,
    ip_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created ON audit_logs(created_at DESC);
  CREATE TABLE IF NOT EXISTS login_failures (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    reset_at TEXT NOT NULL
  );
`)

const conversationColumns = new Set(
  (database.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(column => column.name),
)
if (!conversationColumns.has('archived_at')) database.exec('ALTER TABLE conversations ADD COLUMN archived_at TEXT')
if (!conversationColumns.has('queue_paused')) database.exec('ALTER TABLE conversations ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0')
database.exec('CREATE INDEX IF NOT EXISTS conversations_user_archived_updated ON conversations(user_id, archived_at, updated_at DESC)')

const generationColumns = new Set(
  (database.prepare('PRAGMA table_info(generations)').all() as Array<{ name: string }>).map(column => column.name),
)
for (const [name, definition] of [
  ['image_width', 'INTEGER'],
  ['image_height', 'INTEGER'],
  ['image_mode', "TEXT NOT NULL DEFAULT 'generation'"],
  ['image_size', 'TEXT'],
  ['image_name', 'TEXT'],
  ['translation_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['input_image_path', 'TEXT'],
  ['input_media_type', 'TEXT'],
  ['reference_image_bytes', 'INTEGER NOT NULL DEFAULT 0'],
  ['revised_prompt', 'TEXT'],
  ['model_feedback', 'TEXT'],
  ['requested_image_model', 'TEXT'],
  ['translation_token_cost_usd', 'REAL'],
  ['image_token_cost_usd', 'REAL'],
  ['image_request_cost_usd', 'REAL'],
] as const) {
  if (!generationColumns.has(name)) database.exec(`ALTER TABLE generations ADD COLUMN ${name} ${definition}`)
}
const queueColumns = new Set(
  (database.prepare('PRAGMA table_info(generation_queue)').all() as Array<{ name: string }>).map(column => column.name),
)
if (!queueColumns.has('translation_enabled')) {
  database.exec('ALTER TABLE generation_queue ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 1')
}
const generationQueueSql = database.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_queue'",
).get() as { sql: string } | undefined
if (generationQueueSql?.sql && !generationQueueSql.sql.toLowerCase().includes("'auto'")) {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('DROP INDEX IF EXISTS generation_queue_session_order')
    database.exec('ALTER TABLE generation_queue RENAME TO generation_queue_legacy')
    database.exec(`
      CREATE TABLE generation_queue (
        queue_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        size TEXT NOT NULL CHECK(size IN ('auto', '1024x1024', '1024x1536', '1536x1024')),
        translation_enabled INTEGER NOT NULL DEFAULT 1,
        image_mode TEXT NOT NULL CHECK(image_mode IN ('generation', 'edit', 'reference')),
        reference_image TEXT,
        reference_image_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    database.exec(`
      INSERT INTO generation_queue(
        queue_order, id, conversation_id, user_id, prompt, size, translation_enabled,
        image_mode, reference_image, reference_image_bytes, created_at, updated_at
      )
      SELECT
        queue_order, id, conversation_id, user_id, prompt, size, translation_enabled,
        image_mode, reference_image, reference_image_bytes, created_at, updated_at
      FROM generation_queue_legacy
    `)
    database.exec('DROP TABLE generation_queue_legacy')
    database.exec(`
      CREATE INDEX generation_queue_session_order
        ON generation_queue(user_id, conversation_id, queue_order)
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
const messageColumns = new Set(
  (database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name),
)
for (const [name, definition] of [
  ['image_mode', "TEXT NOT NULL DEFAULT 'generation'"],
  ['reference_image_bytes', 'INTEGER NOT NULL DEFAULT 0'],
] as const) {
  if (!messageColumns.has(name)) database.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`)
}

const now = (): string => new Date().toISOString()
const dbGet = <T>(sql: string, ...params: SQLInputValue[]): T | undefined =>
  database.prepare(sql).get(...params) as T | undefined
const dbAll = <T>(sql: string, ...params: SQLInputValue[]): T[] =>
  database.prepare(sql).all(...params) as T[]
const dbRun = (sql: string, ...params: SQLInputValue[]): void => {
  database.prepare(sql).run(...params)
}

type TrafficUnit = 'minute' | 'hour' | 'day' | 'month'
type TrafficBucket = {
  bucket: string
  start: string
  end: string
  accounts: number
  sessions: number
  generations: number
  succeeded: number
  failed: number
  cancelled: number
  averageDurationMs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  translationInputTokens: number
  translationOutputTokens: number
  imageInputTokens: number
  imageOutputTokens: number
  translationTokenCostUsd: number
  imageTokenCostUsd: number
  imageRequestCostUsd: number
  unclassifiedCostUsd: number
}

function floorTrafficDate(value: Date, unit: TrafficUnit): Date {
  const result = new Date(value)
  if (unit === 'minute') {
    result.setUTCSeconds(0, 0)
  } else if (unit === 'hour') {
    result.setUTCMinutes(0, 0, 0)
  } else if (unit === 'day') {
    result.setUTCHours(0, 0, 0, 0)
  } else {
    result.setUTCDate(1)
    result.setUTCHours(0, 0, 0, 0)
  }
  return result
}

function addTrafficUnit(value: Date, unit: TrafficUnit, amount = 1): Date {
  const result = new Date(value)
  if (unit === 'minute') result.setUTCMinutes(result.getUTCMinutes() + amount)
  else if (unit === 'hour') result.setUTCHours(result.getUTCHours() + amount)
  else if (unit === 'day') result.setUTCDate(result.getUTCDate() + amount)
  else result.setUTCMonth(result.getUTCMonth() + amount)
  return result
}

function trafficBucketKey(value: Date, unit: TrafficUnit): string {
  const iso = value.toISOString()
  if (unit === 'minute') return `${iso.slice(0, 16)}:00Z`
  if (unit === 'hour') return `${iso.slice(0, 13)}:00:00Z`
  if (unit === 'day') return iso.slice(0, 10)
  return iso.slice(0, 7)
}

function trafficBucketExpression(unit: TrafficUnit): string {
  if (unit === 'minute') return "strftime('%Y-%m-%dT%H:%M:00Z', created_at)"
  if (unit === 'hour') return "strftime('%Y-%m-%dT%H:00:00Z', created_at)"
  if (unit === 'day') return 'substr(created_at, 1, 10)'
  return 'substr(created_at, 1, 7)'
}

function trafficSeries(unit: TrafficUnit, count: number): TrafficBucket[] {
  const current = floorTrafficDate(new Date(), unit)
  const first = addTrafficUnit(current, unit, -(count - 1))
  const bucketExpression = trafficBucketExpression(unit)
  const rows = dbAll<Record<string, unknown>>(
    `SELECT ${bucketExpression} AS bucket,
      COUNT(DISTINCT user_id) AS accounts,
      COUNT(DISTINCT conversation_id) AS sessions,
      COUNT(*) AS generations,
      COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
      COALESCE(AVG(duration_ms), 0) AS averageDurationMs,
      COALESCE(SUM(cost_usd), 0) AS costUsd,
      COALESCE(SUM(translation_input_tokens + image_input_tokens), 0) AS inputTokens,
      COALESCE(SUM(translation_output_tokens + image_output_tokens), 0) AS outputTokens,
      COALESCE(SUM(translation_input_tokens), 0) AS translationInputTokens,
      COALESCE(SUM(translation_output_tokens), 0) AS translationOutputTokens,
      COALESCE(SUM(image_input_tokens), 0) AS imageInputTokens,
      COALESCE(SUM(image_output_tokens), 0) AS imageOutputTokens,
      COALESCE(SUM(translation_token_cost_usd), 0) AS translationTokenCostUsd,
      COALESCE(SUM(image_token_cost_usd), 0) AS imageTokenCostUsd,
      COALESCE(SUM(image_request_cost_usd), 0) AS imageRequestCostUsd,
      COALESCE(SUM(CASE WHEN translation_token_cost_usd IS NULL
        OR image_token_cost_usd IS NULL OR image_request_cost_usd IS NULL THEN cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd
     FROM generations
     WHERE created_at >= ?
     GROUP BY ${bucketExpression}
     ORDER BY bucket ASC`,
    first.toISOString(),
  )
  const byBucket = new Map(rows.map(row => [String(row.bucket), row]))
  const asNumber = (row: Record<string, unknown>, key: string): number => Number(row[key] ?? 0)
  return Array.from({ length: count }, (_, index) => {
    const start = addTrafficUnit(first, unit, index)
    const end = addTrafficUnit(start, unit)
    const bucket = trafficBucketKey(start, unit)
    const row = byBucket.get(bucket) ?? {}
    return {
      bucket,
      start: start.toISOString(),
      end: end.toISOString(),
      accounts: asNumber(row, 'accounts'),
      sessions: asNumber(row, 'sessions'),
      generations: asNumber(row, 'generations'),
      succeeded: asNumber(row, 'succeeded'),
      failed: asNumber(row, 'failed'),
      cancelled: asNumber(row, 'cancelled'),
      averageDurationMs: asNumber(row, 'averageDurationMs'),
      costUsd: asNumber(row, 'costUsd'),
      inputTokens: asNumber(row, 'inputTokens'),
      outputTokens: asNumber(row, 'outputTokens'),
      translationInputTokens: asNumber(row, 'translationInputTokens'),
      translationOutputTokens: asNumber(row, 'translationOutputTokens'),
      imageInputTokens: asNumber(row, 'imageInputTokens'),
      imageOutputTokens: asNumber(row, 'imageOutputTokens'),
      translationTokenCostUsd: asNumber(row, 'translationTokenCostUsd'),
      imageTokenCostUsd: asNumber(row, 'imageTokenCostUsd'),
      imageRequestCostUsd: asNumber(row, 'imageRequestCostUsd'),
      unclassifiedCostUsd: asNumber(row, 'unclassifiedCostUsd'),
    }
  })
}

function recoverPendingGenerations(): void {
  const pending = dbAll<{
    id: string
    conversationId: string
    userId: string
    requestId: string
    createdAt: string
    inputImagePath: string | null
  }>(
    `SELECT id, conversation_id AS conversationId, user_id AS userId,
      request_id AS requestId, created_at AS createdAt, input_image_path AS inputImagePath
     FROM generations WHERE status = 'pending'`,
  )
  for (const generation of pending) {
    const durationMs = Math.max(0, Date.now() - Date.parse(generation.createdAt))
    dbRun(
      `UPDATE generations SET status = 'failed', error_code = ?, duration_ms = ?, input_image_path = NULL, input_media_type = NULL
       WHERE id = ? AND status = 'pending'`,
      'server-restarted', durationMs, generation.id,
    )
    if (generation.inputImagePath) void rm(generation.inputImagePath, { force: true }).catch(() => undefined)
    const message = dbGet<{ id: string }>(
      'SELECT id FROM messages WHERE generation_id = ? AND role = ? LIMIT 1',
      generation.id, 'assistant',
    )
    const content = 'Service restarted. The previous generation was aborted and can be submitted again.'
    if (message) {
      dbRun('UPDATE messages SET content = ? WHERE id = ?', content, message.id)
    } else {
      dbRun(
        `INSERT INTO messages(id, conversation_id, user_id, role, content, generation_id, created_at)
         VALUES(?, ?, ?, 'assistant', ?, ?, ?)`,
        randomUUID(), generation.conversationId, generation.userId, content, generation.id, now(),
      )
    }
    const account = dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', generation.userId)
    dbRun(
      `INSERT INTO audit_logs(request_id, user_id, email, event, status, details_json, ip_hash, created_at)
       VALUES(?, ?, ?, 'generation.recovered', 'failure', ?, NULL, ?)`,
      generation.requestId, generation.userId, account?.email ?? null,
      JSON.stringify({ generationId: generation.id, code: 'server-restarted', durationMs }), now(),
    )
  }
}

recoverPendingGenerations()

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function encryptionKey(): Buffer {
  return Buffer.from(encryptionKeyHex, 'hex')
}

function seal(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join('.')
}

function unseal(value: string): string {
  const [ivHex, tagHex, ciphertextHex] = value.split('.')
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error('Stored provider configuration is invalid')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8')
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length) as Buffer
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>()
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return result
}

type MessageCursor = { createdAt: string, id: string }

function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeMessageCursor(value: string): MessageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MessageCursor>
    if (typeof parsed.createdAt !== 'string' || parsed.createdAt.length > 80
      || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return null
  }
}

function messagePayload(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ...row,
    imageMode: row.role === 'assistant' ? row.generationImageMode ?? row.messageImageMode : row.messageImageMode,
    referenceImageBytes: row.role === 'assistant'
      ? row.generationReferenceImageBytes ?? row.messageReferenceImageBytes
      : row.messageReferenceImageBytes,
  }
  delete output.messageImageMode
  delete output.messageReferenceImageBytes
  delete output.generationImageMode
  delete output.generationReferenceImageBytes
  if (row.translationEnabled !== undefined) output.translationEnabled = Boolean(row.translationEnabled)
  if (row.role === 'assistant' && row.generationId) output.imageUrl = `/api/generations/${row.generationId}/image`
  if (row.role === 'user') {
    if (row.inputImagePath && row.generationId) output.inputImageUrl = `/api/generations/${row.generationId}/input-image`
    for (const key of [
      'generationStatus', 'originalPrompt', 'translatedPrompt', 'revisedPrompt', 'imageWidth', 'imageHeight',
      'imageSize', 'imageName', 'imageModel', 'requestedImageModel', 'translationModel', 'translationEnabled',
      'translationInputTokens', 'translationOutputTokens', 'imageInputTokens', 'imageOutputTokens',
      'modelFeedback', 'costUsd', 'durationMs', 'translationTokenCostUsd', 'imageTokenCostUsd', 'imageRequestCostUsd', 'errorCode',
    ]) delete output[key]
    delete output.generationId
  }
  delete output.inputImagePath
  delete output.inputMediaType
  return output
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function safeImageName(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
  return cleaned || fallback
}

function parseTranslationOutput(raw: string): { translated: string, title: string, sessionTitle: string } {
  const content = raw.trim()
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(content) as { session_title?: unknown, sessionTitle?: unknown, title?: unknown, prompt?: unknown }
    if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string' && typeof parsed.prompt === 'string') {
      const sessionTitle = typeof parsed.session_title === 'string'
        ? parsed.session_title
        : typeof parsed.sessionTitle === 'string'
          ? parsed.sessionTitle
          : parsed.title
      return { title: parsed.title.trim(), sessionTitle: sessionTitle.trim(), translated: parsed.prompt.trim() }
    }
  } catch {
    // Fall through to the labelled text format and legacy plain-text output.
  }
  const labelled = /^\s*(?:SESSION_TITLE|SESSION TITLE)\s*:\s*([^\r\n]+)\s*(?:\r?\n)+\s*TITLE\s*:\s*([^\r\n]+)\s*(?:\r?\n)+\s*PROMPT\s*:\s*([\s\S]+)$/i.exec(content)
  if (labelled) {
    return {
      sessionTitle: labelled[1].trim(),
      title: labelled[2].trim(),
      translated: labelled[3].trim(),
    }
  }
  const imageLabelled = /^\s*TITLE\s*:\s*([^\r\n]+)\s*(?:\r?\n)+\s*PROMPT\s*:\s*([\s\S]+)$/i.exec(content)
  if (imageLabelled) {
    return {
      sessionTitle: imageLabelled[1].trim(),
      title: imageLabelled[1].trim(),
      translated: imageLabelled[2].trim(),
    }
  }
  const promptOnly = /^\s*PROMPT\s*:\s*([\s\S]+)$/i.exec(content)
  return {
    sessionTitle: '',
    title: '',
    translated: promptOnly ? promptOnly[1].trim() : content,
  }
}

function fail(status: number, message: string): never {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  throw error
}

async function readJson(req: IncomingMessage, limit = maxBodyBytes): Promise<Record<string, unknown>> {
  const contentLength = req.headers['content-length']
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
    fail(413, 'Request body is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > limit) fail(413, 'Request body is too large')
    chunks.push(bytes)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(400, 'Request format is invalid')
    return parsed as Record<string, unknown>
  } catch (error) {
    if ('status' in (error as object)) throw error
    fail(400, 'Request must be JSON')
  }
}

function requestId(req: IncomingMessage): string {
  const supplied = req.headers['x-request-id']
  return typeof supplied === 'string' && /^[\w-]{8,80}$/.test(supplied) ? supplied : randomUUID()
}

function clientIpHash(req: IncomingMessage): string | null {
  const ip = req.socket.remoteAddress
  return ip ? hash(`${encryptionKeyHex}:${ip}`).slice(0, 24) : null
}

function providerSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(requestTimeout)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

function assertGenerationActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('generation-cancelled')
}

function cancelGenerationsForUser(userId: string): void {
  for (const active of activeGenerations.values()) {
    if (active.userId === userId) active.controller.abort()
  }
}

function writeAudit(
  req: IncomingMessage,
  id: string,
  user: AuthUser | undefined,
  event: string,
  status: 'success' | 'failure',
  details: Record<string, unknown> = {},
): void {
  dbRun(
    'INSERT INTO audit_logs(request_id, user_id, email, event, status, details_json, ip_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    id, user?.id ?? null, user?.email ?? null, event, status, JSON.stringify(details), clientIpHash(req), now(),
  )
}

async function readBodyBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxProviderResponseBytes) {
      await reader.cancel()
      throw new Error('provider-response-too-large')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(result)
}

async function providerModels(base: string, key: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: providerSignal(signal),
    redirect: 'error',
  })
  const text = await readBodyBounded(response)
  if (!response.ok) throw new Error(`models-http-${response.status}`)
  try {
    const payload: unknown = JSON.parse(text)
    if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new Error()
    }
    return payload.data
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map(item => item.id)
      .filter((id): id is string => typeof id === 'string')
  } catch {
    throw new Error('models-invalid-json')
  }
}

class ProviderRequestError extends Error {
  readonly providerFeedback: string

  constructor(message: string, providerFeedback: string) {
    super(message)
    this.name = 'ProviderRequestError'
    this.providerFeedback = providerFeedback
  }
}

function cleanProviderFeedback(value: unknown, secret: string): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(secret, '[[redacted]]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 4000)
}

function providerFeedbackFromPayload(payload: unknown, secret: string): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
  const record = payload as Record<string, unknown>
  const error = record.error
  const candidates = [
    typeof error === 'string' ? error : undefined,
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>).message
      : undefined,
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>).detail
      : undefined,
    record.message,
    record.detail,
  ]
  for (const candidate of candidates) {
    const feedback = cleanProviderFeedback(candidate, secret)
    if (feedback) return feedback
  }
  return ''
}

async function providerJson(url: string, key: string, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: providerSignal(signal),
    redirect: 'error',
  })
  const text = await readBodyBounded(response)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (!response.ok) {
      throw new ProviderRequestError(`provider-http-${response.status}`, cleanProviderFeedback(text, key))
    }
    throw new Error('provider-invalid-json')
  }
  if (!response.ok) {
    throw new ProviderRequestError(
      `provider-http-${response.status}`,
      providerFeedbackFromPayload(parsed, key),
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('provider-invalid-json')
  return parsed as Record<string, unknown>
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function readProviders(): ProviderConfig {
  const row = dbGet<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', 'providers')
  if (!row) return structuredClone(emptyProviders)
  try {
    const stored = JSON.parse(unseal(row.value)) as Partial<ProviderConfig>
    return {
      translation: { ...emptyProviders.translation, ...stored.translation },
      image: { ...emptyProviders.image, ...stored.image },
    }
  } catch {
    fail(503, 'The server-side key could not be decrypted. Please check APP_ENCRYPTION_KEY.')
  }
}

function providersForAdmin(config: ProviderConfig): Record<string, unknown> {
  let defaultSystemPrompt = ''
  try {
    defaultSystemPrompt = readFileSync(join(root, 'AGENT.md'), 'utf8')
  } catch {
    // The generation path reports a useful error if the default prompt is unavailable.
  }
  return {
    translation: {
      configured: Boolean(config.translation.apiKey),
      baseUrl: config.translation.baseUrl,
      model: config.translation.model,
      systemPrompt: config.translation.systemPrompt || defaultSystemPrompt,
      inputPricePerMillion: config.translation.inputPricePerMillion,
      outputPricePerMillion: config.translation.outputPricePerMillion,
    },
    image: {
      configured: Boolean(config.image.apiKey),
      baseUrl: config.image.baseUrl,
      model: config.image.model,
      inputPricePerMillion: config.image.inputPricePerMillion,
      outputPricePerMillion: config.image.outputPricePerMillion,
      costPerImage: config.image.costPerImage,
    },
  }
}

function cleanBaseUrl(value: string | undefined, fallback: string): string {
  const base = (value ?? fallback).replace(/\/+$/, '')
  const parsed = new URL(base)
  const localDev = process.env.NODE_ENV !== 'production'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  if (parsed.protocol !== 'https:' && !(localDev && parsed.protocol === 'http:')) {
    throw new Error('API base URL must use HTTPS')
  }
  if (parsed.username || parsed.password) throw new Error('API base URL must not include credentials')
  return base
}

async function bootstrapAdmin(): Promise<void> {
  const count = dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM users')?.count ?? 0
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.INITIAL_ADMIN_PASSWORD
  if (count > 0 || !email || !password) return
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    console.warn('Initial admin not created: provide a valid INITIAL_ADMIN_EMAIL and an 8+ character INITIAL_ADMIN_PASSWORD.')
    return
  }
  dbRun(
    'INSERT INTO users(id, email, password_hash, role, active, created_at) VALUES(?, ?, ?, ?, 1, ?)',
    randomUUID(), email, await passwordHash(password), 'admin', now(),
  )
  console.info(`Bootstrapped initial administrator: ${email}`)
}

async function authenticatedUser(req: IncomingMessage): Promise<AuthUser | undefined> {
  const token = parseCookies(req).get('atelier_session')
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined
  const row = dbGet<{ id: string, email: string, role: Role, active: number, expires_at: string }>(
    `SELECT u.id, u.email, u.role, u.active, s.expires_at
     FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    hash(token),
  )
  if (!row || row.active !== 1 || Date.parse(row.expires_at) <= Date.now()) return undefined
  return { id: row.id, email: row.email, role: row.role }
}

function requireUser(user: AuthUser | undefined): AuthUser {
  if (!user) fail(401, 'Please sign in first')
  return user
}

function requireAdmin(user: AuthUser | undefined): AuthUser {
  const current = requireUser(user)
  if (current.role !== 'admin') fail(403, 'Administrator permission is required')
  return current
}

function validateEmail(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'Email format is invalid')
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Email format is invalid')
  return email
}

function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    fail(400, 'Password length must be 8 to 200 characters')
  }
  return value
}

function sessionOwnedBy(id: string, user: AuthUser): Record<string, unknown> {
  const row = dbGet<Record<string, unknown>>(
    'SELECT id, user_id, title, archived_at AS archivedAt, queue_paused AS queuePaused, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?',
    id, user.id,
  )
  if (!row) fail(404, 'Session not found')
  return row
}

function tokenCount(value: unknown, fallbackText = ''): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return Math.ceil(fallbackText.length / 4)
}

function numericId(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) fail(404, 'Resource not found')
  return value
}

type ReferenceImage = {
  dataUrl: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  mode: 'edit' | 'reference'
  bytes: number
  content: Buffer
}

type GenerationSize = 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
const defaultDirectGenerationSize: Exclude<GenerationSize, 'auto'> = '1536x1024'

function isGenerationSize(value: unknown): value is GenerationSize {
  return value === 'auto' || value === '1024x1024' || value === '1024x1536' || value === '1536x1024'
}

type QueuedGenerationRow = {
  id: string
  prompt: string
  size: GenerationSize
  translationEnabled: number
  imageMode: 'generation' | 'edit' | 'reference'
  referenceImage: string | null
  referenceImageBytes: number
  createdAt: string
  updatedAt: string
}

function queueItemPayload(row: QueuedGenerationRow): Record<string, unknown> {
  return {
    id: row.id,
    prompt: row.prompt,
    size: row.size,
    translationEnabled: Boolean(row.translationEnabled),
    referenceMode: row.imageMode === 'reference' ? 'reference' : 'edit',
    hasReference: Boolean(row.referenceImage),
    referenceImageBytes: row.referenceImageBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function parseReferenceImage(value: unknown): ReferenceImage | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(400, 'Reference image format is invalid')
  const input = value as Record<string, unknown>
  if (input.mode !== 'edit' && input.mode !== 'reference') fail(400, 'Reference image purpose is invalid')
  if (typeof input.dataUrl !== 'string') fail(400, 'Reference image format is invalid')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl)
  if (!match) fail(400, 'Reference image must be PNG, JPEG, or WebP')
  const mediaType = match[1] as ReferenceImage['mediaType']
  const encoded = match[2]
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.toString('base64') !== encoded) fail(400, 'Reference image encoding is invalid')
  if (bytes.length > maxReferenceImageBytes) fail(413, 'Reference image must not exceed 10 MiB')
  const validSignature = mediaType === 'image/png'
    ? bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12
        && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!validSignature) fail(400, 'Reference image content does not match its declared format')
  return { dataUrl: input.dataUrl, mediaType, mode: input.mode, bytes: bytes.length, content: bytes }
}

async function loadPreviousOutputReference(
  userId: string,
  imagePath: string | null,
  mediaType: string | null,
): Promise<ReferenceImage | undefined> {
  if (!imagePath || !mediaType) return undefined
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp') return undefined
  const resolvedImage = resolve(imagePath)
  const userRoot = resolve(imageDir, userId) + sep
  if (!resolvedImage.startsWith(userRoot)) return undefined
  try {
    const content = await readFile(resolvedImage)
    if (content.length > maxReferenceImageBytes) return undefined
    const dataUrl = `data:${mediaType};base64,${content.toString('base64')}`
    return parseReferenceImage({ dataUrl, mode: 'edit' })
  } catch {
    return undefined
  }
}

async function translatePrompt(
  prompt: string,
  config: ProviderConfig,
  previousTurn?: { prompt: string, translatedPrompt: string },
  signal?: AbortSignal,
  referenceMode?: ReferenceImage['mode'],
  referenceImage?: ReferenceImage,
  firstConversationTurn = false,
): Promise<{ translated: string, title: string, sessionTitle: string, input: number, output: number }> {
  if (!config.translation.apiKey) fail(409, 'The administrator has not configured a prompt-model API key')
  const base = cleanBaseUrl(config.translation.baseUrl, defaultTranslationBaseUrl)
  const instructions = config.translation.systemPrompt.trim() || await readFile(join(root, 'AGENT.md'), 'utf8')
  const outputContract = firstConversationTurn
    ? '\n\nThe host also needs metadata for this first request in a new session. Return exactly these three sections, with no Markdown fences or extra commentary:\nSESSION_TITLE: a concise title for the conversation, 3-8 words\nTITLE: a concise descriptive image title, 3-8 words\nPROMPT: the final English image-generation prompt\nSESSION_TITLE and TITLE are metadata only and must not be included in the PROMPT.'
    : '\n\nThe host also needs a short filename for the generated image. Return exactly these two sections, with no Markdown fences or extra commentary:\nTITLE: a concise descriptive image title, 3-8 words\nPROMPT: the final English image-generation prompt\nThe TITLE is metadata only and must not be included in the PROMPT.'
  const modeContext = referenceMode === 'edit'
    ? '\n\nThe host attached one image as the explicit edit target. Treat the current request as an image edit, preserve every unmentioned visual attribute, and describe only the requested changes.'
    : referenceMode === 'reference'
      ? '\n\nThe host attached one image as a visual reference, not as an edit target. Treat the current request as reference-guided generation; use the image for the attributes the user names and do not assume it must be copied wholesale.'
      : ''
  const currentContent = referenceImage
    ? [
        { type: 'text' as const, text: prompt },
        { type: 'image_url' as const, image_url: { url: referenceImage.dataUrl } },
      ]
    : prompt
  const messages = [
    { role: 'system', content: `${instructions}${modeContext}${outputContract}` },
    ...(previousTurn ? [
      { role: 'user', content: previousTurn.prompt },
      { role: 'assistant', content: previousTurn.translatedPrompt },
    ] : []),
    { role: 'user', content: currentContent },
  ]
  const response = await providerJson(`${base}/chat/completions`, config.translation.apiKey, {
    model: config.translation.model,
    temperature: 0.35,
    messages,
  }, signal)
  const choices = response.choices
  const first = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined
  const message = first?.message as Record<string, unknown> | undefined
  const content = message?.content
  const rawOutput = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content)
      ? content.filter((item): item is { text: string } => typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string').map(item => item.text).join('\n').trim()
      : ''
  const parsedOutput = parseTranslationOutput(rawOutput)
  const translated = parsedOutput.translated
  if (!translated || translated.length > 12_000) throw new Error('translation-invalid-output')
  const usage = response.usage as Record<string, unknown> | undefined
  const tokenInput = messages.map(message => typeof message.content === 'string'
    ? message.content
    : message.content.map(part => part.type === 'text' ? part.text : '[image]').join('\n')).join('\n')
  return {
    translated,
    title: parsedOutput.title,
    sessionTitle: parsedOutput.sessionTitle,
    input: tokenCount(usage?.prompt_tokens ?? usage?.input_tokens, tokenInput),
    output: tokenCount(usage?.completion_tokens ?? usage?.output_tokens, rawOutput),
  }
}

async function generateImage(
  prompt: string,
  config: ProviderConfig,
  size: Exclude<GenerationSize, 'auto'> | 'auto',
  referenceImage?: ReferenceImage,
  signal?: AbortSignal,
  onImageRequest?: () => void,
  onUsage?: (input: number, output: number) => void,
): Promise<{
  bytes: Buffer
  mediaType: string
  extension: string
  width: number
  height: number
  revisedPrompt: string
  imageModel: string
  fallbackFrom: string | null
  input: number
  output: number
}> {
  if (!config.image.apiKey) fail(409, 'The administrator has not configured an image-model API key')
  const base = cleanBaseUrl(config.image.baseUrl, defaultImageBaseUrl)
  const endpoint = referenceImage ? 'edits' : 'generations'
  const payload = referenceImage
    ? {
        model: config.image.model,
        prompt,
        images: [{ image_url: referenceImage.dataUrl }],
        n: 1,
      }
    : {
        model: config.image.model,
        prompt,
        size,
        n: 1,
      }
  let selectedModel = config.image.model
  let fallbackFrom: string | null = null
  let response: Record<string, unknown>
  try {
    onImageRequest?.()
    response = await providerJson(`${base}/images/${endpoint}`, config.image.apiKey, payload, signal)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'provider-http-404') throw error
    const available = await providerModels(base, config.image.apiKey, signal)
    if (available.includes(config.image.model)) throw new Error('image-generation-endpoint-not-found')
    const fallbacks: Record<string, string[]> = {
      'gpt-image-2.6': ['gpt-image-2.5', 'gpt-image-2'],
      'gpt-image-2.5': ['gpt-image-2'],
    }
    const nextModel = (fallbacks[config.image.model] ?? []).find(model => available.includes(model))
    if (!nextModel) throw new Error('image-model-unavailable')
    onImageRequest?.()
    response = await providerJson(`${base}/images/${endpoint}`, config.image.apiKey, { ...payload, model: nextModel }, signal)
    selectedModel = nextModel
    fallbackFrom = config.image.model
  }
  const usage = response.usage as Record<string, unknown> | undefined
  const input = tokenCount(usage?.input_tokens)
  const output = tokenCount(usage?.output_tokens)
  onUsage?.(input, output)
  const data = response.data
  const first = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined
  const encoded = first?.b64_json
  if (typeof encoded !== 'string' || encoded.length < 32 || encoded.length > maxProviderResponseBytes * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('image-provider-did-not-return-base64')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > 18 * 1024 * 1024) throw new Error('generated-image-too-large')
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    bytes.length < 33
    || !bytes.subarray(0, 8).equals(signature)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) throw new Error('generated-image-format-not-supported')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 80_000_000) {
    throw new Error('generated-image-dimensions-invalid')
  }
  if (
    (first?.width !== undefined && asFiniteNumber(first.width, -1) !== width)
    || (first?.height !== undefined && asFiniteNumber(first.height, -1) !== height)
  ) throw new Error('generated-image-dimension-mismatch')
  return {
    bytes,
    mediaType: 'image/png',
    extension: 'png',
    width,
    height,
    revisedPrompt: typeof first?.revised_prompt === 'string' ? first.revised_prompt.slice(0, 12_000) : '',
    imageModel: selectedModel,
    fallbackFrom,
    input,
    output,
  }
}

function generationCost(
  config: ProviderConfig,
  translationInput: number,
  translationOutput: number,
  imageInput: number,
  imageOutput: number,
  imageCallStarted: boolean,
): { translationTokenCostUsd: number, imageTokenCostUsd: number, imageRequestCostUsd: number, costUsd: number } {
  const translationTokenCostUsd = (
    translationInput * config.translation.inputPricePerMillion
    + translationOutput * config.translation.outputPricePerMillion
  ) / 1_000_000
  const imageTokenCostUsd = (
    imageInput * config.image.inputPricePerMillion
    + imageOutput * config.image.outputPricePerMillion
  ) / 1_000_000
  const imageRequestCostUsd = imageCallStarted ? config.image.costPerImage : 0
  const costUsd = Number((translationTokenCostUsd + imageTokenCostUsd + imageRequestCostUsd).toFixed(8))
  return { translationTokenCostUsd, imageTokenCostUsd, imageRequestCostUsd, costUsd }
}

function startLoginSession(res: ServerResponse, userId: string): void {
  const token = randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + sessionLifetime).toISOString()
  dbRun('INSERT INTO login_sessions(id_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)', hash(token), userId, expires, now())
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('set-cookie', `atelier_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`)
}

function ensureSameOrigin(req: IncomingMessage): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) return
  const origin = req.headers.origin
  if (!origin) return
  try {
    if (new URL(origin).host !== req.headers.host) fail(403, 'Cross-site request rejected')
  } catch {
    fail(403, 'Request origin is invalid')
  }
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'internal-error'
  if (/^provider-http-\d{3}$/.test(value)) return value
  if (value === 'AbortError' || value === 'TimeoutError') return 'provider-timeout'
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'generation-failed'
}

function modelFeedback(error: unknown): string {
  if (error instanceof ProviderRequestError) return error.providerFeedback
  return ''
}

type AuditLogFilters = {
  limit: number
  before?: number
  email: string
  event: string
  status: '' | 'success' | 'failure'
}

function parseAuditLogFilters(url: URL, maxLimit: number, defaultLimit = 100): AuditLogFilters {
  const requestedLimit = Number(url.searchParams.get('limit') ?? defaultLimit)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) fail(400, 'Log limit is invalid')
  const limit = Math.min(requestedLimit, maxLimit)
  const rawBefore = url.searchParams.get('before')
  const before = rawBefore === null ? undefined : Number(rawBefore)
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) fail(400, 'Log cursor is invalid')
  const email = url.searchParams.get('email')?.trim() ?? ''
  const event = url.searchParams.get('event')?.trim() ?? ''
  const status = url.searchParams.get('status') ?? ''
  if (email.length > 254 || event.length > 120) fail(400, 'Log filter is too long')
  if (status && status !== 'success' && status !== 'failure') fail(400, 'Log status filter is invalid')
  return { limit, before, email, event, status: status as AuditLogFilters['status'] }
}

function queryAuditLogs(filters: AuditLogFilters): Record<string, unknown>[] {
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (filters.before !== undefined) {
    where.push('id < ?')
    params.push(filters.before)
  }
  if (filters.email) {
    where.push("lower(COALESCE(email, '')) LIKE lower(?) ESCAPE '\\'")
    params.push(`%${filters.email.replace(/[\\%_]/g, '\\$&')}%`)
  }
  if (filters.event) {
    where.push("event LIKE ? ESCAPE '\\'")
    params.push(`%${filters.event.replace(/[\\%_]/g, '\\$&')}%`)
  }
  if (filters.status) {
    where.push('status = ?')
    params.push(filters.status)
  }
  params.push(filters.limit)
  return dbAll<Record<string, unknown>>(
    `SELECT id, request_id AS requestId, user_id AS userId, email, event, status, details_json AS details,
      ip_hash AS ipHash, created_at AS createdAt
     FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?`,
    ...params,
  ).map(row => ({ ...row, details: JSON.parse(String(row.details)) }))
}

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return `"${text.replace(/"/g, '""')}"`
}

function auditLogsCsv(rows: Record<string, unknown>[]): string {
  const headers = ['ID', 'Request ID', 'User ID', 'Email', 'Event', 'Status', 'Details', 'IP Hash', 'Created At']
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push([
      row.id,
      row.requestId,
      row.userId,
      row.email,
      row.event,
      row.status,
      row.details,
      row.ipHash,
      row.createdAt,
    ].map(csvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, request: string): Promise<void> {
  const method = req.method ?? 'GET'
  const pathname = url.pathname
  const user = await authenticatedUser(req)
  ensureSameOrigin(req)

  if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { status: 'ok' })

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req)
    const email = validateEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    const ip = req.socket.remoteAddress ?? 'unknown'
    const bucket = hash(`${email}:${ip}`)
    const lock = dbGet<{ attempts: number, reset_at: string }>('SELECT attempts, reset_at FROM login_failures WHERE bucket = ?', bucket)
    if (lock && Date.parse(lock.reset_at) > Date.now() && lock.attempts >= 8) fail(429, 'Too many login attempts. Please try again in 15 minutes.')
    const account = dbGet<{ id: string, email: string, role: Role, active: number, password_hash: string }>(
      'SELECT id, email, role, active, password_hash FROM users WHERE email = ?',
      email,
    )
    const valid = account && account.active === 1 && await verifyPassword(password, account.password_hash)
    if (!valid || !account) {
      const resetAt = lock && Date.parse(lock.reset_at) > Date.now()
        ? lock.reset_at
        : new Date(Date.now() + 15 * 60_000).toISOString()
      dbRun(
        `INSERT INTO login_failures(bucket, attempts, reset_at) VALUES(?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN login_failures.reset_at > ? THEN attempts + 1 ELSE 1 END, reset_at = ?`,
        bucket, resetAt, now(), resetAt,
      )
      writeAudit(req, request, undefined, 'auth.login', 'failure', { email })
      fail(401, 'Email or password is incorrect')
    }
    dbRun('DELETE FROM login_failures WHERE bucket = ?', bucket)
    dbRun('UPDATE users SET last_login_at = ? WHERE id = ?', now(), account.id)
    startLoginSession(res, account.id)
    writeAudit(req, request, { id: account.id, email: account.email, role: account.role }, 'auth.login', 'success')
    return sendJson(res, 200, { user: { id: account.id, email: account.email, role: account.role } })
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const current = requireUser(user)
    const token = parseCookies(req).get('atelier_session')
    if (token) dbRun('DELETE FROM login_sessions WHERE id_hash = ?', hash(token))
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
    res.setHeader('set-cookie', `atelier_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`)
    writeAudit(req, request, current, 'auth.logout', 'success')
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: 'Please sign in first' })
  }

  if (method === 'GET' && pathname === '/api/sessions') {
    const current = requireUser(user)
    const archived = url.searchParams.get('archived')
    if (archived !== null && archived !== 'true' && archived !== 'false') fail(400, 'Archive filter is invalid')
    const rawQuery = url.searchParams.get('q')
    if (rawQuery !== null && (rawQuery.length > 120 || rawQuery.includes('\0'))) fail(400, 'Search content is invalid')
    const query = rawQuery?.trim() ?? ''
    const searchClause = query
      ? `AND (
          c.title LIKE ? ESCAPE '!'
          OR EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id AND m.user_id = c.user_id AND m.content LIKE ? ESCAPE '!'
          )
        )`
      : ''
    const searchPattern = `%${query.replace(/[!%_]/g, '!$&')}%`
    const rows = dbAll<Record<string, unknown>>(
      `SELECT c.id, c.title, c.archived_at AS archivedAt, c.created_at AS createdAt, c.updated_at AS updatedAt,
        EXISTS(
          SELECT 1 FROM generations g
          WHERE g.conversation_id = c.id AND g.user_id = c.user_id AND g.status = 'pending'
        ) AS running,
        (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS lastMessage
       FROM conversations c
       WHERE c.user_id = ? AND ${archived === 'true' ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL'}
         ${searchClause}
       ORDER BY c.updated_at DESC`,
      ...(query ? [current.id, searchPattern, searchPattern] : [current.id]),
    )
    return sendJson(res, 200, rows.map(row => ({ ...row, running: Boolean(row.running) })))
  }

  if (method === 'POST' && pathname === '/api/sessions') {
    const current = requireUser(user)
    const id = randomUUID()
    const time = now()
    dbRun('INSERT INTO conversations(id, user_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)', id, current.id, 'New session', time, time)
    writeAudit(req, request, current, 'session.created', 'success', { sessionId: id })
    return sendJson(res, 201, { id, title: 'New session', archivedAt: null, createdAt: time, updatedAt: time, lastMessage: null, running: false })
  }

  const queueMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/queue$/i)
  if (queueMatch) {
    const current = requireUser(user)
    const conversationId = numericId(queueMatch[1])
    const conversation = sessionOwnedBy(conversationId, current)
    if (method === 'GET') {
      const items = dbAll<QueuedGenerationRow>(
        `SELECT id, prompt, size, translation_enabled AS translationEnabled,
          image_mode AS imageMode, reference_image AS referenceImage,
          reference_image_bytes AS referenceImageBytes, created_at AS createdAt, updated_at AS updatedAt
         FROM generation_queue WHERE conversation_id = ? AND user_id = ? ORDER BY queue_order ASC`,
        conversationId, current.id,
      )
      return sendJson(res, 200, { items: items.map(queueItemPayload), paused: Boolean(conversation.queuePaused) })
    }
    if (method === 'POST') {
      if (conversation.archivedAt) fail(409, 'Archived sessions are read-only. Restore the session before queueing.')
      const body = await readJson(req, maxGenerationBodyBytes)
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt || prompt.length > 4000) fail(400, 'Description must be 1 to 4000 characters')
      const size = body.size === undefined ? 'auto' : body.size
      if (!isGenerationSize(size)) fail(400, 'Image size option is invalid')
      const referenceImage = parseReferenceImage(body.referenceImage)
      const translationEnabled = body.translationEnabled === undefined
        ? true
        : typeof body.translationEnabled === 'boolean'
          ? body.translationEnabled
          : fail(400, 'Prompt-model toggle is invalid')
      const id = randomUUID()
      const createdAt = now()
      database.exec('BEGIN IMMEDIATE')
      try {
        const count = dbGet<{ count: number }>(
          'SELECT COUNT(*) AS count FROM generation_queue WHERE conversation_id = ? AND user_id = ?',
          conversationId, current.id,
        )?.count ?? 0
        if (count >= maxQueuedGenerations) fail(409, 'The current session queue is full. Please wait for existing requests to finish.')
        dbRun(
          `INSERT INTO generation_queue(id, conversation_id, user_id, prompt, size, translation_enabled, image_mode,
            reference_image, reference_image_bytes, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, conversationId, current.id, prompt, size, translationEnabled ? 1 : 0, referenceImage?.mode ?? 'generation',
          referenceImage ? seal(referenceImage.dataUrl) : null, referenceImage?.bytes ?? 0, createdAt, createdAt,
        )
        dbRun('UPDATE conversations SET queue_paused = 0, updated_at = ? WHERE id = ? AND user_id = ?', createdAt, conversationId, current.id)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      const item: QueuedGenerationRow = {
        id,
        prompt,
        size: size as GenerationSize,
        translationEnabled: translationEnabled ? 1 : 0,
        imageMode: referenceImage?.mode ?? 'generation',
        referenceImage: referenceImage ? 'encrypted' : null,
        referenceImageBytes: referenceImage?.bytes ?? 0,
        createdAt,
        updatedAt: createdAt,
      }
      writeAudit(req, request, current, 'generation.queue_enqueued', 'success', {
        sessionId: conversationId, queueItemId: id, size, imageMode: item.imageMode,
        translationEnabled,
        referenceImageBytes: item.referenceImageBytes,
      })
      return sendJson(res, 201, queueItemPayload(item))
    }
  }

  const queuedReferenceMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/queue\/([0-9a-f-]{36})\/reference$/i)
  if (method === 'GET' && queuedReferenceMatch) {
    const current = requireUser(user)
    const conversationId = numericId(queuedReferenceMatch[1])
    const queueItemId = numericId(queuedReferenceMatch[2])
    sessionOwnedBy(conversationId, current)
    const item = dbGet<{ referenceImage: string | null }>(
      'SELECT reference_image AS referenceImage FROM generation_queue WHERE id = ? AND conversation_id = ? AND user_id = ?',
      queueItemId, conversationId, current.id,
    )
    if (!item?.referenceImage) fail(404, 'Queue item has no reference image')
    return sendJson(res, 200, { dataUrl: unseal(item.referenceImage) })
  }

  const queueItemMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/queue\/([0-9a-f-]{36})$/i)
  if (queueItemMatch) {
    const current = requireUser(user)
    const conversationId = numericId(queueItemMatch[1])
    const queueItemId = numericId(queueItemMatch[2])
    const conversation = sessionOwnedBy(conversationId, current)
    if (method === 'PATCH') {
      if (conversation.archivedAt) fail(409, 'Archived sessions are read-only. Restore the session before editing the queue.')
      const body = await readJson(req, maxGenerationBodyBytes)
      const existing = dbGet<QueuedGenerationRow>(
        `SELECT id, prompt, size, translation_enabled AS translationEnabled,
          image_mode AS imageMode, reference_image AS referenceImage,
          reference_image_bytes AS referenceImageBytes, created_at AS createdAt, updated_at AS updatedAt
         FROM generation_queue WHERE id = ? AND conversation_id = ? AND user_id = ?`,
        queueItemId, conversationId, current.id,
      )
      if (!existing) fail(404, 'Queue item not found')
      const prompt = body.prompt === undefined ? existing.prompt : typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt || prompt.length > 4000) fail(400, 'Description must be 1 to 4000 characters')
      const size = body.size === undefined ? existing.size : body.size
      if (!isGenerationSize(size)) fail(400, 'Image size option is invalid')
      const translationEnabled = body.translationEnabled === undefined
        ? Boolean(existing.translationEnabled)
        : typeof body.translationEnabled === 'boolean'
          ? body.translationEnabled
          : fail(400, 'Prompt-model toggle is invalid')
      let referenceImage = existing.referenceImage
      let imageMode = existing.imageMode
      let referenceImageBytes = existing.referenceImageBytes
      if (Object.hasOwn(body, 'referenceImage')) {
        if (body.referenceImage === null) {
          referenceImage = null
          imageMode = 'generation'
          referenceImageBytes = 0
        } else {
          const parsed = parseReferenceImage(body.referenceImage)
          if (!parsed) fail(400, 'Reference image format is invalid')
          referenceImage = seal(parsed.dataUrl)
          imageMode = parsed.mode
          referenceImageBytes = parsed.bytes
        }
      }
      const updatedAt = now()
      dbRun(
        `UPDATE generation_queue SET prompt = ?, size = ?, translation_enabled = ?, image_mode = ?, reference_image = ?,
          reference_image_bytes = ?, updated_at = ?
         WHERE id = ? AND conversation_id = ? AND user_id = ?`,
        prompt, size, translationEnabled ? 1 : 0, imageMode, referenceImage, referenceImageBytes, updatedAt,
        queueItemId, conversationId, current.id,
      )
      writeAudit(req, request, current, 'generation.queue_updated', 'success', {
        sessionId: conversationId, queueItemId, size, imageMode, referenceImageBytes, translationEnabled,
      })
      return sendJson(res, 200, queueItemPayload({
        id: queueItemId, prompt, size: size as GenerationSize, translationEnabled: translationEnabled ? 1 : 0, imageMode, referenceImage,
        referenceImageBytes, createdAt: existing.createdAt, updatedAt,
      }))
    }
    if (method === 'DELETE') {
      if (conversation.archivedAt) fail(409, 'Archived sessions are read-only. Restore the session before editing the queue.')
      const result = database.prepare(
        'DELETE FROM generation_queue WHERE id = ? AND conversation_id = ? AND user_id = ?',
      ).run(queueItemId, conversationId, current.id)
      if (!Number(result.changes)) fail(404, 'Queue item not found')
      writeAudit(req, request, current, 'generation.queue_removed', 'success', { sessionId: conversationId, queueItemId })
      return sendJson(res, 200, { ok: true })
    }
  }

  const conversationMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/i)
  if (method === 'GET' && conversationMatch) {
    const current = requireUser(user)
    const conversationId = numericId(conversationMatch[1])
    sessionOwnedBy(conversationId, current)
    const select = `SELECT m.id, m.role, m.content, m.created_at AS createdAt, m.generation_id AS generationId,
      m.image_mode AS messageImageMode, m.reference_image_bytes AS messageReferenceImageBytes,
      g.translated_prompt AS translatedPrompt, g.status AS generationStatus,
      g.prompt AS originalPrompt, g.revised_prompt AS revisedPrompt,
      g.model_feedback AS modelFeedback, g.image_name AS imageName,
      g.image_width AS imageWidth, g.image_height AS imageHeight,
      g.image_mode AS generationImageMode, g.reference_image_bytes AS generationReferenceImageBytes,
      g.input_image_path AS inputImagePath, g.input_media_type AS inputMediaType,
      g.image_size AS imageSize,
      g.image_model AS imageModel, g.requested_image_model AS requestedImageModel,
      g.translation_model AS translationModel,
      g.translation_enabled AS translationEnabled,
      g.translation_input_tokens AS translationInputTokens,
      g.translation_output_tokens AS translationOutputTokens,
      g.image_input_tokens AS imageInputTokens,
      g.image_output_tokens AS imageOutputTokens,
      g.cost_usd AS costUsd, g.duration_ms AS durationMs,
      g.translation_token_cost_usd AS translationTokenCostUsd,
      g.image_token_cost_usd AS imageTokenCostUsd,
      g.image_request_cost_usd AS imageRequestCostUsd,
      g.error_code AS errorCode
     FROM messages m LEFT JOIN generations g ON g.id = m.generation_id`
    const rawLimit = url.searchParams.get('limit')
    const rawBefore = url.searchParams.get('before')
    const requestedLimit = Number(rawLimit ?? 50)
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) fail(400, 'Message limit is invalid')
    const limit = Math.min(requestedLimit, 100)
    let before: MessageCursor | undefined
    if (rawBefore !== null) {
      before = decodeMessageCursor(rawBefore) ?? undefined
      if (!before) fail(400, 'Message cursor is invalid')
    }
    const where = [
      'm.conversation_id = ?',
      'm.user_id = ?',
      ...(before ? ['(m.created_at < ? OR (m.created_at = ? AND m.id < ?))'] : []),
    ]
    const params: SQLInputValue[] = [conversationId, current.id]
    if (before) params.push(before.createdAt, before.createdAt, before.id)
    params.push(limit + 1)
    const rows = dbAll<Record<string, unknown>>(
      `${select} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      ...params,
    )
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).reverse().map(messagePayload)
    const oldest = items[0]
    return sendJson(res, 200, {
      items,
      hasMore,
      nextCursor: hasMore && oldest
        ? encodeMessageCursor({ createdAt: String(oldest.createdAt), id: String(oldest.id) })
        : null,
    })
  }

  const titleMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/i)
  if (method === 'DELETE' && titleMatch) {
    const current = requireUser(user)
    const conversationId = numericId(titleMatch[1])
    const conversation = sessionOwnedBy(conversationId, current)
    if (activeGenerations.has(conversationId)) {
      fail(409, 'The session still has a generation in progress. Stop it or wait for it to finish before deleting.')
    }
    const pending = dbGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM generations WHERE conversation_id = ? AND user_id = ? AND status = ?',
      conversationId, current.id, 'pending',
    )
    if (Number(pending?.count ?? 0) > 0) {
      fail(409, 'The session still has a generation in progress. Stop it or wait for it to finish before deleting.')
    }
    const deleted = database.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(conversationId, current.id)
    if (!Number(deleted.changes)) fail(404, 'Session not found')
    const imageRoot = resolve(imageDir, current.id, conversationId)
    const userRoot = resolve(imageDir, current.id) + sep
    if (!imageRoot.startsWith(userRoot)) fail(404, 'Session not found')
    await rm(imageRoot, { recursive: true, force: true }).catch(() => undefined)
    writeAudit(req, request, current, 'session.deleted', 'success', {
      sessionId: conversationId,
      title: String(conversation.title),
    })
    return sendJson(res, 200, { ok: true, id: conversationId })
  }
  if (method === 'PATCH' && titleMatch) {
    const current = requireUser(user)
    const conversationId = numericId(titleMatch[1])
    const conversation = sessionOwnedBy(conversationId, current)
    const body = await readJson(req)
    const title = body.title === undefined
      ? String(conversation.title)
      : typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
    if (!title) fail(400, 'Title cannot be empty')
    if (body.archived !== undefined && typeof body.archived !== 'boolean') fail(400, 'Archive status is invalid')
    if (body.title === undefined && body.archived === undefined) fail(400, 'There is no session content to update')
    const archived = body.archived === undefined ? Boolean(conversation.archivedAt) : body.archived
    if (body.archived === true && activeGenerations.has(conversationId)) {
      fail(409, 'The session still has a generation in progress. Stop it or wait for it to finish before archiving.')
    }
    const archivedAt = archived ? (conversation.archivedAt as string | null) ?? now() : null
    dbRun(
      'UPDATE conversations SET title = ?, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      title, archivedAt, now(), conversationId, current.id,
    )
    const event = body.archived === undefined
      ? 'session.renamed'
      : archived ? 'session.archived' : 'session.restored'
    writeAudit(req, request, current, event, 'success', { sessionId: conversationId })
    return sendJson(res, 200, { id: conversationId, title, archivedAt })
  }

  const cancelMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/cancel$/i)
  if (method === 'POST' && cancelMatch) {
    const current = requireUser(user)
    const conversationId = numericId(cancelMatch[1])
    sessionOwnedBy(conversationId, current)
    const active = activeGenerations.get(conversationId)
    if (!active || active.userId !== current.id) {
      return sendJson(res, 409, { error: 'The current session has no active generation', code: 'generation-not-active' })
    }
    active.controller.abort()
    dbRun('UPDATE conversations SET queue_paused = 1 WHERE id = ? AND user_id = ?', conversationId, current.id)
    writeAudit(req, request, current, 'generation.cancel_requested', 'success', {
      sessionId: conversationId,
      generationId: active.generationId,
    })
    return sendJson(res, 202, { ok: true, generationId: active.generationId })
  }

  const generateMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/generate$/i)
  if (method === 'POST' && generateMatch) {
    const current = requireUser(user)
    const conversationId = numericId(generateMatch[1])
    const conversation = sessionOwnedBy(conversationId, current)
    if (conversation.archivedAt) fail(409, 'Archived sessions are read-only. Restore the session before generating.')
    const body = await readJson(req, maxGenerationBodyBytes)
    const queueItemId = body.queueItemId === undefined ? undefined : numericId(typeof body.queueItemId === 'string' ? body.queueItemId : undefined)
    const queued = queueItemId
      ? dbGet<QueuedGenerationRow>(
          `SELECT id, prompt, size, translation_enabled AS translationEnabled,
            image_mode AS imageMode, reference_image AS referenceImage,
            reference_image_bytes AS referenceImageBytes, created_at AS createdAt, updated_at AS updatedAt
           FROM generation_queue WHERE id = ? AND conversation_id = ? AND user_id = ?`,
          queueItemId, conversationId, current.id,
        )
      : undefined
    if (queueItemId && !queued) fail(409, 'The queue item was handled or removed by another tab')
    const prompt = queued?.prompt ?? (typeof body.prompt === 'string' ? body.prompt.trim() : '')
    if (!prompt || prompt.length > 4000) fail(400, 'Description must be 1 to 4000 characters')
    const providedReferenceImage = queued?.referenceImage
      ? parseReferenceImage({ dataUrl: unseal(queued.referenceImage), mode: queued.imageMode })
      : queued ? undefined : parseReferenceImage(body.referenceImage)
    const translationEnabled = queued
      ? Boolean(queued.translationEnabled)
      : body.translationEnabled === undefined
        ? true
        : typeof body.translationEnabled === 'boolean'
          ? body.translationEnabled
          : fail(400, 'Prompt-model toggle is invalid')
    const size = queued?.size ?? (body.size === undefined ? 'auto' : body.size)
    if (!isGenerationSize(size)) fail(400, 'Image size option is invalid')
    const providerSize = size === 'auto' && !translationEnabled ? defaultDirectGenerationSize : size
    if (activeGenerations.has(conversationId)) {
      fail(409, 'The current session already has a generation in progress')
    }

    const existingMessageCount = dbGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND user_id = ?',
      conversationId, current.id,
    )?.count ?? 0
    const firstConversationTurn = existingMessageCount === 0
    const config = readProviders()
    const previousGeneration = dbGet<{
      prompt: string
      translatedPrompt: string
      imagePath: string | null
      mediaType: string | null
    }>(
      `SELECT prompt, translated_prompt AS translatedPrompt,
        image_path AS imagePath, media_type AS mediaType
       FROM generations
       WHERE conversation_id = ? AND user_id = ? AND status = 'succeeded' AND translated_prompt IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
      conversationId, current.id,
    )
    const previousTurn = previousGeneration
      ? { prompt: previousGeneration.prompt, translatedPrompt: previousGeneration.translatedPrompt }
      : undefined
    const previousImage = translationEnabled && !providedReferenceImage
      ? await loadPreviousOutputReference(current.id, previousGeneration?.imagePath ?? null, previousGeneration?.mediaType ?? null)
      : undefined
    const referenceImage = providedReferenceImage ?? previousImage
    const generationId = randomUUID()
    const pendingMessageId = randomUUID()
    const startedAt = Date.now()
    const createdAt = now()
    const requestModel = {
      image: config.image.model,
      translation: translationEnabled ? config.translation.model : 'Skipped',
    }
    let inputImagePath: string | null = null
    if (referenceImage) {
      const inputDir = join(imageDir, current.id, conversationId)
      await mkdir(inputDir, { recursive: true })
      const inputExtension = referenceImage.mediaType === 'image/jpeg'
        ? 'jpg'
        : referenceImage.mediaType === 'image/webp' ? 'webp' : 'png'
      inputImagePath = join(inputDir, `${generationId}-input.${inputExtension}`)
      await writeFile(inputImagePath, referenceImage.content, { flag: 'wx', mode: 0o600 })
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      dbRun(
        `INSERT INTO generations(id, conversation_id, user_id, prompt, status, image_model, requested_image_model,
          translation_model, translation_enabled, image_mode, image_size, input_image_path, input_media_type,
          reference_image_bytes, request_id, created_at)
         VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        generationId, conversationId, current.id, prompt, requestModel.image, requestModel.image,
        requestModel.translation, translationEnabled ? 1 : 0, referenceImage?.mode ?? 'generation', providerSize,
        inputImagePath, referenceImage?.mediaType ?? null, referenceImage?.bytes ?? 0, request, createdAt,
      )
      dbRun(
        `INSERT INTO messages(id, conversation_id, user_id, role, content, image_mode, reference_image_bytes, generation_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), conversationId, current.id, 'user', prompt,
        referenceImage?.mode ?? 'generation', referenceImage?.bytes ?? 0, generationId, createdAt,
      )
      dbRun(
        `INSERT INTO messages(id, conversation_id, user_id, role, content, generation_id, created_at)
         VALUES(?, ?, ?, 'assistant', ?, ?, ?)`,
        pendingMessageId, conversationId, current.id, 'Processing your image request...', generationId, now(),
      )
      if (queueItemId) {
        const deleted = database.prepare(
          'DELETE FROM generation_queue WHERE id = ? AND conversation_id = ? AND user_id = ?',
        ).run(queueItemId, conversationId, current.id)
        if (!Number(deleted.changes)) fail(409, 'The queue item was handled or removed by another tab')
      }
      dbRun('UPDATE conversations SET updated_at = ? WHERE id = ?', createdAt, conversationId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      if (inputImagePath) await rm(inputImagePath, { force: true }).catch(() => undefined)
      throw error
    }
    writeAudit(req, request, current, 'generation.started', 'success', {
      sessionId: conversationId,
      generationId,
      imageModel: requestModel.image,
      translationModel: requestModel.translation,
      translationEnabled,
      promptCharacters: prompt.length,
      size: providerSize,
      requestedSize: size,
      imageMode: referenceImage?.mode ?? 'generation',
      referenceImageBytes: referenceImage?.bytes ?? 0,
    })

    const controller = new AbortController()
    const activeGeneration: ActiveGeneration = {
      userId: current.id,
      conversationId,
      generationId,
      controller,
    }
    activeGenerations.set(conversationId, activeGeneration)
    let translationInput = 0
    let translationOutput = 0
    let imageInput = 0
    let imageOutput = 0
    let imageCallStarted = false
    let imagePath: string | null = null
    try {
      assertGenerationActive(controller.signal)
      const translation = translationEnabled
        ? await translatePrompt(prompt, config, previousTurn, controller.signal, referenceImage?.mode, referenceImage, firstConversationTurn)
        : { translated: prompt, title: '', sessionTitle: '', input: 0, output: 0 }
      translationInput = translation.input
      translationOutput = translation.output
      if (firstConversationTurn) {
        const generatedSessionTitle = safeImageName(
          translation.sessionTitle || translation.title,
          prompt.slice(0, 100),
        )
        if (generatedSessionTitle && generatedSessionTitle !== 'New session') {
          dbRun(
            `UPDATE conversations
             SET title = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND title = 'New session'`,
            generatedSessionTitle, now(), conversationId, current.id,
          )
        }
      }
      writeAudit(req, request, current, translationEnabled ? 'generation.prompt_translated' : 'generation.prompt_translation_skipped', 'success', {
        generationId, model: requestModel.translation, translationEnabled, inputTokens: translationInput, outputTokens: translationOutput,
      })
      assertGenerationActive(controller.signal)
      const image = await generateImage(
        translation.translated,
        config,
        providerSize,
        referenceImage,
        controller.signal,
        () => { imageCallStarted = true },
        (input, output) => {
          imageInput = input
          imageOutput = output
        },
      )
      imageInput = image.input
      imageOutput = image.output
      assertGenerationActive(controller.signal)
      const userImageDir = join(imageDir, current.id, conversationId)
      await mkdir(userImageDir, { recursive: true })
      imagePath = join(userImageDir, `${generationId}.${image.extension}`)
      await writeFile(imagePath, image.bytes, { flag: 'wx', mode: 0o600 })
      assertGenerationActive(controller.signal)
      const durationMs = Date.now() - startedAt
      const cost = generationCost(config, translationInput, translationOutput, imageInput, imageOutput, imageCallStarted)
      const generatedImageName = safeImageName(translation.title, `Generate image-${generationId.slice(0, 8)}`)
      dbRun(
        `UPDATE generations SET translated_prompt = ?, image_name = ?, revised_prompt = ?, model_feedback = ?, image_width = ?, image_height = ?,
          image_model = ?,
          status = 'succeeded', image_path = ?, media_type = ?,
          translation_input_tokens = ?, translation_output_tokens = ?, image_input_tokens = ?, image_output_tokens = ?,
          cost_usd = ?, translation_token_cost_usd = ?, image_token_cost_usd = ?, image_request_cost_usd = ?,
          duration_ms = ? WHERE id = ? AND user_id = ?`,
        translation.translated, generatedImageName, image.revisedPrompt, image.revisedPrompt, image.width, image.height, image.imageModel, imagePath, image.mediaType,
        translationInput, translationOutput, imageInput, imageOutput,
        cost.costUsd, cost.translationTokenCostUsd, cost.imageTokenCostUsd, cost.imageRequestCostUsd,
        durationMs, generationId, current.id,
      )
      const resultText = [
        image.fallbackFrom
          ? `Image ${referenceImage ? 'processed' : 'generated'}, using fallback model ${image.imageModel}`
          : referenceImage ? 'Image processed' : 'Image generated',
        `Image model: ${image.imageModel}`,
        `Prompt model: ${translationEnabled ? requestModel.translation : 'Skipped'}`,
        ...(image.revisedPrompt ? [`Model feedback: ${image.revisedPrompt}`] : []),
      ].join('\n')
      dbRun(
        'UPDATE messages SET content = ? WHERE id = ? AND conversation_id = ? AND user_id = ?',
        resultText, pendingMessageId, conversationId, current.id,
      )
      dbRun('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?', now(), conversationId, current.id)
      writeAudit(req, request, current, 'generation.completed', 'success', {
        generationId,
        imageModel: image.imageModel,
        requestedImageModel: requestModel.image,
        fallbackFrom: image.fallbackFrom,
        translationModel: requestModel.translation,
        translationEnabled,
        translationInputTokens: translationInput,
        translationOutputTokens: translationOutput,
        imageInputTokens: imageInput,
        imageOutputTokens: imageOutput,
        costUsd: cost.costUsd,
        translationTokenCostUsd: cost.translationTokenCostUsd,
        imageTokenCostUsd: cost.imageTokenCostUsd,
        imageRequestCostUsd: cost.imageRequestCostUsd,
        durationMs,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        imageMode: referenceImage?.mode ?? 'generation',
        referenceImageBytes: referenceImage?.bytes ?? 0,
        outputBytes: image.bytes.length,
      })
      return sendJson(res, 200, {
        generationId,
        imageUrl: `/api/generations/${generationId}/image`,
        imageName: generatedImageName,
        prompt,
        imageMode: referenceImage?.mode ?? 'generation',
        referenceImageBytes: referenceImage?.bytes ?? 0,
        imageSize: providerSize,
        translatedPrompt: translation.translated,
        revisedPrompt: image.revisedPrompt,
        modelFeedback: image.revisedPrompt,
        imageModel: image.imageModel,
        requestedImageModel: requestModel.image,
        fallbackFrom: image.fallbackFrom,
        translationModel: requestModel.translation,
        translationEnabled,
        translationInputTokens: translationInput,
        translationOutputTokens: translationOutput,
        imageInputTokens: imageInput,
        imageOutputTokens: imageOutput,
        costUsd: cost.costUsd,
        translationTokenCostUsd: cost.translationTokenCostUsd,
        imageTokenCostUsd: cost.imageTokenCostUsd,
        imageRequestCostUsd: cost.imageRequestCostUsd,
        durationMs,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
      })
    } catch (error) {
      const cancelled = controller.signal.aborted
      const code = cancelled ? 'generation-cancelled' : errorCode(error)
      const feedback = cancelled ? '' : modelFeedback(error)
      const durationMs = Date.now() - startedAt
      const cost = generationCost(config, translationInput, translationOutput, imageInput, imageOutput, imageCallStarted)
      if (imagePath) await rm(imagePath, { force: true }).catch(() => undefined)
      if (inputImagePath) await rm(inputImagePath, { force: true }).catch(() => undefined)
      dbRun(
        `UPDATE generations SET status = 'failed', model_feedback = ?, input_image_path = NULL, input_media_type = NULL,
          translation_input_tokens = ?, translation_output_tokens = ?,
          image_input_tokens = ?, image_output_tokens = ?, cost_usd = ?, translation_token_cost_usd = ?,
          image_token_cost_usd = ?, image_request_cost_usd = ?, duration_ms = ?, error_code = ?
         WHERE id = ? AND user_id = ?`,
        feedback, translationInput, translationOutput, imageInput, imageOutput, cost.costUsd,
        cost.translationTokenCostUsd, cost.imageTokenCostUsd, cost.imageRequestCostUsd,
        durationMs, code, generationId, current.id,
      )
      const failureText = cancelled
        ? 'This generation was stopped and can be submitted again.'
        : feedback
          ? `Generation failed. Please check the model configuration and try again.\nModel feedback: ${feedback}`
          : 'Generation failed. Please check the model configuration and try again.'
      dbRun(
        'UPDATE messages SET content = ? WHERE id = ? AND conversation_id = ? AND user_id = ?',
        failureText,
        pendingMessageId, conversationId, current.id,
      )
      writeAudit(req, request, current, cancelled ? 'generation.cancelled' : 'generation.failed', cancelled ? 'success' : 'failure', {
        generationId, code, durationMs, translationInputTokens: translationInput, translationOutputTokens: translationOutput,
      })
      return sendJson(res, cancelled ? 409 : 502, {
        error: cancelled ? 'This generation was stopped' : 'Image generation failed. Please check the model configuration or try again later.',
        code,
        generationId,
      })
    } finally {
      if (activeGenerations.get(conversationId) === activeGeneration) activeGenerations.delete(conversationId)
    }
  }

  const imageMatch = pathname.match(/^\/api\/generations\/([0-9a-f-]{36})\/image$/i)
  if (method === 'GET' && imageMatch) {
    const current = requireUser(user)
    const generationId = numericId(imageMatch[1])
    const row = dbGet<{ user_id: string, image_path: string | null, media_type: string | null, image_name: string | null }>(
      'SELECT user_id, image_path, media_type, image_name FROM generations WHERE id = ? AND user_id = ? AND status = ?',
      generationId, current.id, 'succeeded',
    )
    if (!row?.image_path || !row.media_type) fail(404, 'Image not found')
    const resolvedImage = resolve(row.image_path)
    const userRoot = resolve(imageDir, current.id) + sep
    if (!resolvedImage.startsWith(userRoot)) fail(404, 'Image not found')
    const extension = row.media_type === 'image/jpeg' ? 'jpg' : row.media_type === 'image/webp' ? 'webp' : 'png'
    const downloadName = `${safeImageName(row.image_name ?? '', `Generate image-${generationId.slice(0, 8)}`)}.${extension}`
    const fallbackName = `image-${generationId.slice(0, 8)}.${extension}`
    res.writeHead(200, {
      'content-type': row.media_type,
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      'content-length': (await stat(resolvedImage)).size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    })
    createReadStream(resolvedImage).pipe(res)
    return
  }

  const inputImageMatch = pathname.match(/^\/api\/generations\/([0-9a-f-]{36})\/input-image$/i)
  if (method === 'GET' && inputImageMatch) {
    const current = requireUser(user)
    const generationId = numericId(inputImageMatch[1])
    const row = dbGet<{ user_id: string, input_image_path: string | null, input_media_type: string | null }>(
      'SELECT user_id, input_image_path, input_media_type FROM generations WHERE id = ? AND user_id = ?',
      generationId, current.id,
    )
    if (!row?.input_image_path || !row.input_media_type) fail(404, 'Uploaded image not found')
    const resolvedInput = resolve(row.input_image_path)
    const userRoot = resolve(imageDir, current.id) + sep
    if (!resolvedInput.startsWith(userRoot)) fail(404, 'Uploaded image not found')
    let inputInfo
    try {
      inputInfo = await stat(resolvedInput)
    } catch {
      fail(404, 'Uploaded image not found')
    }
    if (!inputInfo.isFile()) fail(404, 'Uploaded image not found')
    res.writeHead(200, {
      'content-type': row.input_media_type,
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      'content-length': inputInfo.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    })
    createReadStream(resolvedInput).pipe(res)
    return
  }

  if (method === 'GET' && pathname === '/api/usage') {
    const current = requireUser(user)
    const summary = dbGet<Record<string, unknown>>(
      `SELECT (SELECT COUNT(*) FROM conversations WHERE user_id = ?) AS sessions,
         COUNT(*) AS generations,
         COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(translation_input_tokens), 0) AS translationInputTokens,
        COALESCE(SUM(translation_output_tokens), 0) AS translationOutputTokens,
        COALESCE(SUM(image_input_tokens), 0) AS imageInputTokens,
        COALESCE(SUM(image_output_tokens), 0) AS imageOutputTokens,
        COALESCE(SUM(cost_usd), 0) AS costUsd,
        COALESCE(SUM(translation_token_cost_usd), 0) AS translationTokenCostUsd,
        COALESCE(SUM(image_token_cost_usd), 0) AS imageTokenCostUsd,
        COALESCE(SUM(image_request_cost_usd), 0) AS imageRequestCostUsd,
        COALESCE(SUM(CASE WHEN translation_token_cost_usd IS NULL
          OR image_token_cost_usd IS NULL OR image_request_cost_usd IS NULL THEN cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd,
        COALESCE(AVG(duration_ms), 0) AS averageDurationMs
       FROM generations WHERE user_id = ?`,
      current.id, current.id,
    )
    const byModel = dbAll<Record<string, unknown>>(
      `SELECT image_model AS imageModel,
        COALESCE(requested_image_model, image_model) AS requestedImageModel,
        CASE WHEN COALESCE(requested_image_model, image_model) <> image_model
          THEN COALESCE(requested_image_model, image_model) ELSE NULL END AS fallbackFrom,
        translation_model AS translationModel,
        COUNT(DISTINCT conversation_id) AS sessions,
        COUNT(*) AS generations,
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(translation_input_tokens + image_input_tokens), 0) AS inputTokens,
        COALESCE(SUM(translation_output_tokens + image_output_tokens), 0) AS outputTokens,
        COALESCE(SUM(translation_input_tokens), 0) AS translationInputTokens,
        COALESCE(SUM(translation_output_tokens), 0) AS translationOutputTokens,
        COALESCE(SUM(image_input_tokens), 0) AS imageInputTokens,
        COALESCE(SUM(image_output_tokens), 0) AS imageOutputTokens,
        COALESCE(SUM(cost_usd), 0) AS costUsd,
        COALESCE(SUM(translation_token_cost_usd), 0) AS translationTokenCostUsd,
        COALESCE(SUM(image_token_cost_usd), 0) AS imageTokenCostUsd,
        COALESCE(SUM(image_request_cost_usd), 0) AS imageRequestCostUsd,
        COALESCE(SUM(CASE WHEN translation_token_cost_usd IS NULL
          OR image_token_cost_usd IS NULL OR image_request_cost_usd IS NULL THEN cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd,
        COALESCE(AVG(duration_ms), 0) AS averageDurationMs
       FROM generations WHERE user_id = ?
       GROUP BY image_model, COALESCE(requested_image_model, image_model), translation_model
       ORDER BY generations DESC`,
      current.id,
    )
    return sendJson(res, 200, { ...summary, byModel })
  }

  const auditLogMatch = pathname.match(/^\/api\/admin\/logs\/([1-9][0-9]*)$/)
  if (method === 'DELETE' && auditLogMatch) {
    const admin = requireAdmin(user)
    const logId = Number(auditLogMatch[1])
    if (!Number.isSafeInteger(logId)) fail(404, 'Log not found')
    const target = dbGet<{ id: number, event: string, status: string, email: string | null }>(
      'SELECT id, event, status, email FROM audit_logs WHERE id = ?',
      logId,
    )
    if (!target) fail(404, 'Log not found')
    const deleted = database.prepare('DELETE FROM audit_logs WHERE id = ?').run(logId)
    if (!Number(deleted.changes)) fail(404, 'Log not found')
    writeAudit(req, request, admin, 'admin.logs.deleted', 'success', {
      targetLogId: logId,
      targetEvent: target.event,
      targetStatus: target.status,
      targetEmail: target.email ?? undefined,
    })
    return sendJson(res, 200, { ok: true, id: logId })
  }

  if (method === 'GET' && pathname.startsWith('/api/admin/')) {
    const admin = requireAdmin(user)
    if (pathname === '/api/admin/providers') {
      return sendJson(res, 200, providersForAdmin(readProviders()))
    }
    if (pathname === '/api/admin/users') {
      return sendJson(res, 200, dbAll(
        `SELECT u.id, u.email, u.role, u.active, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
          COUNT(g.id) AS generationCount, COALESCE(SUM(g.cost_usd), 0) AS costUsd,
          COALESCE(SUM(g.translation_token_cost_usd), 0) AS translationTokenCostUsd,
          COALESCE(SUM(g.image_token_cost_usd), 0) AS imageTokenCostUsd,
          COALESCE(SUM(g.image_request_cost_usd), 0) AS imageRequestCostUsd,
          COALESCE(SUM(CASE WHEN g.id IS NOT NULL AND (g.translation_token_cost_usd IS NULL
            OR g.image_token_cost_usd IS NULL OR g.image_request_cost_usd IS NULL) THEN g.cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd
         FROM users u LEFT JOIN generations g ON g.user_id = u.id
         GROUP BY u.id ORDER BY u.created_at DESC`,
      ))
    }
    if (method === 'GET' && pathname === '/api/admin/logs/export') {
      const filters = parseAuditLogFilters(url, 10_000, 10_000)
      const rows = queryAuditLogs(filters)
      const body = auditLogsCsv(rows)
      const filename = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`
      writeAudit(req, request, admin, 'admin.logs.exported', 'success', {
        count: rows.length,
        email: filters.email || undefined,
        event: filters.event || undefined,
        status: filters.status || undefined,
      })
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
      return
    }
    if (method === 'GET' && pathname === '/api/admin/logs') {
      const filters = parseAuditLogFilters(url, 250)
      return sendJson(res, 200, queryAuditLogs(filters))
    }
    if (pathname === '/api/admin/stats') {
      const summary = dbGet<Record<string, unknown>>(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE active = 1) AS activeUsers,
          (SELECT COUNT(*) FROM conversations) AS sessions,
          COUNT(*) AS generations,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(translation_input_tokens), 0) AS translationInputTokens,
          COALESCE(SUM(translation_output_tokens), 0) AS translationOutputTokens,
          COALESCE(SUM(image_input_tokens), 0) AS imageInputTokens,
          COALESCE(SUM(image_output_tokens), 0) AS imageOutputTokens,
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(SUM(translation_token_cost_usd), 0) AS translationTokenCostUsd,
          COALESCE(SUM(image_token_cost_usd), 0) AS imageTokenCostUsd,
          COALESCE(SUM(image_request_cost_usd), 0) AS imageRequestCostUsd,
          COALESCE(SUM(CASE WHEN translation_token_cost_usd IS NULL
            OR image_token_cost_usd IS NULL OR image_request_cost_usd IS NULL THEN cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd,
          COALESCE(AVG(duration_ms), 0) AS averageDurationMs
         FROM generations`,
      )
      const byUser = dbAll(
        `SELECT u.id, u.email, u.role, u.active,
          (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS sessions,
          COUNT(g.id) AS generations,
          SUM(CASE WHEN g.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN g.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN g.error_code = 'generation-cancelled' THEN 1 ELSE 0 END) AS cancelled,
          COALESCE(SUM(g.translation_input_tokens + g.image_input_tokens), 0) AS inputTokens,
          COALESCE(SUM(g.translation_output_tokens + g.image_output_tokens), 0) AS outputTokens,
          COALESCE(SUM(g.translation_input_tokens), 0) AS translationInputTokens,
          COALESCE(SUM(g.translation_output_tokens), 0) AS translationOutputTokens,
          COALESCE(SUM(g.image_input_tokens), 0) AS imageInputTokens,
          COALESCE(SUM(g.image_output_tokens), 0) AS imageOutputTokens,
          COALESCE(SUM(g.cost_usd), 0) AS costUsd,
          COALESCE(SUM(g.translation_token_cost_usd), 0) AS translationTokenCostUsd,
          COALESCE(SUM(g.image_token_cost_usd), 0) AS imageTokenCostUsd,
          COALESCE(SUM(g.image_request_cost_usd), 0) AS imageRequestCostUsd,
          COALESCE(SUM(CASE WHEN g.id IS NOT NULL AND (g.translation_token_cost_usd IS NULL
            OR g.image_token_cost_usd IS NULL OR g.image_request_cost_usd IS NULL) THEN g.cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd,
          COALESCE(AVG(g.duration_ms), 0) AS averageDurationMs
         FROM users u LEFT JOIN generations g ON g.user_id = u.id
         GROUP BY u.id ORDER BY costUsd DESC`,
      )
      const byModel = dbAll(
        `SELECT image_model AS imageModel,
          COALESCE(requested_image_model, image_model) AS requestedImageModel,
          CASE WHEN COALESCE(requested_image_model, image_model) <> image_model
            THEN COALESCE(requested_image_model, image_model) ELSE NULL END AS fallbackFrom,
          translation_model AS translationModel,
          COUNT(DISTINCT conversation_id) AS sessions,
          COUNT(*) AS generations,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(translation_input_tokens + image_input_tokens), 0) AS inputTokens,
          COALESCE(SUM(translation_output_tokens + image_output_tokens), 0) AS outputTokens,
          COALESCE(SUM(translation_input_tokens), 0) AS translationInputTokens,
          COALESCE(SUM(translation_output_tokens), 0) AS translationOutputTokens,
          COALESCE(SUM(image_input_tokens), 0) AS imageInputTokens,
          COALESCE(SUM(image_output_tokens), 0) AS imageOutputTokens,
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(SUM(translation_token_cost_usd), 0) AS translationTokenCostUsd,
          COALESCE(SUM(image_token_cost_usd), 0) AS imageTokenCostUsd,
          COALESCE(SUM(image_request_cost_usd), 0) AS imageRequestCostUsd,
          COALESCE(SUM(CASE WHEN translation_token_cost_usd IS NULL
            OR image_token_cost_usd IS NULL OR image_request_cost_usd IS NULL THEN cost_usd ELSE 0 END), 0) AS unclassifiedCostUsd,
          COALESCE(AVG(duration_ms), 0) AS averageDurationMs
         FROM generations
         GROUP BY image_model, COALESCE(requested_image_model, image_model), translation_model
         ORDER BY costUsd DESC`,
      )
      const byMode = dbAll(
        `SELECT image_mode AS imageMode,
          COUNT(*) AS generations,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' AND error_code <> 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(reference_image_bytes), 0) AS referenceImageBytes,
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(AVG(duration_ms), 0) AS averageDurationMs
         FROM generations
         GROUP BY image_mode
         ORDER BY generations DESC`,
      )
      const byError = dbAll(
        `SELECT
          CASE WHEN status = 'succeeded' THEN 'success' ELSE COALESCE(error_code, 'unknown') END AS errorCode,
          COUNT(*) AS generations,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
          COALESCE(SUM(CASE WHEN status = 'failed' AND error_code <> 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN error_code = 'generation-cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
         FROM generations
         GROUP BY CASE WHEN status = 'succeeded' THEN 'success' ELSE COALESCE(error_code, 'unknown') END
         ORDER BY generations DESC`,
      )
      const traffic = {
        minutes: trafficSeries('minute', 60),
        hours: trafficSeries('hour', 24),
        days: trafficSeries('day', 30),
        months: trafficSeries('month', 12),
      }
      const daily = traffic.days.map(({ bucket, ...row }) => ({ day: bucket, ...row }))
      return sendJson(res, 200, { summary, byUser, byModel, byMode, byError, daily, traffic })
    }
    fail(404, 'Administrator endpoint not found')
  }

  if (method === 'PUT' && pathname === '/api/admin/providers') {
    const admin = requireAdmin(user)
    const body = await readJson(req)
    const existing = readProviders()
    const translation = typeof body.translation === 'object' && body.translation !== null
      ? body.translation as Record<string, unknown>
      : {}
    const image = typeof body.image === 'object' && body.image !== null
      ? body.image as Record<string, unknown>
      : {}
    const asString = (value: unknown, fallback: string, label: string, limit = 180): string => {
      if (value === undefined || value === null || value === '') return fallback
      if (typeof value !== 'string' || value.trim().length > limit) fail(400, `${label}invalid`)
      return value.trim()
    }
    const asSystemPrompt = (value: unknown, fallback: string): string => {
      if (value === undefined) return fallback
      if (typeof value !== 'string' || value.length > 50_000) fail(400, 'Prompt-model system prompt is invalid')
      return value.trim()
    }
    const asBaseUrl = (value: unknown, fallback: string, label: string): string => {
      const raw = asString(value, fallback, label, 1000)
      try {
        return cleanBaseUrl(raw, fallback)
      } catch {
        fail(400, `${label}invalid`)
      }
    }
    const config: ProviderConfig = {
      translation: {
        apiKey: translation.clearApiKey === true
          ? ''
          : asString(translation.apiKey, existing.translation.apiKey, 'Prompt model API key', 500),
        baseUrl: asBaseUrl(translation.baseUrl, existing.translation.baseUrl, 'Prompt modelCompatible API URL'),
        model: asString(translation.model, existing.translation.model, 'Prompt modelName'),
        systemPrompt: asSystemPrompt(translation.systemPrompt, existing.translation.systemPrompt),
        inputPricePerMillion: asFiniteNumber(translation.inputPricePerMillion, existing.translation.inputPricePerMillion),
        outputPricePerMillion: asFiniteNumber(translation.outputPricePerMillion, existing.translation.outputPricePerMillion),
      },
      image: {
        apiKey: image.clearApiKey === true
          ? ''
          : asString(image.apiKey, existing.image.apiKey, 'Imagemodel API key', 500),
        baseUrl: asBaseUrl(image.baseUrl, existing.image.baseUrl, 'ImagemodelCompatible API URL'),
        model: asString(image.model, existing.image.model, 'ImageModel name'),
        inputPricePerMillion: asFiniteNumber(image.inputPricePerMillion, existing.image.inputPricePerMillion),
        outputPricePerMillion: asFiniteNumber(image.outputPricePerMillion, existing.image.outputPricePerMillion),
        costPerImage: asFiniteNumber(image.costPerImage, existing.image.costPerImage),
      },
    }
    if (!config.image.model) fail(400, 'Image-model name is invalid')
    const value = seal(JSON.stringify(config))
    dbRun(
      `INSERT INTO app_settings(key, value, updated_at) VALUES('providers', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      value, now(),
    )
    writeAudit(req, request, admin, 'admin.providers.updated', 'success', {
      translationBaseUrl: config.translation.baseUrl,
      translationModel: config.translation.model,
      translationKeyUpdated: Boolean(translation.apiKey),
      translationSystemPromptUpdated: Object.hasOwn(translation, 'systemPrompt'),
      translationSystemPromptCharacters: config.translation.systemPrompt.length,
      imageBaseUrl: config.image.baseUrl,
      imageModel: config.image.model,
      imageKeyUpdated: Boolean(image.apiKey),
    })
    return sendJson(res, 200, providersForAdmin(config))
  }

  if (method === 'POST' && pathname === '/api/admin/providers/test') {
    const admin = requireAdmin(user)
    const body = await readJson(req)
    const provider = body.provider
    if (provider !== 'translation' && provider !== 'image') fail(400, 'Provider type is invalid')
    const config = readProviders()
    const selected = config[provider]
    const suppliedKey = body.apiKey === undefined
      ? selected.apiKey
      : typeof body.apiKey === 'string'
        ? body.apiKey.trim()
        : ''
    if (!suppliedKey || suppliedKey.length > 500) fail(409, 'Please configure this provider API key')
    const fallback = provider === 'image' ? defaultImageBaseUrl : defaultTranslationBaseUrl
    const suppliedBase = body.baseUrl === undefined
      ? selected.baseUrl
      : typeof body.baseUrl === 'string'
        ? body.baseUrl.trim()
        : ''
    let base: string
    try {
      base = cleanBaseUrl(suppliedBase, fallback)
    } catch {
      fail(400, 'Compatible API URL is invalid')
    }
    let response: Response
    try {
      response = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${suppliedKey}` },
        signal: AbortSignal.timeout(requestTimeout),
        redirect: 'error',
      })
    } catch {
      writeAudit(req, request, admin, 'admin.provider_test', 'failure', { provider, code: 'connection-failed' })
      fail(502, 'Unable to connect to the model service. Please check the service URL and network.')
    }
    const text = await readBodyBounded(response)
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'authentication-rejected' : `provider-http-${response.status}`
      writeAudit(req, request, admin, 'admin.provider_test', 'failure', { provider, code })
      return sendJson(res, 502, {
        error: response.status === 401 || response.status === 403
          ? 'The model service rejected the API key'
          : `The model service returned HTTP ${response.status}`,
        code,
      })
    }
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) throw new Error()
      payload = parsed as Record<string, unknown>
    } catch {
      writeAudit(req, request, admin, 'admin.provider_test', 'failure', { provider, code: 'invalid-model-list' })
      return sendJson(res, 502, { error: 'The model service returned an invalid model list', code: 'invalid-model-list' })
    }
    const modelRows = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : []
    const models = modelRows
      .map(item => typeof item === 'string'
        ? item
        : typeof item === 'object' && item !== null && !Array.isArray(item) && 'id' in item
          ? (item as { id?: unknown }).id
          : undefined)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 180)
      .slice(0, 100)
    const available = models.includes(selected.model)
    writeAudit(req, request, admin, 'admin.provider_test', available ? 'success' : 'failure', {
      provider,
      model: selected.model,
      available,
      modelCount: models.length,
    })
    return sendJson(res, 200, {
      ok: available,
      model: selected.model,
      availableModels: models,
      message: available ? 'Connection successful. The current model is available.' : 'Connection successful, but the current model is not in the list returned by the service.',
    })
  }

  if (method === 'POST' && pathname === '/api/admin/users') {
    const admin = requireAdmin(user)
    const body = await readJson(req)
    const email = validateEmail(body.email)
    const password = validatePassword(body.password)
    const role: Role = body.role === 'admin' ? 'admin' : 'user'
    const id = randomUUID()
    try {
      dbRun(
        'INSERT INTO users(id, email, password_hash, role, active, created_at) VALUES(?, ?, ?, ?, 1, ?)',
        id, email, await passwordHash(password), role, now(),
      )
    } catch {
      fail(409, 'That email already exists')
    }
    writeAudit(req, request, admin, 'admin.user.created', 'success', { targetUserId: id, targetEmail: email, role })
    return sendJson(res, 201, { id, email, role, active: 1 })
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/i)
  if (method === 'DELETE' && adminUserMatch) {
    const admin = requireAdmin(user)
    const targetId = numericId(adminUserMatch[1])
    const target = dbGet<{ id: string, email: string, role: Role, active: number }>(
      'SELECT id, email, role, active FROM users WHERE id = ?',
      targetId,
    )
    if (!target) fail(404, 'Account not found')
    if (target.id === admin.id) fail(400, 'Cannot delete the currently signed-in administrator')
    if (target.role === 'admin' && target.active === 1) {
      const count = dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM users WHERE role = ? AND active = 1', 'admin')?.count ?? 0
      if (count <= 1) fail(400, 'The system must keep at least one enabled administrator')
    }
    cancelGenerationsForUser(targetId)
    const imageRoot = resolve(imageDir, targetId)
    database.exec('BEGIN IMMEDIATE')
    try {
      dbRun('DELETE FROM login_sessions WHERE user_id = ?', targetId)
      dbRun('DELETE FROM generation_queue WHERE user_id = ?', targetId)
      dbRun('DELETE FROM messages WHERE user_id = ?', targetId)
      dbRun('DELETE FROM generations WHERE user_id = ?', targetId)
      dbRun('DELETE FROM conversations WHERE user_id = ?', targetId)
      dbRun('DELETE FROM audit_logs WHERE user_id = ?', targetId)
      dbRun('DELETE FROM users WHERE id = ?', targetId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    await rm(imageRoot, { recursive: true, force: true }).catch(() => undefined)
    writeAudit(req, request, admin, 'admin.user.deleted', 'success', {
      targetUserId: targetId,
      targetEmail: target.email,
      targetRole: target.role,
    })
    return sendJson(res, 200, { ok: true, id: targetId })
  }
  if (method === 'PATCH' && adminUserMatch) {
    const admin = requireAdmin(user)
    const targetId = numericId(adminUserMatch[1])
    const target = dbGet<{ id: string, email: string, role: Role, active: number }>(
      'SELECT id, email, role, active FROM users WHERE id = ?',
      targetId,
    )
    if (!target) fail(404, 'Account not found')
    const body = await readJson(req)
    const active = body.active === undefined ? target.active : body.active === true ? 1 : body.active === false ? 0 : fail(400, 'Account status is invalid')
    const role: Role = body.role === undefined ? target.role : body.role === 'admin' || body.role === 'user' ? body.role : fail(400, 'Role is invalid')
    const newPassword = body.password === undefined ? undefined : validatePassword(body.password)
    if (target.id === admin.id && (active !== 1 || role !== 'admin')) fail(400, 'Cannot disable or demote the current administrator')
    if (target.role === 'admin' && (active !== 1 || role !== 'admin')) {
      const count = dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM users WHERE role = ? AND active = 1')?.count ?? 0
      if (count <= 1) fail(400, 'The system must keep at least one enabled administrator')
    }
    if (newPassword) {
      dbRun('UPDATE users SET active = ?, role = ?, password_hash = ? WHERE id = ?', active, role, await passwordHash(newPassword), targetId)
      dbRun('DELETE FROM login_sessions WHERE user_id = ?', targetId)
    } else {
      dbRun('UPDATE users SET active = ?, role = ? WHERE id = ?', active, role, targetId)
    }
    if (active === 0) dbRun('DELETE FROM login_sessions WHERE user_id = ?', targetId)
    if (newPassword || active === 0) cancelGenerationsForUser(targetId)
    writeAudit(req, request, admin, 'admin.user.updated', 'success', {
      targetUserId: targetId, targetEmail: target.email, active, role, passwordReset: Boolean(newPassword),
    })
    return sendJson(res, 200, { id: targetId, email: target.email, active, role })
  }

  fail(404, 'Endpoint not found')
}

const mimeByExtension: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const publicDir = resolve(root, 'dist/public')
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    fail(400, 'Path is invalid')
  }
  const requested = decoded === '/' ? '/index.html' : decoded
  const target = resolve(publicDir, `.${requested}`)
  if (target !== publicDir && !target.startsWith(publicDir + sep)) fail(404, 'Resource not found')
  try {
    const info = await stat(target)
    if (!info.isFile()) fail(404, 'Resource not found')
    const content = await readFile(target)
    res.writeHead(200, {
      'content-type': mimeByExtension[extname(target)] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'referrer-policy': 'same-origin',
    })
    res.end(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(404, 'Resource not found')
    throw error
  }
}

const server = createServer(async (req, res) => {
  const id = requestId(req)
  res.setHeader('x-request-id', id)
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, id)
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url.pathname, res)
    } else {
      sendJson(res, 405, { error: 'Method not allowed' })
    }
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : 500
    if (status >= 500) console.error(`[${id}]`, error)
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Service temporarily unavailable' : (error as Error).message, requestId: id })
    else res.destroy()
  }
})

await bootstrapAdmin()
server.listen(port, host, () => {
  console.info(`Galaxy Atelier API listening on http://${host}:${port}`)
  if (!dbGet<{ id: string }>('SELECT id FROM users LIMIT 1')) {
    console.warn('No accounts exist. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.')
  }
})

const shutdown = (): void => {
  for (const active of activeGenerations.values()) active.controller.abort()
  server.close(() => {
    database.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
