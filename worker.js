const BASE_URL = "https://api.xiaomimimo.com"
const BOOTSTRAP_URL = `${BASE_URL}/api/free-ai/bootstrap`
const CHAT_URL = `${BASE_URL}/api/free-ai/openai/chat`
const KV_KEY = "mimo_jwt_pool"
const MAX_POOL = 30

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  return atob(str)
}

function parseExp(jwt) {
  try {
    const payload = JSON.parse(b64urlDecode(jwt.split(".")[1]))
    return typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 50 * 60_000
  } catch {
    return Date.now() + 50 * 60_000
  }
}

async function fetchJwt() {
  const res = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: crypto.randomUUID() }),
  })
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`)
  const data = await res.json()
  const jwt = data.jwt || data.token || data.access_token || data.key
  if (!jwt) throw new Error("bootstrap missing jwt")
  return jwt
}

async function getPool(kv) {
  const raw = await kv.get(KV_KEY, "json")
  if (!raw || !Array.isArray(raw)) return []
  return raw.filter((item) => item.exp - Date.now() > 60_000)
}

async function savePool(kv, pool) {
  await kv.put(KV_KEY, JSON.stringify(pool), { expirationTtl: 3600 })
}

async function getJwt(kv) {
  let pool = await getPool(kv)

  if (pool.length < MAX_POOL) {
    try {
      const jwt = await fetchJwt()
      pool.push({ jwt, exp: parseExp(jwt) })
      await savePool(kv, pool)
    } catch {}
  }

  if (pool.length === 0) throw new Error("no available jwt")

  const idx = Math.floor(Math.random() * pool.length)
  return pool[idx]
}

async function getRandomJwt(kv, excludeJwt = null) {
  let pool = await getPool(kv)
  if (excludeJwt) {
    pool = pool.filter((item) => item.jwt !== excludeJwt)
  }
  if (pool.length === 0) {
    try {
      const jwt = await fetchJwt()
      return { jwt, exp: parseExp(jwt) }
    } catch {
      throw new Error("no available jwt")
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

async function removeJwt(kv, jwt) {
  const pool = await getPool(kv)
  await savePool(
    kv,
    pool.filter((item) => item.jwt !== jwt),
  )
}

async function proxyRequest(request, kv) {
  const body = await request.json()
  const isStream = body.stream === true
  const MAX_RETRIES = 3

  const headers = (token) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Mimo-Source": "mimocode-cli-free",
  })

  let lastJwt = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const entry = await getRandomJwt(kv, lastJwt)
    lastJwt = entry.jwt

    const res = await fetch(CHAT_URL, { method: "POST", headers: headers(entry.jwt), body: JSON.stringify(body) })

    if (res.status === 401 || res.status === 403) {
      await removeJwt(kv, entry.jwt)
      continue
    }

    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return new Response(JSON.stringify({ error: { message: text, status: res.status } }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (isStream) {
      return new Response(res.body, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      })
    }

    return new Response(res.body, { headers: { "Content-Type": "application/json" } })
  }

  return new Response(JSON.stringify({ error: { message: "All retries failed (429/401)" } }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const kv = env.MIMO_JWT_KV

    if (!kv) return new Response("Missing MIMO_JWT_KV binding", { status: 500 })

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      })
    }

    if (url.pathname === "/admin/pool") {
      const pool = await getPool(kv)
      return new Response(JSON.stringify({ count: pool.length, max: MAX_POOL }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }

    if (url.pathname === "/admin/reset" && request.method === "POST") {
      await savePool(kv, [])
      return new Response(JSON.stringify({ message: "JWT pool cleared" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      try {
        const resp = await proxyRequest(request, kv)
        resp.headers.set("Access-Control-Allow-Origin", "*")
        return resp
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        })
      }
    }

    if (url.pathname === "/v1/models") {
      return new Response(
        JSON.stringify({ data: [{ id: "mimo-auto", object: "model", created: Date.now(), owned_by: "mimo" }] }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      )
    }

    return new Response("MiMo Auto Proxy — POST /v1/chat/completions", { status: 200 })
  },
}
