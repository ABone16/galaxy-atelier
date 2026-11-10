const translationBase = new URL(process.env.TRANSLATION_API_BASE_URL)
const imageBase = new URL(process.env.IMAGE_API_BASE_URL)
const translationEndpoint = new URL(
  `${translationBase.pathname.replace(/\/+$/, '')}/chat/completions`,
  translationBase.origin,
)
const imageEndpoint = new URL(
  `${imageBase.pathname.replace(/\/+$/, '')}/images/generations`,
  imageBase.origin,
)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const headers = new Headers(init.headers)
  let body
  try {
    body = JSON.parse(String(init.body ?? ''))
  } catch {
    throw new Error('Production smoke provider received invalid JSON')
  }

  if (url.href === translationEndpoint.href) {
    const instructions = body.messages?.[0]?.content
    if (init.method !== 'POST'
      || headers.get('authorization') !== `Bearer ${process.env.ATELIER_SMOKE_TRANSLATION_KEY}`
      || body.model !== process.env.ATELIER_SMOKE_TRANSLATION_MODEL
      || typeof instructions !== 'string'
      || !instructions.includes('The host application owns authentication, sessions, storage')
      || !instructions.includes('Return only the final English image prompt.')
      || Object.hasOwn(body, 'tools')
      || Object.hasOwn(body, 'tool_choice')) {
      throw new Error('Production translation request did not match the fixed agent contract')
    }
    return jsonResponse({
      choices: [{ message: { content: 'A production-smoke illustration.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    })
  }

  if (url.href === imageEndpoint.href) {
    if (init.method !== 'POST'
      || headers.get('authorization') !== `Bearer ${process.env.ATELIER_SMOKE_IMAGE_KEY}`
      || body.model !== process.env.ATELIER_SMOKE_IMAGE_MODEL
      || body.prompt !== 'A production-smoke illustration.'
      || body.n !== 1
      || Object.hasOwn(body, 'tools')
      || Object.hasOwn(body, 'tool_choice')) {
      throw new Error('Production image request did not match the fixed generation contract')
    }
    return jsonResponse({
      data: [{ b64_json: png, revised_prompt: 'Mocked production image.' }],
      usage: { input_tokens: 3, output_tokens: 1 },
    })
  }

  throw new Error(`Production smoke blocked unexpected outbound request: ${url.origin}${url.pathname}`)
}
