import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const project = resolve(import.meta.dirname, '..')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='
const testSecret = label => `${label}-${randomBytes(24).toString('hex')}`

test('rejects an invalid encryption key before creating persistent data', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-config-test-'))
  const dataDir = join(tempBase, 'data')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: project,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: 'invalid-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    await rm(tempBase, { recursive: true, force: true })
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  let timer
  const result = await Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal })),
    new Promise(resolveResult => { timer = setTimeout(() => resolveResult(null), 5_000) }),
  ])
  clearTimeout(timer)
  assert.ok(result, `server did not reject the invalid key: ${output}`)
  assert.notEqual(result.code, 0)
  assert.match(output, /APP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters/)
  assert.equal(existsSync(dataDir), false)
})

test('serves the production web app with secure authenticated sessions', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-production-test-'))
  const dataDir = join(tempBase, 'data')
  const apiPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const password = testSecret('production-password')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: project,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      INITIAL_ADMIN_EMAIL: 'production-admin@example.test',
      INITIAL_ADMIN_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    await stopChild(child)
    await rm(tempBase, { recursive: true, force: true })
  })
  await waitForServer(child)

  const health = await fetch(`${apiBase}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })

  const page = await fetch(`${apiBase}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Galaxy Atelier<\/title>/)
  assert.equal(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')

  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { origin: apiBase, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'production-admin@example.test', password }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? ''
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Secure/)

  const sessionCookie = cookie.split(';', 1)[0]
  const logout = await fetch(`${apiBase}/api/auth/logout`, {
    method: 'POST',
    headers: { origin: apiBase, cookie: sessionCookie },
  })
  assert.equal(logout.status, 200)
  const clearedCookie = logout.headers.getSetCookie?.()[0] ?? logout.headers.get('set-cookie') ?? ''
  assert.match(clearedCookie, /HttpOnly/)
  assert.match(clearedCookie, /SameSite=Strict/)
  assert.match(clearedCookie, /Max-Age=0/)
  assert.match(clearedCookie, /Secure/)
  const staleSession = await fetch(`${apiBase}/api/auth/me`, { headers: { cookie: sessionCookie } })
  assert.equal(staleSession.status, 401)
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

function jsonResponse(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readRequest(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitForServer(child) {
  let output = ''
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`server did not start: ${output}`)), 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('API listening')) {
        clearTimeout(timer)
        resolveReady()
      }
    })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('exit', code => {
      clearTimeout(timer)
      rejectReady(new Error(`server exited before ready (${code}): ${output}`))
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

test('login, role enforcement, account isolation, provider flow, and usage accounting', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-test-'))
  assert.equal(dirname(resolve(tempBase)), resolve(tmpdir()), 'test data is contained in the OS temp directory')
  const dataDir = join(tempBase, 'data')
  let malformedImage = false
  let preferredModelUnavailable = false
  let providerFailure = false
  let namedTranslation = false
  const providerRequests = []
  const provider = createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' ? {} : await readRequest(req)
      providerRequests.push({ path: req.url, authorization: req.headers.authorization, body })
      if (req.url === '/v1/models') {
        const models = [
          { id: 'mock-translator' },
          { id: 'gpt-image-2.5' },
          { id: 'gpt-image-2' },
          { id: 'vendor-image-pro' },
        ]
        if (!preferredModelUnavailable) models.unshift({ id: 'gpt-image-2.6' })
        return jsonResponse(res, { data: models })
      }
      if (req.url === '/v1/chat/completions') {
        return jsonResponse(res, {
          choices: [{
            message: {
              content: namedTranslation
                ? 'SESSION_TITLE: Floating Greenhouse Study\nTITLE: Glass Greenhouse Above Clouds\nPROMPT: A clear English image-generation prompt.'
                : 'A clear English image-generation prompt.',
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })
      }
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
        if (providerFailure) {
          return jsonResponse(res, { error: { message: 'Provider rejected this image request.' } }, 400)
        }
        if (preferredModelUnavailable && body.model === 'gpt-image-2.6') {
          return jsonResponse(res, { error: 'model not found' }, 404)
        }
        return jsonResponse(res, {
          data: [{
            b64_json: png,
            width: malformedImage ? 2 : 1,
            height: 1,
            revised_prompt: 'Provider-adjusted image prompt.',
          }],
          usage: { input_tokens: 13, output_tokens: 2 },
        })
      }
      return jsonResponse(res, { error: 'not found' }, 404)
    } catch {
      return jsonResponse(res, { error: 'invalid request' }, 400)
    }
  })
  const providerPort = await listen(provider)
  const apiPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const providerBase = `http://127.0.0.1:${providerPort}/v1`
  const password = testSecret('admin-password')
  const memberPassword = testSecret('member-password')
  const translationApiKey = testSecret('translation')
  const imageApiKey = testSecret('image')
  const encryptionKey = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [
    '--import',
    pathToFileURL(resolve(project, 'node_modules/tsx/dist/loader.mjs')).href,
    resolve(project, 'server/index.ts'),
  ], {
    cwd: tempBase,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: encryptionKey,
      INITIAL_ADMIN_EMAIL: 'admin@example.test',
      INITIAL_ADMIN_PASSWORD: password,
      TRANSLATION_API_BASE_URL: providerBase,
      IMAGE_API_BASE_URL: providerBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    await stopChild(child)
    await new Promise(resolveClose => provider.close(resolveClose))
    await rm(tempBase, { recursive: true, force: true })
  })
  await waitForServer(child)
  const staticPage = await fetch(`${apiBase}/`)
  assert.equal(staticPage.status, 200)
  assert.match(await staticPage.text(), /<title>Galaxy Atelier<\/title>/)

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = apiBase
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  async function login(email, loginPassword) {
    const { response, payload } = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password: loginPassword },
    })
    assert.equal(response.status, 200)
    const rawCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
    assert.ok(rawCookie?.includes('HttpOnly'))
    assert.ok(rawCookie?.includes('SameSite=Strict'))
    return { cookie: rawCookie.split(';')[0], user: payload.user }
  }

  const admin = await login('admin@example.test', password)
  assert.equal(admin.user.role, 'admin')
  const adminSession = await request('/api/sessions', { cookie: admin.cookie, method: 'POST', body: {} })
  assert.equal(adminSession.response.status, 201)

  const created = await request('/api/admin/users', {
    cookie: admin.cookie,
    method: 'POST',
    body: { email: 'member@example.test', password: memberPassword, role: 'user' },
  })
  assert.equal(created.response.status, 201)

  const member = await login('member@example.test', memberPassword)
  assert.equal(member.user.role, 'user')
  const deniedAdmin = await request('/api/admin/stats', { cookie: member.cookie })
  assert.equal(deniedAdmin.response.status, 403)

  const createdSession = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  assert.equal(createdSession.response.status, 201)
  const sessionId = createdSession.payload.id
  assert.equal(createdSession.payload.archivedAt, null)
  const archiveSession = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  assert.equal(archiveSession.response.status, 201)
  const archivedId = archiveSession.payload.id
  const archived = await request(`/api/sessions/${archivedId}`, {
    cookie: member.cookie,
    method: 'PATCH',
    body: { archived: true },
  })
  assert.equal(archived.response.status, 200)
  assert.ok(archived.payload.archivedAt)
  const recentSessions = await request('/api/sessions', { cookie: member.cookie })
  assert.equal(recentSessions.payload.some(item => item.id === archivedId), false)
  const archivedSessions = await request('/api/sessions?archived=true', { cookie: member.cookie })
  assert.equal(archivedSessions.response.status, 200)
  assert.equal(archivedSessions.payload.some(item => item.id === archivedId), true)
  const otherAccountArchiveList = await request('/api/sessions?archived=true', { cookie: admin.cookie })
  assert.equal(otherAccountArchiveList.payload.some(item => item.id === archivedId), false)
  const crossAccountArchive = await request(`/api/sessions/${archivedId}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { archived: false },
  })
  assert.equal(crossAccountArchive.response.status, 404)
  const archivedGenerate = await request(`/api/sessions/${archivedId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'An archived session must remain read-only.', size: '1024x1024' },
  })
  assert.equal(archivedGenerate.response.status, 409)
  const invalidArchiveValue = await request(`/api/sessions/${archivedId}`, {
    cookie: member.cookie,
    method: 'PATCH',
    body: { archived: 'false' },
  })
  assert.equal(invalidArchiveValue.response.status, 400)
  const restored = await request(`/api/sessions/${archivedId}`, {
    cookie: member.cookie,
    method: 'PATCH',
    body: { archived: false },
  })
  assert.equal(restored.response.status, 200)
  assert.equal(restored.payload.archivedAt, null)
  const restoredSessions = await request('/api/sessions', { cookie: member.cookie })
  assert.equal(restoredSessions.payload.some(item => item.id === archivedId), true)
  const deleteCandidate = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  assert.equal(deleteCandidate.response.status, 201)
  const crossAccountDelete = await request(`/api/sessions/${deleteCandidate.payload.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(crossAccountDelete.response.status, 404)
  const deletedSession = await request(`/api/sessions/${deleteCandidate.payload.id}`, {
    cookie: member.cookie,
    method: 'DELETE',
  })
  assert.equal(deletedSession.response.status, 200)
  assert.equal(deletedSession.payload.ok, true)
  const deletedSessionAgain = await request(`/api/sessions/${deleteCandidate.payload.id}`, {
    cookie: member.cookie,
    method: 'DELETE',
  })
  assert.equal(deletedSessionAgain.response.status, 404)
  const deletedSessionMessages = await request(`/api/sessions/${deleteCandidate.payload.id}/messages`, { cookie: member.cookie })
  assert.equal(deletedSessionMessages.response.status, 404)
  const crossAccountMessages = await request(`/api/sessions/${sessionId}/messages?limit=3`, { cookie: admin.cookie })
  assert.equal(crossAccountMessages.response.status, 404)
  const crossAccountCancel = await request(`/api/sessions/${sessionId}/cancel`, { cookie: admin.cookie, method: 'POST', body: {} })
  assert.equal(crossAccountCancel.response.status, 404)

  const configured = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: {
      translation: {
        apiKey: translationApiKey,
        baseUrl: providerBase,
        model: 'mock-translator',
        inputPricePerMillion: 2,
        outputPricePerMillion: 4,
      },
      image: {
        apiKey: imageApiKey,
        baseUrl: providerBase,
        model: 'gpt-image-2.6',
        inputPricePerMillion: 10,
        outputPricePerMillion: 20,
        costPerImage: 0.02,
      },
    },
  })
  assert.equal(configured.response.status, 200)
  assert.equal(configured.payload.image.configured, true)
  assert.equal(configured.payload.image.inputPricePerMillion, 10)
  assert.equal(configured.payload.image.outputPricePerMillion, 20)
  assert.equal(configured.payload.translation.baseUrl, providerBase)
  assert.equal(configured.payload.image.baseUrl, providerBase)
  assert.match(configured.payload.translation.systemPrompt, /host application owns authentication, sessions, storage/)
  assert.equal(Object.hasOwn(configured.payload.image, 'apiKey'), false)
  assert.equal(Object.hasOwn(configured.payload.translation, 'apiKey'), false)

  const customSystemPrompt = `${configured.payload.translation.systemPrompt}\n\nCustom test constraint: keep the requested composition precise.`
  const customPromptSaved = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: { translation: { systemPrompt: customSystemPrompt }, image: {} },
  })
  assert.equal(customPromptSaved.response.status, 200)
  assert.equal(customPromptSaved.payload.translation.systemPrompt, customSystemPrompt)
  const defaultPromptRestored = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: { translation: { systemPrompt: '' }, image: {} },
  })
  assert.equal(defaultPromptRestored.response.status, 200)
  assert.equal(defaultPromptRestored.payload.translation.systemPrompt, configured.payload.translation.systemPrompt)

  const invalidBaseUrl = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: { translation: { baseUrl: 'not-a-url' }, image: {} },
  })
  assert.equal(invalidBaseUrl.response.status, 400)

  const settingsDatabase = new DatabaseSync(join(dataDir, 'atelier.sqlite'))
  const storedProviders = settingsDatabase.prepare("SELECT value FROM app_settings WHERE key = 'providers'").get().value
  const [ivHex, tagHex, ciphertextHex] = storedProviders.split('.')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const legacyConfig = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8'))
  delete legacyConfig.image.inputPricePerMillion
  delete legacyConfig.image.outputPricePerMillion
  const legacyIv = randomBytes(12)
  const legacyCipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), legacyIv)
  const legacyCiphertext = Buffer.concat([
    legacyCipher.update(JSON.stringify(legacyConfig), 'utf8'),
    legacyCipher.final(),
  ])
  settingsDatabase.prepare("UPDATE app_settings SET value = ? WHERE key = 'providers'").run([
    legacyIv.toString('hex'),
    legacyCipher.getAuthTag().toString('hex'),
    legacyCiphertext.toString('hex'),
  ].join('.'))
  settingsDatabase.close()
  const legacyProviders = await request('/api/admin/providers', { cookie: admin.cookie })
  assert.equal(legacyProviders.payload.image.inputPricePerMillion, 0)
  assert.equal(legacyProviders.payload.image.outputPricePerMillion, 0)
  const restoredPrices = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: {
      translation: {},
      image: { inputPricePerMillion: 10, outputPricePerMillion: 20 },
    },
  })
  assert.equal(restoredPrices.payload.image.inputPricePerMillion, 10)
  assert.equal(restoredPrices.payload.image.outputPricePerMillion, 20)

  for (const providerName of ['translation', 'image']) {
    const tested = await request('/api/admin/providers/test', {
      cookie: admin.cookie,
      method: 'POST',
      body: { provider: providerName },
    })
    assert.equal(tested.response.status, 200)
    assert.equal(tested.payload.ok, true)
  }
  const unsavedModelFetch = await request('/api/admin/providers/test', {
    cookie: admin.cookie,
    method: 'POST',
    body: {
      provider: 'translation',
      baseUrl: providerBase,
      apiKey: translationApiKey,
    },
  })
  assert.equal(unsavedModelFetch.response.status, 200)
  assert.ok(unsavedModelFetch.payload.availableModels.includes('mock-translator'))

  const generated = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A quiet glass greenhouse above the clouds.', size: '1024x1024' },
  })
  assert.equal(generated.response.status, 200)
  assert.equal(generated.payload.imageModel, 'gpt-image-2.6')
  assert.equal(generated.payload.width, 1)
  assert.equal(generated.payload.height, 1)
  assert.equal(generated.payload.imageInputTokens, 13)
  assert.equal(generated.payload.imageOutputTokens, 2)
  assert.equal(generated.payload.costUsd, 0.02022)
  assert.equal(generated.payload.translationTokenCostUsd, 0.00005)
  assert.equal(generated.payload.imageTokenCostUsd, 0.00017)
  assert.equal(generated.payload.imageRequestCostUsd, 0.02)
  assert.equal(generated.payload.revisedPrompt, 'Provider-adjusted image prompt.')
  assert.equal(typeof generated.payload.imageName, 'string')
  assert.match(generated.payload.imageName, /^Generate image-[0-9a-f]{8}$/)

  const separateSession = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  const separateGeneration = await request(`/api/sessions/${separateSession.payload.id}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A red bicycle beside a stone bridge.', size: '1024x1024' },
  })
  assert.equal(separateGeneration.response.status, 200)
  const translationCalls = providerRequests.filter(item => item.path === '/v1/chat/completions')
  const agentInstructions = translationCalls[0].body.messages[0].content
  assert.match(agentInstructions, /host application owns authentication, sessions, storage/)
  assert.match(agentInstructions, /Do not call tools, browse, access\s+files/)
  assert.match(agentInstructions, /Return only the final prompt/)
  assert.equal(providerRequests.find(item => item.path === '/v1/images/generations').body.prompt, 'A clear English image-generation prompt.')
  assert.deepEqual(translationCalls[1].body.messages.map(message => message.role), ['system', 'user'])
  assert.equal(translationCalls[1].body.messages.at(-1).content, 'A red bicycle beside a stone bridge.')

  const imageId = generated.payload.generationId
  const ownImage = await request(`/api/generations/${imageId}/image`, { cookie: member.cookie })
  assert.equal(ownImage.response.status, 200)
  assert.equal(ownImage.response.headers.get('content-type'), 'image/png')
  assert.match(ownImage.response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)
  assert.equal((await ownImage.response.arrayBuffer()).byteLength > 30, true)
  const crossAccountImage = await request(`/api/generations/${imageId}/image`, { cookie: admin.cookie })
  assert.equal(crossAccountImage.response.status, 404)

  const messages = await request(`/api/sessions/${sessionId}/messages`, { cookie: member.cookie })
  assert.equal(messages.payload.items.length, 2)
  const firstGeneratedMessage = messages.payload.items.find(item => item.originalPrompt === 'A quiet glass greenhouse above the clouds.')
  assert.equal(firstGeneratedMessage?.imageWidth, 1)
  assert.equal(firstGeneratedMessage?.imageHeight, 1)
  assert.equal(firstGeneratedMessage?.generationStatus, 'succeeded')
  assert.equal(firstGeneratedMessage?.imageName, generated.payload.imageName)
  assert.equal(firstGeneratedMessage?.translationTokenCostUsd, 0.00005)
  assert.equal(firstGeneratedMessage?.imageTokenCostUsd, 0.00017)
  assert.equal(firstGeneratedMessage?.imageRequestCostUsd, 0.02)
  const matchingSession = await request('/api/sessions?q=glass%20greenhouse', { cookie: member.cookie })
  assert.deepEqual(matchingSession.payload.map(item => item.id), [sessionId])
  const crossAccountSearch = await request('/api/sessions?q=glass%20greenhouse', { cookie: admin.cookie })
  assert.deepEqual(crossAccountSearch.payload, [])
  const escapedWildcardSearch = await request('/api/sessions?q=%25', { cookie: member.cookie })
  assert.deepEqual(escapedWildcardSearch.payload, [])
  const invalidSearch = await request(`/api/sessions?q=${'a'.repeat(121)}`, { cookie: member.cookie })
  assert.equal(invalidSearch.response.status, 400)

  preferredModelUnavailable = true
  const fallback = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A second image to verify an explicit model fallback.', size: '1024x1024' },
  })
  preferredModelUnavailable = false
  assert.equal(fallback.response.status, 200)
  assert.equal(fallback.payload.imageModel, 'gpt-image-2.5')
  assert.equal(fallback.payload.requestedImageModel, 'gpt-image-2.6')
  assert.equal(fallback.payload.fallbackFrom, 'gpt-image-2.6')
  const followUpMessages = providerRequests.filter(item => item.path === '/v1/chat/completions')[2].body.messages
  assert.deepEqual(followUpMessages.map(message => message.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(followUpMessages[1].content, 'A quiet glass greenhouse above the clouds.')
  assert.equal(followUpMessages[2].content, 'A clear English image-generation prompt.')
  assert.equal(followUpMessages[3].content[0].type, 'text')
  assert.equal(followUpMessages[3].content[0].text, 'A second image to verify an explicit model fallback.')
  assert.equal(followUpMessages[3].content[1].type, 'image_url')
  assert.equal(followUpMessages[3].content[1].image_url.url, `data:image/png;base64,${png}`)

  const usage = await request('/api/usage', { cookie: member.cookie })
  assert.equal(usage.payload.sessions, 3)
  assert.equal(usage.payload.generations, 3)
  assert.equal(usage.payload.succeeded, 3)
  assert.equal(usage.payload.cancelled, 0)
  assert.equal(usage.payload.translationInputTokens, 33)
  assert.equal(usage.payload.translationOutputTokens, 21)
  assert.equal(usage.payload.imageInputTokens, 39)
  assert.equal(usage.payload.imageOutputTokens, 6)
  assert.ok(Math.abs(usage.payload.costUsd - 0.06066) < 1e-10)
  assert.ok(Math.abs(usage.payload.translationTokenCostUsd - 0.00015) < 1e-10)
  assert.ok(Math.abs(usage.payload.imageTokenCostUsd - 0.00051) < 1e-10)
  assert.ok(Math.abs(usage.payload.imageRequestCostUsd - 0.06) < 1e-10)
  assert.equal(usage.payload.unclassifiedCostUsd, 0)
  assert.equal(usage.payload.byModel.length, 2)
  assert.ok(usage.payload.byModel.some(row =>
    row.imageModel === 'gpt-image-2.6'
    && row.requestedImageModel === 'gpt-image-2.6'
    && row.fallbackFrom === null
    && row.sessions === 2
    && row.generations === 2
    && row.inputTokens === 48
    && row.outputTokens === 18
    && Math.abs(row.costUsd - 0.04044) < 1e-10,
  ))
  assert.ok(usage.payload.byModel.some(row =>
    row.imageModel === 'gpt-image-2.5'
    && row.requestedImageModel === 'gpt-image-2.6'
    && row.fallbackFrom === 'gpt-image-2.6'
    && row.sessions === 1
    && row.generations === 1
    && row.inputTokens === 24
    && row.outputTokens === 9
    && Math.abs(row.costUsd - 0.02022) < 1e-10,
  ))

  const archivedGeneratedSession = await request(`/api/sessions/${sessionId}`, {
    cookie: member.cookie,
    method: 'PATCH',
    body: { archived: true },
  })
  assert.equal(archivedGeneratedSession.response.status, 200)
  const hiddenGeneratedSession = await request('/api/sessions', { cookie: member.cookie })
  assert.equal(hiddenGeneratedSession.payload.some(item => item.id === sessionId), false)
  const archivedMessages = await request(`/api/sessions/${sessionId}/messages`, { cookie: member.cookie })
  assert.equal(archivedMessages.response.status, 200)
  assert.equal(archivedMessages.payload.items.filter(item => item.generationStatus === 'succeeded').length, 2)
  const archivedSearch = await request('/api/sessions?archived=true&q=glass%20greenhouse', { cookie: member.cookie })
  assert.deepEqual(archivedSearch.payload.map(item => item.id), [sessionId])
  const archivedImage = await request(archivedMessages.payload.items.find(item => item.generationStatus === 'succeeded').imageUrl, { cookie: member.cookie })
  assert.equal(archivedImage.response.status, 200)
  assert.match(archivedImage.response.headers.get('content-type'), /^image\/png$/)
  const restoredGeneratedSession = await request(`/api/sessions/${sessionId}`, {
    cookie: member.cookie,
    method: 'PATCH',
    body: { archived: false },
  })
  assert.equal(restoredGeneratedSession.payload.archivedAt, null)

  const stats = await request('/api/admin/stats', { cookie: admin.cookie })
  assert.equal(stats.payload.summary.sessions, 4)
  assert.equal(stats.payload.summary.generations, 3)
  assert.equal(stats.payload.summary.succeeded, 3)
  assert.equal(stats.payload.summary.cancelled, 0)
  assert.ok(Math.abs(stats.payload.summary.translationTokenCostUsd - 0.00015) < 1e-10)
  assert.ok(Math.abs(stats.payload.summary.imageTokenCostUsd - 0.00051) < 1e-10)
  assert.ok(Math.abs(stats.payload.summary.imageRequestCostUsd - 0.06) < 1e-10)
  assert.ok(stats.payload.byUser.some(row => row.email === 'admin@example.test'
    && row.sessions === 1
    && row.generations === 0))
  assert.ok(stats.payload.byUser.some(row => row.email === 'member@example.test'
    && row.sessions === 3
    && row.generations === 3))
  assert.ok(stats.payload.byUser.some(row => row.email === 'member@example.test'
    && Math.abs(row.translationTokenCostUsd - 0.00015) < 1e-10
    && Math.abs(row.imageTokenCostUsd - 0.00051) < 1e-10
    && Math.abs(row.imageRequestCostUsd - 0.06) < 1e-10))
  assert.ok(stats.payload.byModel.some(row =>
    row.imageModel === 'gpt-image-2.5'
    && row.requestedImageModel === 'gpt-image-2.6'
    && row.fallbackFrom === 'gpt-image-2.6'
    && row.sessions === 1
    && row.generations === 1
    && row.translationInputTokens === 11
    && row.translationOutputTokens === 7
    && row.imageInputTokens === 13
    && row.imageOutputTokens === 2,
  ))
  assert.ok(stats.payload.byMode.some(row =>
    row.imageMode === 'generation'
    && row.generations === 2
    && row.succeeded === 2
    && row.failed === 0
    && row.cancelled === 0,
  ))
  assert.ok(stats.payload.byMode.some(row =>
    row.imageMode === 'edit'
    && row.generations === 1
    && row.succeeded === 1
    && row.failed === 0
    && row.cancelled === 0,
  ))
  assert.deepEqual(stats.payload.byError, [{
    errorCode: 'success',
    generations: 3,
    succeeded: 3,
    failed: 0,
    cancelled: 0,
  }])
  assert.equal(stats.payload.traffic.minutes.length, 60)
  assert.equal(stats.payload.traffic.hours.length, 24)
  assert.equal(stats.payload.traffic.days.length, 30)
  assert.equal(stats.payload.traffic.months.length, 12)
  assert.equal(stats.payload.traffic.days.reduce((sum, row) => sum + row.generations, 0), 3)
  assert.equal(stats.payload.traffic.hours.reduce((sum, row) => sum + row.generations, 0), 3)
  assert.equal(stats.payload.traffic.minutes.reduce((sum, row) => sum + row.generations, 0), 3)
  assert.equal(stats.payload.traffic.months.reduce((sum, row) => sum + row.generations, 0), 3)
  const todayUsage = stats.payload.daily.find(row => row.day === new Date().toISOString().slice(0, 10))
  assert.ok(todayUsage)
  assert.equal(todayUsage.translationInputTokens, 33)
  assert.equal(todayUsage.translationOutputTokens, 21)
  assert.equal(todayUsage.imageInputTokens, 39)
  assert.equal(todayUsage.imageOutputTokens, 6)

  malformedImage = true
  const failed = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A small test for malformed dimensions.', size: '1024x1024' },
  })
  assert.equal(failed.response.status, 502)
  assert.equal(failed.payload.code, 'generated-image-dimension-mismatch')
  const failedMessages = await request(`/api/sessions/${sessionId}/messages`, { cookie: member.cookie })
  const malformedMessage = failedMessages.payload.items.find(item => item.errorCode === 'generated-image-dimension-mismatch')
  assert.equal(malformedMessage?.generationStatus, 'failed')
  assert.equal(malformedMessage?.imageInputTokens, 13)
  assert.equal(malformedMessage?.imageOutputTokens, 2)
  assert.equal(malformedMessage?.imageRequestCostUsd, 0.02)

  const finalUsage = await request('/api/usage', { cookie: member.cookie })
  assert.equal(finalUsage.payload.generations, 4)
  assert.equal(finalUsage.payload.succeeded, 3)
  assert.equal(finalUsage.payload.failed, 1)
  assert.equal(finalUsage.payload.cancelled, 0)
  assert.ok(Math.abs(finalUsage.payload.costUsd - 0.08088) < 1e-10)
  assert.ok(Math.abs(finalUsage.payload.translationTokenCostUsd - 0.0002) < 1e-10)
  assert.ok(Math.abs(finalUsage.payload.imageTokenCostUsd - 0.00068) < 1e-10)
  assert.ok(Math.abs(finalUsage.payload.imageRequestCostUsd - 0.08) < 1e-10)

  const logs = await request('/api/admin/logs', { cookie: admin.cookie })
  const serializedLogs = JSON.stringify(logs.payload)
  assert.equal(serializedLogs.includes(translationApiKey), false)
  assert.equal(serializedLogs.includes(imageApiKey), false)
  assert.equal(serializedLogs.includes('A quiet glass greenhouse above the clouds.'), false)
  assert.equal(serializedLogs.includes('A red bicycle beside a stone bridge.'), false)
  assert.ok(logs.payload.some(item => item.event === 'session.archived' && item.userId === member.user.id))
  assert.ok(logs.payload.some(item => item.event === 'session.restored' && item.userId === member.user.id))
  assert.ok(logs.payload.some(item => item.event === 'session.deleted' && item.userId === member.user.id))
  const firstLogPage = await request('/api/admin/logs?limit=2', { cookie: admin.cookie })
  assert.equal(firstLogPage.response.status, 200)
  assert.equal(firstLogPage.payload.length, 2)
  assert.ok(firstLogPage.payload[0].id > firstLogPage.payload[1].id)
  const olderLogPage = await request(`/api/admin/logs?limit=2&before=${firstLogPage.payload.at(-1).id}`, { cookie: admin.cookie })
  assert.equal(olderLogPage.response.status, 200)
  assert.equal(olderLogPage.payload.length, 2)
  assert.ok(olderLogPage.payload[0].id < firstLogPage.payload[1].id)
  const logToDelete = firstLogPage.payload[1]
  const memberDeleteLog = await request(`/api/admin/logs/${logToDelete.id}`, {
    cookie: member.cookie,
    method: 'DELETE',
  })
  assert.equal(memberDeleteLog.response.status, 403)
  const deletedLog = await request(`/api/admin/logs/${logToDelete.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(deletedLog.response.status, 200)
  assert.deepEqual(deletedLog.payload, { ok: true, id: logToDelete.id })
  const deletedLogLookup = await request(`/api/admin/logs?limit=250`, { cookie: admin.cookie })
  assert.equal(deletedLogLookup.payload.some(item => item.id === logToDelete.id), false)
  assert.ok(deletedLogLookup.payload.some(item => item.event === 'admin.logs.deleted'))
  const missingLogDelete = await request(`/api/admin/logs/${logToDelete.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(missingLogDelete.response.status, 404)
  const invalidLogCursor = await request('/api/admin/logs?limit=not-a-number', { cookie: admin.cookie })
  assert.equal(invalidLogCursor.response.status, 400)
  const invalidBeforeCursor = await request('/api/admin/logs?before=not-a-number', { cookie: admin.cookie })
  assert.equal(invalidBeforeCursor.response.status, 400)
  const filteredLogs = await request(
    '/api/admin/logs?email=MEMBER%40example.test&event=generation.completed&status=success&limit=20',
    { cookie: admin.cookie },
  )
  assert.equal(filteredLogs.response.status, 200)
  assert.equal(filteredLogs.payload.length, 3)
  assert.ok(filteredLogs.payload.every(item =>
    item.email === 'member@example.test' && item.event === 'generation.completed' && item.status === 'success',
  ))
  const literalWildcardLogs = await request('/api/admin/logs?event=%25&limit=20', { cookie: admin.cookie })
  assert.deepEqual(literalWildcardLogs.payload, [])
  const exportedLogsResponse = await fetch(`${apiBase}/api/admin/logs/export?email=MEMBER%40example.test&event=generation.completed&status=success`, {
    headers: { cookie: admin.cookie },
  })
  assert.equal(exportedLogsResponse.status, 200)
  assert.match(exportedLogsResponse.headers.get('content-type') ?? '', /^text\/csv/)
  assert.match(exportedLogsResponse.headers.get('content-disposition') ?? '', /audit-logs-\d{4}-\d{2}-\d{2}\.csv/)
  const exportedLogs = await exportedLogsResponse.text()
  assert.match(exportedLogs, /"Event","Status","Details"/)
  assert.match(exportedLogs, /generation\.completed/)
  assert.equal(exportedLogs.includes(translationApiKey), false)
  const invalidLogStatus = await request('/api/admin/logs?status=pending', { cookie: admin.cookie })
  assert.equal(invalidLogStatus.response.status, 400)
  const longLogFilter = await request(`/api/admin/logs?event=${'a'.repeat(121)}`, { cookie: admin.cookie })
  assert.equal(longLogFilter.response.status, 400)
  const filteredLogPage = await request('/api/admin/logs?event=generation.completed&limit=2', { cookie: admin.cookie })
  assert.equal(filteredLogPage.payload.length, 2)
  const olderFilteredLogPage = await request(
    `/api/admin/logs?event=generation.completed&limit=2&before=${filteredLogPage.payload.at(-1).id}`,
    { cookie: admin.cookie },
  )
  assert.equal(olderFilteredLogPage.payload.length, 1)
  assert.ok(olderFilteredLogPage.payload.every(item => item.event === 'generation.completed'))
  assert.equal(providerRequests.every(item => item.authorization?.startsWith('Bearer ')), true)
  assert.equal(providerRequests.some(item => item.path === '/v1/images/generations' && 'response_format' in item.body), false)

  malformedImage = false
  namedTranslation = true
  const modelDecidesGeneration = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'Let the image model choose the canvas.' },
  })
  assert.equal(modelDecidesGeneration.response.status, 200)
  assert.equal(modelDecidesGeneration.payload.imageSize, 'auto')
  assert.equal(modelDecidesGeneration.payload.imageName, 'Glass Greenhouse Above Clouds')
  const modelDecidesImageCall = providerRequests
    .filter(item => item.path === '/v1/images/edits')
    .at(-1)
  assert.ok(modelDecidesImageCall)
  assert.equal(modelDecidesImageCall.body.images[0].image_url, `data:image/png;base64,${png}`)
  assert.equal(modelDecidesImageCall.body.prompt, 'A clear English image-generation prompt.')
  assert.equal('size' in modelDecidesImageCall.body, false)

  const titledSession = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  const titledGeneration = await request(`/api/sessions/${titledSession.payload.id}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A floating greenhouse study above the clouds.' },
  })
  assert.equal(titledGeneration.response.status, 200)
  const titledSessions = await request('/api/sessions', { cookie: member.cookie })
  assert.equal(
    titledSessions.payload.find(item => item.id === titledSession.payload.id)?.title,
    'Floating Greenhouse Study',
  )

  const directDefaultGeneration = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'Use the direct image route default canvas.', translationEnabled: false },
  })
  assert.equal(directDefaultGeneration.response.status, 200)
  assert.equal(directDefaultGeneration.payload.imageSize, '1536x1024')
  assert.equal(providerRequests.filter(item => item.path === '/v1/images/generations').at(-1).body.size, '1536x1024')

  providerFailure = true
  const providerFailed = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'A provider failure with displayable feedback.', size: '1024x1024' },
  })
  assert.equal(providerFailed.response.status, 502)
  assert.equal(providerFailed.payload.code, 'provider-http-400')
  const providerFailedMessages = await request(`/api/sessions/${sessionId}/messages`, { cookie: member.cookie })
  const providerFailureMessage = providerFailedMessages.payload.items.find(item => item.errorCode === 'provider-http-400')
  assert.equal(providerFailureMessage?.modelFeedback, 'Provider rejected this image request.')
  assert.match(providerFailureMessage?.content ?? '', /Model feedback: Provider rejected this image request\./)
  providerFailure = false
  const usageBeforeImageNotConfigured = await request('/api/usage', { cookie: member.cookie })

  const customModel = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: { translation: {}, image: { model: 'vendor-image-pro' } },
  })
  assert.equal(customModel.response.status, 200)
  assert.equal(customModel.payload.image.model, 'vendor-image-pro')
  const customModelTest = await request('/api/admin/providers/test', {
    cookie: admin.cookie,
    method: 'POST',
    body: { provider: 'image' },
  })
  assert.equal(customModelTest.response.status, 200)
  assert.equal(customModelTest.payload.ok, true)
  assert.ok(customModelTest.payload.availableModels.includes('vendor-image-pro'))

  const cleared = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: { translation: {}, image: { clearApiKey: true } },
  })
  assert.equal(cleared.payload.image.configured, false)
  assert.equal(cleared.payload.translation.configured, true)
  const costBeforeImageNotConfigured = usageBeforeImageNotConfigured.payload.costUsd
  const translationOnlyFailure = await request(`/api/sessions/${sessionId}/generate`, {
    cookie: member.cookie,
    method: 'POST',
    body: { prompt: 'This request should stop before calling the image provider.', size: '1024x1024' },
  })
  assert.equal(translationOnlyFailure.response.status, 502)
  const usageAfterImageNotConfigured = await request('/api/usage', { cookie: member.cookie })
  assert.ok(Math.abs(usageAfterImageNotConfigured.payload.costUsd - costBeforeImageNotConfigured - 0.00005) < 1e-10)

  const paginationSession = await request('/api/sessions', { cookie: member.cookie, method: 'POST', body: {} })
  const tieTimestamp = '2026-11-08T12:00:00.000Z'
  const paginationDatabase = new DatabaseSync(join(dataDir, 'atelier.sqlite'))
  const insertPaginationMessage = paginationDatabase.prepare(
    `INSERT INTO messages(id, conversation_id, user_id, role, content, created_at)
     VALUES(?, ?, ?, 'user', ?, ?)`,
  )
  for (let index = 1; index <= 7; index += 1) {
    insertPaginationMessage.run(
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      paginationSession.payload.id,
      member.user.id,
      `Pagination message ${index}`,
      tieTimestamp,
    )
  }
  paginationDatabase.close()

  const latestPage = await request(`/api/sessions/${paginationSession.payload.id}/messages?limit=3`, { cookie: member.cookie })
  assert.deepEqual(latestPage.payload.items.map(item => item.content), [
    'Pagination message 5',
    'Pagination message 6',
    'Pagination message 7',
  ])
  assert.equal(latestPage.payload.hasMore, true)
  assert.equal(typeof latestPage.payload.nextCursor, 'string')
  const middlePage = await request(
    `/api/sessions/${paginationSession.payload.id}/messages?limit=3&before=${encodeURIComponent(latestPage.payload.nextCursor)}`,
    { cookie: member.cookie },
  )
  assert.deepEqual(middlePage.payload.items.map(item => item.content), [
    'Pagination message 2',
    'Pagination message 3',
    'Pagination message 4',
  ])
  assert.equal(middlePage.payload.hasMore, true)
  const oldestPage = await request(
    `/api/sessions/${paginationSession.payload.id}/messages?limit=3&before=${encodeURIComponent(middlePage.payload.nextCursor)}`,
    { cookie: member.cookie },
  )
  assert.deepEqual(oldestPage.payload.items.map(item => item.content), ['Pagination message 1'])
  assert.equal(oldestPage.payload.hasMore, false)
  assert.equal(oldestPage.payload.nextCursor, null)
  const invalidMessageLimit = await request(`/api/sessions/${paginationSession.payload.id}/messages?limit=nope`, { cookie: member.cookie })
  assert.equal(invalidMessageLimit.response.status, 400)
  const invalidMessageCursor = await request(`/api/sessions/${paginationSession.payload.id}/messages?before=nope`, { cookie: member.cookie })
  assert.equal(invalidMessageCursor.response.status, 400)
  const crossAccountPage = await request(`/api/sessions/${paginationSession.payload.id}/messages?limit=3`, { cookie: admin.cookie })
  assert.equal(crossAccountPage.response.status, 404)

  const shortPasswordReset = await request(`/api/admin/users/${created.payload.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { password: 'shorter' },
  })
  assert.equal(shortPasswordReset.response.status, 400)

  const resetPassword = testSecret('member-password-reset')
  const passwordReset = await request(`/api/admin/users/${created.payload.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { password: resetPassword },
  })
  assert.equal(passwordReset.response.status, 200)
  assert.equal(Object.hasOwn(passwordReset.payload, 'password'), false)

  const revokedSession = await request('/api/usage', { cookie: member.cookie })
  assert.equal(revokedSession.response.status, 401)
  const oldPasswordLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'member@example.test', password: memberPassword },
  })
  assert.equal(oldPasswordLogin.response.status, 401)

  const refreshedMember = await login('member@example.test', resetPassword)
  assert.equal(refreshedMember.user.role, 'user')
  const newPasswordUsage = await request('/api/usage', { cookie: refreshedMember.cookie })
  assert.equal(newPasswordUsage.response.status, 200)
  const postResetLogs = await request('/api/admin/logs', { cookie: admin.cookie })
  assert.equal(JSON.stringify(postResetLogs.payload).includes(resetPassword), false)

  const deniedDelete = await request(`/api/admin/users/${created.payload.id}`, {
    cookie: refreshedMember.cookie,
    method: 'DELETE',
  })
  assert.equal(deniedDelete.response.status, 403)
  const selfDelete = await request(`/api/admin/users/${admin.user.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(selfDelete.response.status, 400)
  const deleted = await request(`/api/admin/users/${created.payload.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.payload.ok, true)
  const deletedMemberUsage = await request('/api/usage', { cookie: refreshedMember.cookie })
  assert.equal(deletedMemberUsage.response.status, 401)
  const remainingUsers = await request('/api/admin/users', { cookie: admin.cookie })
  assert.equal(remainingUsers.payload.some(item => item.id === created.payload.id), false)
  assert.equal(existsSync(join(dataDir, 'images', created.payload.id)), false)
})

test('cancels an active generation and preserves an isolated retryable record', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-cancel-test-'))
  const dataDir = join(tempBase, 'data')
  let imageStartedResolve
  let imageAbortedResolve
  let releaseImage
  let imageCalls = 0
  const imageStarted = new Promise(resolve => { imageStartedResolve = resolve })
  const imageAborted = new Promise(resolve => { imageAbortedResolve = resolve })
  const imageRelease = new Promise(resolve => { releaseImage = resolve })
  const provider = createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' ? {} : await readRequest(req)
      if (req.url === '/v1/chat/completions') {
        return jsonResponse(res, {
          choices: [{ message: { content: 'A cancellable English image prompt.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        })
      }
      if (req.url === '/v1/images/generations') {
        imageCalls += 1
        if (imageCalls > 1) {
          return jsonResponse(res, {
            data: [{ b64_json: png, width: 1, height: 1 }],
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        }
        imageStartedResolve()
        const onAbort = () => {
          imageAbortedResolve()
          releaseImage()
        }
        req.once('aborted', onAbort)
        res.once('close', onAbort)
        await imageRelease
        if (res.destroyed) return
        return jsonResponse(res, {
          data: [{ b64_json: png, width: 1, height: 1 }],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      return jsonResponse(res, { error: 'not found' }, 404)
    } catch {
      if (!res.destroyed) jsonResponse(res, { error: 'invalid request' }, 400)
    }
  })
  const providerPort = await listen(provider)
  const apiPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const providerBase = `http://127.0.0.1:${providerPort}/v1`
  const password = testSecret('cancel-admin-password')
  const translationApiKey = testSecret('cancel-translation')
  const imageApiKey = testSecret('cancel-image')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: project,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      INITIAL_ADMIN_EMAIL: 'cancel-admin@example.test',
      INITIAL_ADMIN_PASSWORD: password,
      TRANSLATION_API_BASE_URL: providerBase,
      IMAGE_API_BASE_URL: providerBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    await stopChild(child)
    await new Promise(resolveClose => provider.close(resolveClose))
    await rm(tempBase, { recursive: true, force: true })
  })
  await waitForServer(child)

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = apiBase
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  async function login() {
    const { response, payload } = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'cancel-admin@example.test', password },
    })
    assert.equal(response.status, 200)
    const rawCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
    return { cookie: rawCookie.split(';')[0], user: payload.user }
  }

  async function waitWithTimeout(promise, label) {
    await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000)),
    ])
  }

  const admin = await login()
  const session = await request('/api/sessions', { cookie: admin.cookie, method: 'POST', body: {} })
  assert.equal(session.response.status, 201)
  const configured = await request('/api/admin/providers', {
    cookie: admin.cookie,
    method: 'PUT',
    body: {
      translation: { apiKey: translationApiKey, model: 'mock-translator' },
      image: { apiKey: imageApiKey, model: 'gpt-image-2.6' },
    },
  })
  assert.equal(configured.response.status, 200)

  const queuedBehindActive = await request(`/api/sessions/${session.payload.id}/queue`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'The queued item must survive cancellation.' },
  })
  assert.equal(queuedBehindActive.response.status, 201)

  const generationPromise = request(`/api/sessions/${session.payload.id}/generate`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'A scene that should be stopped while the image provider is waiting.', size: '1024x1024' },
  })
  await waitWithTimeout(imageStarted, 'image provider request')

  const pendingMessages = await request(`/api/sessions/${session.payload.id}/messages`, { cookie: admin.cookie })
  assert.equal(pendingMessages.response.status, 200)
  const pendingMessage = pendingMessages.payload.items.find(item => item.generationStatus === 'pending')
  assert.equal(pendingMessage?.generationStatus, 'pending')
  assert.match(pendingMessage?.content ?? '', /Processing/)

  const archiveWhileRunning = await request(`/api/sessions/${session.payload.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { archived: true },
  })
  assert.equal(archiveWhileRunning.response.status, 409)
  const deleteWhileRunning = await request(`/api/sessions/${session.payload.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(deleteWhileRunning.response.status, 409)

  const duplicate = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'A duplicate request that must be rejected while the first is running.', size: '1024x1024' },
  })
  assert.equal(duplicate.response.status, 409)

  const cancel = await request(`/api/sessions/${session.payload.id}/cancel`, {
    cookie: admin.cookie,
    method: 'POST',
    body: {},
  })
  assert.equal(cancel.response.status, 202)
  assert.equal(cancel.payload.ok, true)
  await waitWithTimeout(imageAborted, 'provider abort')

  const generation = await generationPromise
  assert.equal(generation.response.status, 409)
  assert.equal(generation.payload.code, 'generation-cancelled')
  assert.equal(generation.payload.generationId, cancel.payload.generationId)

  const messages = await request(`/api/sessions/${session.payload.id}/messages`, { cookie: admin.cookie })
  assert.equal(messages.response.status, 200)
  const cancelledMessage = messages.payload.items.find(item => item.errorCode === 'generation-cancelled')
  assert.equal(cancelledMessage?.generationStatus, 'failed')
  assert.match(cancelledMessage?.content ?? '', /generation was stopped/)

  const pausedQueue = await request(`/api/sessions/${session.payload.id}/queue`, { cookie: admin.cookie })
  assert.equal(pausedQueue.payload.paused, true)
  assert.deepEqual(pausedQueue.payload.items.map(item => item.id), [queuedBehindActive.payload.id])

  const wakeRequest = await request(`/api/sessions/${session.payload.id}/queue`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'A new request wakes the parked queue.' },
  })
  assert.equal(wakeRequest.response.status, 201)
  const resumedQueue = await request(`/api/sessions/${session.payload.id}/queue`, { cookie: admin.cookie })
  assert.equal(resumedQueue.payload.paused, false)
  assert.deepEqual(resumedQueue.payload.items.map(item => item.id), [
    queuedBehindActive.payload.id,
    wakeRequest.payload.id,
  ])

  const consumed = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { queueItemId: queuedBehindActive.payload.id },
  })
  assert.equal(consumed.response.status, 200)
  const afterConsumed = await request(`/api/sessions/${session.payload.id}/queue`, { cookie: admin.cookie })
  assert.deepEqual(afterConsumed.payload.items.map(item => item.id), [wakeRequest.payload.id])
  const afterConsumedMessages = await request(`/api/sessions/${session.payload.id}/messages`, { cookie: admin.cookie })
  assert.ok(afterConsumedMessages.payload.items.some(message =>
    message.role === 'assistant' && message.originalPrompt === 'The queued item must survive cancellation.',
  ))

  const usage = await request('/api/usage', { cookie: admin.cookie })
  assert.equal(usage.payload.generations, 2)
  assert.equal(usage.payload.succeeded, 1)
  assert.equal(usage.payload.failed, 1)
  assert.equal(usage.payload.cancelled, 1)

  const stats = await request('/api/admin/stats', { cookie: admin.cookie })
  assert.equal(stats.payload.summary.generations, 2)
  assert.equal(stats.payload.summary.succeeded, 1)
  assert.equal(stats.payload.summary.cancelled, 1)
  assert.ok(stats.payload.byUser.some(row =>
    row.email === 'cancel-admin@example.test' && row.generations === 2 && row.succeeded === 1 && row.cancelled === 1,
  ))

  const logs = await request('/api/admin/logs', { cookie: admin.cookie })
  assert.ok(logs.payload.some(item => item.event === 'generation.cancel_requested'))
  assert.ok(logs.payload.some(item => item.event === 'generation.cancelled'))
  assert.equal(JSON.stringify(logs.payload).includes(translationApiKey), false)
  assert.equal(JSON.stringify(logs.payload).includes(imageApiKey), false)
})

test('recovers persisted pending generations after a service restart', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-recovery-test-'))
  const dataDir = join(tempBase, 'data')
  const encryptionKey = randomBytes(32).toString('hex')
  const password = testSecret('recovery-admin-password')
  let port = await freePort()
  let child
  const startChild = async () => {
    port = await freePort()
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDir,
        APP_ENCRYPTION_KEY: encryptionKey,
        INITIAL_ADMIN_EMAIL: 'recovery-admin@example.test',
        INITIAL_ADMIN_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }
  t.after(async () => {
    await stopChild(child)
    await rm(tempBase, { recursive: true, force: true })
  })
  await startChild()

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = `http://127.0.0.1:${port}`
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  async function login() {
    const { response, payload } = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'recovery-admin@example.test', password },
    })
    assert.equal(response.status, 200)
    const rawCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
    return { cookie: rawCookie.split(';')[0], user: payload.user }
  }

  const admin = await login()
  const session = await request('/api/sessions', { cookie: admin.cookie, method: 'POST', body: {} })
  assert.equal(session.response.status, 201)
  await stopChild(child)

  const generationId = randomUUID()
  const requestId = randomUUID()
  const createdAt = new Date(Date.now() - 2_000).toISOString()
  const database = new DatabaseSync(join(dataDir, 'atelier.sqlite'))
  database.prepare(
    `INSERT INTO generations(id, conversation_id, user_id, prompt, status, image_model, requested_image_model,
      translation_model, request_id, created_at)
     VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    generationId, session.payload.id, admin.user.id, 'A pending request from before restart.',
    'gpt-image-2.6', 'gpt-image-2.6', 'mock-translator', requestId, createdAt,
  )
  database.prepare(
    `INSERT INTO messages(id, conversation_id, user_id, role, content, generation_id, created_at)
     VALUES(?, ?, ?, 'user', ?, NULL, ?)`,
  ).run(randomUUID(), session.payload.id, admin.user.id, 'A pending request from before restart.', createdAt)
  database.prepare(
    `INSERT INTO messages(id, conversation_id, user_id, role, content, generation_id, created_at)
     VALUES(?, ?, ?, 'assistant', ?, ?, ?)`,
  ).run(randomUUID(), session.payload.id, admin.user.id, 'Processing your image request...', generationId, createdAt)
  database.close()

  await startChild()
  const restartedAdmin = await login()
  const messages = await request(`/api/sessions/${session.payload.id}/messages`, { cookie: restartedAdmin.cookie })
  assert.equal(messages.response.status, 200)
  const recoveredMessage = messages.payload.items.find(item => item.generationStatus === 'failed')
  assert.equal(recoveredMessage?.errorCode, 'server-restarted')
  assert.match(recoveredMessage?.content ?? '', /Service restarted/)

  const logs = await request('/api/admin/logs', { cookie: restartedAdmin.cookie })
  assert.ok(logs.payload.some(item => item.event === 'generation.recovered' && item.details.generationId === generationId))
})

test('migrates legacy conversation tables before listing and archiving sessions', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-archive-migration-test-'))
  const dataDir = join(tempBase, 'data')
  const encryptionKey = randomBytes(32).toString('hex')
  const password = testSecret('archive-migration-password')
  let port
  let child
  const startChild = async () => {
    port = await freePort()
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDir,
        APP_ENCRYPTION_KEY: encryptionKey,
        INITIAL_ADMIN_EMAIL: 'migration-admin@example.test',
        INITIAL_ADMIN_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }
  t.after(async () => {
    if (child) await stopChild(child)
    await rm(tempBase, { recursive: true, force: true })
  })
  await startChild()

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = `http://127.0.0.1:${port}`
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  const login = async () => {
    const result = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'migration-admin@example.test', password },
    })
    assert.equal(result.response.status, 200)
    return (result.response.headers.getSetCookie?.()[0] ?? result.response.headers.get('set-cookie')).split(';')[0]
  }

  const cookie = await login()
  const created = await request('/api/sessions', { cookie, method: 'POST', body: {} })
  assert.equal(created.response.status, 201)
  await stopChild(child)

  const database = new DatabaseSync(join(dataDir, 'atelier.sqlite'))
  database.prepare(
    `INSERT INTO generations(id, conversation_id, user_id, prompt, status, image_model, translation_model, cost_usd, request_id, created_at)
     VALUES(?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    created.payload.id,
    database.prepare("SELECT id FROM users WHERE email = 'migration-admin@example.test'").get().id,
    'Legacy generation with a recorded total only.',
    'legacy-image-model',
    'legacy-translation-model',
    0.12345,
    randomUUID(),
    new Date().toISOString(),
  )
  database.exec('DROP INDEX conversations_user_archived_updated')
  database.exec('ALTER TABLE conversations DROP COLUMN archived_at')
  database.exec('ALTER TABLE messages DROP COLUMN reference_image_bytes')
  database.exec('ALTER TABLE messages DROP COLUMN image_mode')
  database.exec('ALTER TABLE generations DROP COLUMN reference_image_bytes')
  database.exec('ALTER TABLE generations DROP COLUMN image_mode')
  database.exec('ALTER TABLE generations DROP COLUMN image_request_cost_usd')
  database.exec('ALTER TABLE generations DROP COLUMN image_token_cost_usd')
  database.exec('ALTER TABLE generations DROP COLUMN translation_token_cost_usd')
  assert.equal(database.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'archived_at'), false)
  database.close()

  await startChild()
  const migratedDatabase = new DatabaseSync(join(dataDir, 'atelier.sqlite'), { readOnly: true })
  assert.ok(migratedDatabase.prepare('PRAGMA index_list(conversations)').all()
    .some(index => index.name === 'conversations_user_archived_updated'))
  assert.deepEqual(
    migratedDatabase.prepare('PRAGMA table_info(messages)').all()
      .filter(column => ['image_mode', 'reference_image_bytes'].includes(column.name))
      .map(column => column.name).sort(),
    ['image_mode', 'reference_image_bytes'],
  )
  assert.deepEqual(
    migratedDatabase.prepare('PRAGMA table_info(generations)').all()
      .filter(column => [
        'image_mode',
        'reference_image_bytes',
        'translation_token_cost_usd',
        'image_token_cost_usd',
        'image_request_cost_usd',
      ].includes(column.name))
      .map(column => column.name).sort(),
    ['image_mode', 'image_request_cost_usd', 'image_token_cost_usd', 'reference_image_bytes', 'translation_token_cost_usd'],
  )
  migratedDatabase.close()
  const migratedCookie = await login()
  const migratedStats = await request('/api/admin/stats', { cookie: migratedCookie })
  assert.equal(migratedStats.response.status, 200)
  assert.equal(migratedStats.payload.summary.costUsd, 0.12345)
  assert.equal(migratedStats.payload.summary.translationTokenCostUsd, 0)
  assert.equal(migratedStats.payload.summary.imageTokenCostUsd, 0)
  assert.equal(migratedStats.payload.summary.imageRequestCostUsd, 0)
  assert.equal(migratedStats.payload.summary.unclassifiedCostUsd, 0.12345)
  const sessions = await request('/api/sessions', { cookie: migratedCookie })
  assert.equal(sessions.response.status, 200)
  assert.equal(sessions.payload.some(session => session.id === created.payload.id && session.archivedAt === null), true)
  const archived = await request(`/api/sessions/${created.payload.id}`, {
    cookie: migratedCookie,
    method: 'PATCH',
    body: { archived: true },
  })
  assert.equal(archived.response.status, 200)
  assert.ok(archived.payload.archivedAt)
})

test('sends bounded reference images only to the edit provider and keeps payloads transient', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-edit-test-'))
  const dataDir = join(tempBase, 'data')
  const providerRequests = []
  const provider = createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' ? {} : await readRequest(req)
      providerRequests.push({ path: req.url, body })
      if (req.url === '/v1/chat/completions') {
        return jsonResponse(res, {
          choices: [{ message: { content: 'Change only the requested details and preserve the source image.' } }],
          usage: { prompt_tokens: 9, completion_tokens: 8 },
        })
      }
      if (req.url === '/v1/images/edits') {
        return jsonResponse(res, {
          data: [{ b64_json: png, width: 1, height: 1 }],
          usage: { input_tokens: 20, output_tokens: 3 },
        })
      }
      return jsonResponse(res, { error: 'not found' }, 404)
    } catch {
      return jsonResponse(res, { error: 'invalid request' }, 400)
    }
  })
  const providerPort = await listen(provider)
  const apiPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const providerBase = `http://127.0.0.1:${providerPort}/v1`
  const password = testSecret('edit-admin-password')
  const translationApiKey = testSecret('edit-translation')
  const imageApiKey = testSecret('edit-image')
  const encryptionKey = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: project,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: encryptionKey,
      INITIAL_ADMIN_EMAIL: 'edit-admin@example.test',
      INITIAL_ADMIN_PASSWORD: password,
      TRANSLATION_API_BASE_URL: providerBase,
      IMAGE_API_BASE_URL: providerBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    await stopChild(child)
    await new Promise(resolveClose => provider.close(resolveClose))
    await rm(tempBase, { recursive: true, force: true })
  })
  await waitForServer(child)

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = apiBase
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'edit-admin@example.test', password },
  })
  assert.equal(login.response.status, 200)
  const cookie = (login.response.headers.getSetCookie?.()[0] ?? login.response.headers.get('set-cookie')).split(';')[0]
  const configured = await request('/api/admin/providers', {
    cookie,
    method: 'PUT',
    body: {
      translation: { apiKey: translationApiKey, model: 'mock-translator', systemPrompt: 'Custom edit translation system prompt.' },
      image: { apiKey: imageApiKey, model: 'gpt-image-2.6' },
    },
  })
  assert.equal(configured.response.status, 200)
  const session = await request('/api/sessions', { cookie, method: 'POST', body: {} })
  assert.equal(session.response.status, 201)

  const dataUrl = `data:image/png;base64,${png}`
  const edited = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: {
      prompt: 'Replace the sky with a clear sunset.',
      size: '1536x1024',
      referenceImage: { dataUrl, mode: 'edit' },
    },
  })
  assert.equal(edited.response.status, 200)
  assert.equal(edited.payload.imageMode, 'edit')
  assert.equal(edited.payload.referenceImageBytes, Buffer.from(png, 'base64').length)
  const editCall = providerRequests.find(item => item.path === '/v1/images/edits')
  assert.ok(editCall)
  assert.equal(editCall.body.images[0].image_url, dataUrl)
  assert.equal('size' in editCall.body, false)
  assert.equal(providerRequests.some(item => item.path === '/v1/images/generations'), false)
  const translationCall = providerRequests.find(item => item.path === '/v1/chat/completions')
  assert.match(translationCall.body.messages[0].content, /Custom edit translation system prompt\./)
  assert.match(translationCall.body.messages[0].content, /explicit edit target/)
  assert.equal(translationCall.body.messages.at(-1).content[0].text, 'Replace the sky with a clear sunset.')
  assert.equal(translationCall.body.messages.at(-1).content[1].image_url.url, dataUrl)

  const messages = await request(`/api/sessions/${session.payload.id}/messages`, { cookie })
  assert.equal(messages.response.status, 200)
  assert.equal(messages.payload.items.find(item => item.role === 'user').imageMode, 'edit')
  assert.equal(messages.payload.items.find(item => item.role === 'user').referenceImageBytes, Buffer.from(png, 'base64').length)
  const editedAssistantMessage = messages.payload.items.find(item => item.role === 'assistant')
  assert.equal(editedAssistantMessage.imageMode, 'edit')
  assert.equal(editedAssistantMessage.referenceImageBytes, Buffer.from(png, 'base64').length)
  assert.equal('messageImageMode' in editedAssistantMessage, false)
  assert.equal('generationImageMode' in editedAssistantMessage, false)

  const referenced = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: {
      prompt: 'Create a new scene using the same color palette.',
      referenceImage: { dataUrl, mode: 'reference' },
    },
  })
  assert.equal(referenced.response.status, 200)
  assert.equal(referenced.payload.imageMode, 'reference')
  assert.equal(providerRequests.filter(item => item.path === '/v1/images/edits').length, 2)
  const referenceTranslation = providerRequests
    .filter(item => item.path === '/v1/chat/completions')
    .at(-1)
  assert.match(referenceTranslation.body.messages[0].content, /visual reference, not as an edit target/)

  const queuedEdit = await request(`/api/sessions/${session.payload.id}/queue`, {
    cookie,
    method: 'POST',
    body: {
      prompt: 'Apply the queued edit while preserving the composition.',
      referenceImage: { dataUrl, mode: 'edit' },
    },
  })
  assert.equal(queuedEdit.response.status, 201)
  assert.equal(queuedEdit.payload.hasReference, true)
  const queuedReferenceStored = new DatabaseSync(join(dataDir, 'atelier.sqlite'), { readOnly: true })
  const encryptedQueuedReference = queuedReferenceStored.prepare(
    'SELECT reference_image FROM generation_queue WHERE id = ?',
  ).get(queuedEdit.payload.id).reference_image
  queuedReferenceStored.close()
  assert.equal(encryptedQueuedReference.includes(png), false)
  assert.equal(encryptedQueuedReference.includes(dataUrl), false)

  const queuedGeneration = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: { queueItemId: queuedEdit.payload.id },
  })
  assert.equal(queuedGeneration.response.status, 200)
  assert.equal(queuedGeneration.payload.imageMode, 'edit')
  assert.equal(providerRequests.filter(item => item.path === '/v1/images/edits').length, 3)
  const queuedEditCall = providerRequests.filter(item => item.path === '/v1/images/edits').at(-1)
  assert.equal(queuedEditCall.body.images[0].image_url, dataUrl)
  const queueAfterGeneration = await request(`/api/sessions/${session.payload.id}/queue`, { cookie })
  assert.deepEqual(queueAfterGeneration.payload.items, [])
  const duplicateQueuedGeneration = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: { queueItemId: queuedEdit.payload.id },
  })
  assert.equal(duplicateQueuedGeneration.response.status, 409)
  assert.equal(providerRequests.filter(item => item.path === '/v1/images/edits').length, 3)

  const wrongMime = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: { prompt: 'Reject mismatched image bytes.', referenceImage: { dataUrl: `data:image/jpeg;base64,${png}`, mode: 'edit' } },
  })
  assert.equal(wrongMime.response.status, 400)
  const invalidMime = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: { prompt: 'Reject unsupported formats.', referenceImage: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', mode: 'edit' } },
  })
  assert.equal(invalidMime.response.status, 400)
  const tooLargeBytes = Buffer.alloc(10 * 1024 * 1024 + 1)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(tooLargeBytes)
  const tooLarge = await request(`/api/sessions/${session.payload.id}/generate`, {
    cookie,
    method: 'POST',
    body: {
      prompt: 'Reject oversized images.',
      referenceImage: { dataUrl: `data:image/png;base64,${tooLargeBytes.toString('base64')}`, mode: 'reference' },
    },
  })
  assert.equal(tooLarge.response.status, 413)
  assert.equal(providerRequests.filter(item => item.path === '/v1/images/edits').length, 3)

  const logs = await request('/api/admin/logs', { cookie })
  assert.equal(logs.response.status, 200)
  assert.equal(JSON.stringify(logs.payload).includes(png), false)
  assert.ok(logs.payload.some(item => item.event === 'generation.started' && item.details.imageMode === 'edit'))
  assert.ok(logs.payload.some(item => item.event === 'generation.started' && item.details.imageMode === 'reference'))
  assert.equal(messages.payload.items.filter(item => item.role === 'user')[0].referenceImageBytes, Buffer.from(png, 'base64').length)
  const database = new DatabaseSync(join(dataDir, 'atelier.sqlite'), { readOnly: true })
  const persisted = JSON.stringify({
    generations: database.prepare('SELECT * FROM generations').all(),
    messages: database.prepare('SELECT * FROM messages').all(),
    logs: database.prepare('SELECT * FROM audit_logs').all(),
  })
  database.close()
  assert.equal(persisted.includes(png), false)
})

test('persists encrypted generation queues with session and account isolation', async t => {
  const tempBase = await mkdtemp(join(tmpdir(), 'atelier-agent-queue-test-'))
  const dataDir = join(tempBase, 'data')
  const encryptionKey = randomBytes(32).toString('hex')
  const password = testSecret('queue-admin-password')
  const memberPassword = testSecret('queue-member-password')
  let port
  let child
  const startChild = async () => {
    port = await freePort()
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDir,
        APP_ENCRYPTION_KEY: encryptionKey,
        INITIAL_ADMIN_EMAIL: 'queue-admin@example.test',
        INITIAL_ADMIN_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }
  t.after(async () => {
    if (child) await stopChild(child)
    await rm(tempBase, { recursive: true, force: true })
  })
  await startChild()

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (method !== 'GET') {
      headers.origin = `http://127.0.0.1:${port}`
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : null
    return { response, payload }
  }

  async function login(email, loginPassword) {
    const result = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password: loginPassword },
    })
    assert.equal(result.response.status, 200)
    const rawCookie = result.response.headers.getSetCookie?.()[0] ?? result.response.headers.get('set-cookie')
    return { cookie: rawCookie.split(';')[0], user: result.payload.user }
  }

  const admin = await login('queue-admin@example.test', password)
  const memberCreated = await request('/api/admin/users', {
    cookie: admin.cookie,
    method: 'POST',
    body: { email: 'queue-member@example.test', password: memberPassword, role: 'user' },
  })
  assert.equal(memberCreated.response.status, 201)
  const member = await login('queue-member@example.test', memberPassword)

  const created = await request('/api/sessions', { cookie: admin.cookie, method: 'POST', body: {} })
  assert.equal(created.response.status, 201)
  const sessionId = created.payload.id
  const dataUrl = `data:image/png;base64,${png}`

  const first = await request(`/api/sessions/${sessionId}/queue`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'First queued request.', size: '1024x1536' },
  })
  assert.equal(first.response.status, 201)
  assert.equal(first.payload.prompt, 'First queued request.')
  assert.equal(first.payload.hasReference, false)

  const second = await request(`/api/sessions/${sessionId}/queue`, {
    cookie: admin.cookie,
    method: 'POST',
    body: {
      prompt: 'Second queued request with a reference.',
      referenceImage: { dataUrl, mode: 'reference' },
    },
  })
  assert.equal(second.response.status, 201)
  assert.equal(second.payload.size, 'auto')
  assert.equal(second.payload.hasReference, true)
  assert.equal(second.payload.referenceMode, 'reference')

  const listed = await request(`/api/sessions/${sessionId}/queue`, { cookie: admin.cookie })
  assert.equal(listed.response.status, 200)
  assert.equal(listed.payload.paused, false)
  assert.deepEqual(listed.payload.items.map(item => item.id), [first.payload.id, second.payload.id])
  assert.equal(JSON.stringify(listed.payload).includes(dataUrl), false)

  const reference = await request(`/api/sessions/${sessionId}/queue/${second.payload.id}/reference`, { cookie: admin.cookie })
  assert.equal(reference.response.status, 200)
  assert.equal(reference.payload.dataUrl, dataUrl)

  const database = new DatabaseSync(join(dataDir, 'atelier.sqlite'), { readOnly: true })
  const persisted = database.prepare(
    'SELECT reference_image, reference_image_bytes FROM generation_queue WHERE id = ?',
  ).get(second.payload.id)
  assert.equal(persisted.reference_image_bytes, Buffer.from(png, 'base64').length)
  assert.equal(persisted.reference_image.includes(png), false)
  assert.equal(persisted.reference_image.includes(dataUrl), false)
  database.close()

  const crossAccount = await request(`/api/sessions/${sessionId}/queue`, { cookie: member.cookie })
  assert.equal(crossAccount.response.status, 404)
  const crossItem = await request(`/api/sessions/${sessionId}/queue/${first.payload.id}`, {
    cookie: member.cookie,
    method: 'DELETE',
  })
  assert.equal(crossItem.response.status, 404)

  const edited = await request(`/api/sessions/${sessionId}/queue/${first.payload.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { prompt: 'First queued request, edited.', size: '1536x1024' },
  })
  assert.equal(edited.response.status, 200)
  assert.equal(edited.payload.prompt, 'First queued request, edited.')
  assert.equal(edited.payload.size, '1536x1024')

  const editedReference = await request(`/api/sessions/${sessionId}/queue/${second.payload.id}`, {
    cookie: admin.cookie,
    method: 'PATCH',
    body: { prompt: 'Second queued request, edited without replacing its reference.' },
  })
  assert.equal(editedReference.response.status, 200)
  assert.equal(editedReference.payload.prompt, 'Second queued request, edited without replacing its reference.')
  assert.equal(editedReference.payload.hasReference, true)
  assert.equal(editedReference.payload.referenceMode, 'reference')
  const preservedReference = await request(`/api/sessions/${sessionId}/queue/${second.payload.id}/reference`, {
    cookie: admin.cookie,
  })
  assert.equal(preservedReference.response.status, 200)
  assert.equal(preservedReference.payload.dataUrl, dataUrl)

  const modelSized = await request(`/api/sessions/${sessionId}/queue`, {
    cookie: admin.cookie,
    method: 'POST',
    body: { prompt: 'Let the image model choose the canvas.', size: 'auto', translationEnabled: false },
  })
  assert.equal(modelSized.response.status, 201)
  assert.equal(modelSized.payload.size, 'auto')
  assert.equal(modelSized.payload.translationEnabled, false)
  const modelSizedDatabase = new DatabaseSync(join(dataDir, 'atelier.sqlite'), { readOnly: true })
  const persistedModelSized = modelSizedDatabase
    .prepare('SELECT size, translation_enabled FROM generation_queue WHERE id = ?')
    .get(modelSized.payload.id)
  assert.equal(persistedModelSized.size, 'auto')
  assert.equal(persistedModelSized.translation_enabled, 0)
  modelSizedDatabase.close()
  const removedModelSized = await request(`/api/sessions/${sessionId}/queue/${modelSized.payload.id}`, {
    cookie: admin.cookie,
    method: 'DELETE',
  })
  assert.equal(removedModelSized.response.status, 200)

  await stopChild(child)
  await startChild()
  const restartedAdmin = await login('queue-admin@example.test', password)
  const afterRestart = await request(`/api/sessions/${sessionId}/queue`, { cookie: restartedAdmin.cookie })
  assert.equal(afterRestart.response.status, 200)
  assert.deepEqual(afterRestart.payload.items.map(item => item.prompt), [
    'First queued request, edited.',
    'Second queued request, edited without replacing its reference.',
  ])
  assert.equal(afterRestart.payload.items[1].hasReference, true)

  for (let index = 0; index < 10; index += 1) {
    const queued = await request(`/api/sessions/${sessionId}/queue`, {
      cookie: restartedAdmin.cookie,
      method: 'POST',
      body: { prompt: `Capacity request ${index}.` },
    })
    assert.equal(queued.response.status, 201)
  }
  const full = await request(`/api/sessions/${sessionId}/queue`, {
    cookie: restartedAdmin.cookie,
    method: 'POST',
    body: { prompt: 'This request exceeds the queue capacity.' },
  })
  assert.equal(full.response.status, 409)

  const removed = await request(`/api/sessions/${sessionId}/queue/${first.payload.id}`, {
    cookie: restartedAdmin.cookie,
    method: 'DELETE',
  })
  assert.equal(removed.response.status, 200)
  const remaining = await request(`/api/sessions/${sessionId}/queue`, { cookie: restartedAdmin.cookie })
  assert.equal(remaining.payload.items.length, 11)
  assert.equal(remaining.payload.items.some(item => item.id === first.payload.id), false)
})
