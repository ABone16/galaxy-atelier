import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adminEmail = 'production-smoke@example.test'
const smokeSecret = label => `${label}-${randomBytes(24).toString('hex')}`
const adminPassword = smokeSecret('smoke-password')
const translationApiKey = smokeSecret('translation')
const imageApiKey = smokeSecret('image')
const translationModel = 'smoke-translator'
const imageModel = 'smoke-image-model'
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port')
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
  })
  return address.port
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const waitForExit = timeoutMs => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise(resolveExit => {
      const onExit = () => {
        clearTimeout(timeout)
        resolveExit(true)
      }
      const timeout = setTimeout(() => {
        child.off('exit', onExit)
        resolveExit(false)
      }, timeoutMs)
      child.once('exit', onExit)
    })
  }
  const gracefulExit = waitForExit(3000)
  child.kill()
  if (!await gracefulExit) {
    const forcedExit = waitForExit(3000)
    child.kill('SIGKILL')
    if (!await forcedExit) {
      throw new Error('Production smoke service process did not stop')
    }
  }
}

const logs = []
let dataDir
let child
let spawnError

try {
  await access(join(root, 'dist/server/index.js'))
  await access(join(root, 'dist/public/index.html'))

  dataDir = await mkdtemp(join(tmpdir(), 'atelier-agent-production-smoke-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    INITIAL_ADMIN_EMAIL: adminEmail,
    INITIAL_ADMIN_PASSWORD: adminPassword,
    TRANSLATION_API_BASE_URL: 'https://translation-provider.invalid/v1',
    IMAGE_API_BASE_URL: 'https://image-provider.invalid/v1',
    ATELIER_SMOKE_TRANSLATION_KEY: translationApiKey,
    ATELIER_SMOKE_IMAGE_KEY: imageApiKey,
    ATELIER_SMOKE_TRANSLATION_MODEL: translationModel,
    ATELIER_SMOKE_IMAGE_MODEL: imageModel,
  }
  delete env.TRANSLATION_API_KEY
  delete env.IMAGE_API_KEY

  child = spawn(process.execPath, [
    '--import',
    pathToFileURL(join(root, 'scripts/production-provider-mock.mjs')).href,
    join(root, 'dist/server/index.js'),
  ], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('error', error => {
    spawnError = error
    logs.push(error.message)
  })
  child.stdout.on('data', chunk => logs.push(chunk.toString()))
  child.stderr.on('data', chunk => logs.push(chunk.toString()))

  const deadline = Date.now() + 15_000
  let health
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start production service: ${spawnError.message}`)
    if (child.exitCode !== null) throw new Error('Production service exited during startup')
    try {
      health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(750) })
      if (health.ok) break
    } catch {}
    await delay(100)
  }
  if (!health?.ok) throw new Error('Production health endpoint did not become ready')
  const healthPayload = await health.json()
  if (healthPayload.status !== 'ok') throw new Error('Production health payload was unexpected')
  console.log('PASS production health endpoint')

  const page = await fetch(baseUrl)
  const html = await page.text()
  if (!page.ok || !html.includes('<title>Galaxy Atelier</title>')) {
    throw new Error('Production homepage was not served')
  }
  if (!page.headers.get('content-security-policy')?.includes("default-src 'self'")) {
    throw new Error('Production homepage is missing its content security policy')
  }
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
  if (assets.length < 2) throw new Error('Production homepage did not reference its built assets')
  for (const asset of assets) {
    const response = await fetch(new URL(asset, baseUrl))
    if (!response.ok || !response.headers.get('content-type')) {
      throw new Error(`Production asset failed to load: ${asset}`)
    }
  }
  console.log(`PASS production homepage and ${assets.length} built assets`)

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  if (!login.ok) throw new Error('Bootstrapped administrator could not sign in')
  const setCookie = login.headers.get('set-cookie') ?? ''
  if (!/;\s*HttpOnly(?:;|$)/i.test(setCookie)
    || !/;\s*SameSite=Strict(?:;|$)/i.test(setCookie)
    || !/;\s*Secure(?:;|$)/i.test(setCookie)) {
    throw new Error('Production session cookie is missing expected security flags')
  }
  const cookie = setCookie.split(';', 1)[0]
  const currentUser = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })
  const userPayload = await currentUser.json()
  if (!currentUser.ok || userPayload.user?.email !== adminEmail || userPayload.user?.role !== 'admin') {
    throw new Error('Bootstrapped administrator session was not authenticated')
  }
  console.log('PASS initial administrator bootstrap and secure session cookie')

  const providers = await fetch(`${baseUrl}/api/admin/providers`, {
    method: 'PUT',
    headers: { origin: baseUrl, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      translation: {
        apiKey: translationApiKey,
        model: translationModel,
        inputPricePerMillion: 1,
        outputPricePerMillion: 2,
      },
      image: {
        apiKey: imageApiKey,
        model: imageModel,
        inputPricePerMillion: 3,
        outputPricePerMillion: 4,
        costPerImage: 0.01,
      },
    }),
  })
  if (!providers.ok) throw new Error('Production administrator could not configure providers')
  const providerSettingsResponse = await fetch(`${baseUrl}/api/admin/providers`, { headers: { cookie } })
  const providerSettings = await providerSettingsResponse.json()
  if (!providerSettingsResponse.ok
    || !providerSettings.translation?.configured
    || !providerSettings.image?.configured
    || JSON.stringify(providerSettings).includes(translationApiKey)
    || JSON.stringify(providerSettings).includes(imageApiKey)) {
    throw new Error('Production provider settings exposed a key or lost its configured state')
  }

  const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  const session = await sessionResponse.json()
  if (!sessionResponse.ok || typeof session.id !== 'string') {
    throw new Error('Production administrator could not create a session')
  }

  const generationResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/generate`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A simple production smoke-test image.', size: '1024x1024' }),
  })
  const generation = await generationResponse.json()
  if (!generationResponse.ok
    || generation.imageModel !== imageModel
    || generation.translationModel !== translationModel
    || generation.translatedPrompt !== 'A production-smoke illustration.'
    || generation.width !== 1
    || generation.height !== 1) {
    throw new Error('Production translation-to-image generation failed')
  }
  const imageResponse = await fetch(new URL(generation.imageUrl, baseUrl), { headers: { cookie } })
  if (!imageResponse.ok
    || imageResponse.headers.get('content-type') !== 'image/png'
    || (await imageResponse.arrayBuffer()).byteLength < 33) {
    throw new Error('Production generated image could not be retrieved')
  }

  const usageResponse = await fetch(`${baseUrl}/api/usage`, { headers: { cookie } })
  const usage = await usageResponse.json()
  if (!usageResponse.ok
    || usage.generations !== 1
    || usage.succeeded !== 1
    || usage.translationInputTokens !== 12
    || usage.translationOutputTokens !== 6
    || usage.imageInputTokens !== 3
    || usage.imageOutputTokens !== 1) {
    throw new Error('Production account usage did not record provider token counts')
  }

  const adminStatsResponse = await fetch(`${baseUrl}/api/admin/stats`, { headers: { cookie } })
  const adminStats = await adminStatsResponse.json()
  const adminUsage = adminStats.byUser?.find(row => row.email === adminEmail)
  if (!adminStatsResponse.ok
    || adminStats.summary?.generations !== 1
    || adminUsage?.generations !== 1
    || adminUsage?.translationInputTokens !== 12
    || adminUsage?.imageOutputTokens !== 1) {
    throw new Error('Production administrator statistics did not record the generation')
  }

  const auditResponse = await fetch(`${baseUrl}/api/admin/logs?event=generation.completed`, { headers: { cookie } })
  const auditRows = await auditResponse.json()
  if (!auditResponse.ok
    || !auditRows.some(row => row.email === adminEmail
      && row.event === 'generation.completed'
      && row.details?.generationId === generation.generationId)) {
    throw new Error('Production audit log did not record the completed generation')
  }

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie },
  })
  const clearedCookie = logoutResponse.headers.get('set-cookie') ?? ''
  if (!logoutResponse.ok
    || !/;\s*HttpOnly(?:;|$)/i.test(clearedCookie)
    || !/;\s*SameSite=Strict(?:;|$)/i.test(clearedCookie)
    || !/;\s*Secure(?:;|$)/i.test(clearedCookie)
    || !/;\s*Max-Age=0(?:;|$)/i.test(clearedCookie)) {
    throw new Error('Production logout did not clear the session with secure cookie flags')
  }
  const loggedOut = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })
  if (loggedOut.status !== 401) throw new Error('Production logout left the session active')
  console.log('PASS production generation, protected keys, usage, audit, and secure logout')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (logs.length) console.error(logs.join('').trim())
  process.exitCode = 1
} finally {
  try {
    await stop(child)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
}
