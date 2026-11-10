export type User = { id: string, email: string, role: 'user' | 'admin' }
export type SessionSummary = { id: string, title: string, archivedAt: string | null, createdAt: string, updatedAt: string, lastMessage: string | null, running: boolean }
export type QueueItem = {
  id: string
  prompt: string
  size: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
  translationEnabled: boolean
  referenceMode: 'edit' | 'reference'
  hasReference: boolean
  referenceImageBytes: number
  createdAt: string
  updatedAt: string
}
export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  generationId?: string
  imageUrl?: string
  inputImageUrl?: string
  originalPrompt?: string
  translatedPrompt?: string
  imageName?: string
  revisedPrompt?: string
  modelFeedback?: string
  imageMode?: 'generation' | 'edit' | 'reference'
  referenceImageBytes?: number
  imageWidth?: number | null
  imageHeight?: number | null
  imageSize?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024' | null
  translationEnabled?: boolean
  generationStatus?: 'pending' | 'succeeded' | 'failed'
  imageModel?: string
  requestedImageModel?: string | null
  translationModel?: string
  translationInputTokens?: number
  translationOutputTokens?: number
  imageInputTokens?: number
  imageOutputTokens?: number
  costUsd?: number
  translationTokenCostUsd?: number | null
  imageTokenCostUsd?: number | null
  imageRequestCostUsd?: number | null
  durationMs?: number
  errorCode?: string
}

export type MessagePage = {
  items: Message[]
  hasMore: boolean
  nextCursor: string | null
}

export type ProviderSettings = {
  translation: {
    configured: boolean
    model: string
    systemPrompt: string
    inputPricePerMillion: number
    outputPricePerMillion: number
    baseUrl: string
  }
  image: {
    configured: boolean
    model: string
    inputPricePerMillion: number
    outputPricePerMillion: number
    costPerImage: number
    baseUrl: string
  }
}

export type Usage = {
  sessions: number
  generations: number
  succeeded: number
  failed: number
  cancelled: number
  translationInputTokens: number
  translationOutputTokens: number
  imageInputTokens: number
  imageOutputTokens: number
  costUsd: number
  translationTokenCostUsd: number
  imageTokenCostUsd: number
  imageRequestCostUsd: number
  unclassifiedCostUsd: number
  averageDurationMs: number
  byModel: ModelUsage[]
}

export type ModelUsage = {
  imageModel: string
  requestedImageModel: string
  fallbackFrom: string | null
  translationModel: string
  sessions: number
  generations: number
  succeeded: number
  failed: number
  cancelled: number
  inputTokens: number
  outputTokens: number
  translationInputTokens: number
  translationOutputTokens: number
  imageInputTokens: number
  imageOutputTokens: number
  costUsd: number
  translationTokenCostUsd: number
  imageTokenCostUsd: number
  imageRequestCostUsd: number
  unclassifiedCostUsd: number
  averageDurationMs: number
}

export type AdminStats = {
  summary: {
    activeUsers: number
    sessions: number
    generations: number
    succeeded: number
    failed: number
    cancelled: number
    translationInputTokens: number
    translationOutputTokens: number
    imageInputTokens: number
    imageOutputTokens: number
    costUsd: number
    translationTokenCostUsd: number
    imageTokenCostUsd: number
    imageRequestCostUsd: number
    unclassifiedCostUsd: number
    averageDurationMs: number
  }
  byUser: Array<{
    id: string
    email: string
    role: string
    active: number
    sessions: number
    generations: number
    succeeded: number
    failed: number
    cancelled: number
    inputTokens: number
    outputTokens: number
    translationInputTokens: number
    translationOutputTokens: number
    imageInputTokens: number
    imageOutputTokens: number
    costUsd: number
    translationTokenCostUsd: number
    imageTokenCostUsd: number
    imageRequestCostUsd: number
    unclassifiedCostUsd: number
    averageDurationMs: number
  }>
  byModel: ModelUsage[]
  byMode: Array<{
    imageMode: 'generation' | 'edit' | 'reference'
    generations: number
    succeeded: number
    failed: number
    cancelled: number
    referenceImageBytes: number
    costUsd: number
    averageDurationMs: number
  }>
  byError: Array<{
    errorCode: string
    generations: number
    succeeded: number
    failed: number
    cancelled: number
  }>
  traffic: {
    minutes: TrafficBucket[]
    hours: TrafficBucket[]
    days: TrafficBucket[]
    months: TrafficBucket[]
  }
  daily: Array<{
    day: string
    generations: number
    succeeded: number
    failed: number
    cancelled: number
    costUsd: number
    translationTokenCostUsd: number
    imageTokenCostUsd: number
    imageRequestCostUsd: number
    unclassifiedCostUsd: number
    inputTokens: number
    outputTokens: number
    translationInputTokens: number
    translationOutputTokens: number
    imageInputTokens: number
    imageOutputTokens: number
  }>
}

export type TrafficBucket = {
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

export type Account = {
  id: string
  email: string
  role: 'user' | 'admin'
  active: number
  createdAt: string
  lastLoginAt: string | null
  generationCount: number
  costUsd: number
  translationTokenCostUsd: number
  imageTokenCostUsd: number
  imageRequestCostUsd: number
  unclassifiedCostUsd: number
}

export type AuditLog = {
  id: number
  requestId: string
  userId: string | null
  email: string | null
  event: string
  status: string
  details: Record<string, unknown>
  ipHash: string | null
  createdAt: string
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `Request failed (${response.status})`
    throw new Error(message)
  }
  return payload as T
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}))
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `Request failed (${response.status})`
    throw new Error(message)
  }
  return response.blob()
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export const api = {
  me: () => request<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('/api/auth/login', json('POST', { email, password })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', json('POST')),
  sessions: (archived = false, query = '', signal?: AbortSignal) => {
    const params = new URLSearchParams({ archived: String(archived) })
    if (query.trim()) params.set('q', query.trim())
    return request<SessionSummary[]>(`/api/sessions?${params}`, { signal })
  },
  createSession: () => request<SessionSummary>('/api/sessions', json('POST', {})),
  messages: (id: string, options: { limit?: number, before?: string } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) })
    if (options.before) query.set('before', options.before)
    return request<MessagePage>(`/api/sessions/${id}/messages?${query}`)
  },
  queue: (id: string) => request<{ items: QueueItem[], paused: boolean }>(`/api/sessions/${id}/queue`),
  enqueue: (id: string, value: { prompt: string, size: QueueItem['size'], translationEnabled?: boolean, referenceImage?: { dataUrl: string, mode: 'edit' | 'reference' } }) =>
    request<QueueItem>(`/api/sessions/${id}/queue`, json('POST', value)),
  updateQueue: (sessionId: string, itemId: string, value: { prompt?: string, size?: QueueItem['size'], translationEnabled?: boolean, referenceImage?: { dataUrl: string, mode: 'edit' | 'reference' } | null }) =>
    request<QueueItem>(`/api/sessions/${sessionId}/queue/${itemId}`, json('PATCH', value)),
  removeQueue: (sessionId: string, itemId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${sessionId}/queue/${itemId}`, { method: 'DELETE' }),
  queueReference: (sessionId: string, itemId: string) =>
    request<{ dataUrl: string }>(`/api/sessions/${sessionId}/queue/${itemId}/reference`),
  generationImage: (id: string) => requestBlob(`/api/generations/${encodeURIComponent(id)}/image`),
  renameSession: (id: string, title: string) => request(`/api/sessions/${id}`, json('PATCH', { title })),
  setSessionArchived: (id: string, archived: boolean) => request<{ id: string, title: string, archivedAt: string | null }>(`/api/sessions/${id}`, json('PATCH', { archived })),
  deleteSession: (id: string) => request<{ ok: boolean, id: string }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  generate: (id: string, prompt: string, size: QueueItem['size'], translationEnabled = true, referenceImage?: { dataUrl: string, mode: 'edit' | 'reference' }, queueItemId?: string) => request<{
    generationId: string
    imageUrl: string
    imageName: string
    prompt: string
    imageMode: 'generation' | 'edit' | 'reference'
    referenceImageBytes: number
    imageSize: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
    translationEnabled: boolean
    translatedPrompt: string
    revisedPrompt: string
    modelFeedback: string
    imageModel: string
    requestedImageModel: string
    fallbackFrom: string | null
    translationModel: string
    translationInputTokens: number
    translationOutputTokens: number
    imageInputTokens: number
    imageOutputTokens: number
    costUsd: number
    translationTokenCostUsd: number
    imageTokenCostUsd: number
    imageRequestCostUsd: number
    durationMs: number
    mediaType: string
    width: number
    height: number
  }>(`/api/sessions/${id}/generate`, json('POST', {
    prompt,
    size,
    translationEnabled,
    ...(queueItemId ? { queueItemId } : {}),
    ...(referenceImage ? { referenceImage } : {}),
  })),
  cancelGeneration: (id: string) => request<{ ok: boolean, generationId: string }>(`/api/sessions/${id}/cancel`, json('POST')),
  usage: () => request<Usage>('/api/usage'),
  adminStats: () => request<AdminStats>('/api/admin/stats'),
  adminUsers: () => request<Account[]>('/api/admin/users'),
  createUser: (email: string, password: string, role: string) =>
    request('/api/admin/users', json('POST', { email, password, role })),
  updateUser: (id: string, values: { active?: boolean, role?: string, password?: string }) =>
    request(`/api/admin/users/${id}`, json('PATCH', values)),
  deleteUser: (id: string) =>
    request<{ ok: boolean, id: string }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  providers: () => request<ProviderSettings>('/api/admin/providers'),
  saveProviders: (value: {
    translation: { apiKey?: string, clearApiKey?: boolean, baseUrl: string, model: string, systemPrompt: string, inputPricePerMillion: number, outputPricePerMillion: number }
    image: {
      apiKey?: string
      clearApiKey?: boolean
      baseUrl: string
      model: string
      inputPricePerMillion: number
      outputPricePerMillion: number
      costPerImage: number
    }
  }) => request<ProviderSettings>('/api/admin/providers', json('PUT', value)),
  testProvider: (provider: 'translation' | 'image', options: { baseUrl?: string, apiKey?: string } = {}) => request<{
    ok: boolean
    model: string
    availableModels: string[]
    message: string
  }>(
    '/api/admin/providers/test',
    json('POST', { provider, ...options }),
  ),
  logs: (options: { limit?: number, before?: number, email?: string, event?: string, status?: '' | 'success' | 'failure' } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) })
    if (options.before !== undefined) query.set('before', String(options.before))
    if (options.email?.trim()) query.set('email', options.email.trim())
    if (options.event?.trim()) query.set('event', options.event.trim())
    if (options.status) query.set('status', options.status)
    return request<AuditLog[]>(`/api/admin/logs?${query}`)
  },
  deleteLog: (id: number) => request<{ ok: boolean, id: number }>(`/api/admin/logs/${id}`, { method: 'DELETE' }),
  logsExport: (options: { email?: string, event?: string, status?: '' | 'success' | 'failure' } = {}) => {
    const query = new URLSearchParams({ format: 'csv' })
    if (options.email?.trim()) query.set('email', options.email.trim())
    if (options.event?.trim()) query.set('event', options.event.trim())
    if (options.status) query.set('status', options.status)
    return requestBlob(`/api/admin/logs/export?${query}`)
  },
}
