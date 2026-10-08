// Cloudflare Worker: a pull-only Docker Registry v2 proxy behind a shared password.
//
// Clients log in to this proxy and pull through a prefixed reference, where the
// path segment right after /v2/ is the real public registry host:
//
//   docker login docker.i-yongqi.xyz -u <LOGIN_USER> -p <LOGIN_PASS>
//   docker pull  docker.i-yongqi.xyz/docker.io/library/nginx:1.27
//   docker pull  docker.i-yongqi.xyz/ghcr.io/owner/repo:v1
//   docker pull  docker.i-yongqi.xyz/registry.k8s.io/pause:3.9
//
// References are always written in full; nothing is guessed from a shorthand.
// The upstream is picked per request from the path, so any public registry works
// without a list.
//
// Two deliberate properties:
//   * No upstream credentials are stored. When an upstream answers 401 with a
//     Bearer challenge, the anonymous token named by that challenge (realm,
//     service, scope) is fetched, used for the retry and kept in a short-lived
//     in-memory cache. Nothing is persisted.
//   * The client only ever talks to Cloudflare. Redirects are followed here, so
//     blobs stream back through the edge instead of sending the client to a CDN
//     it may not reach.
//
// The gate is HTTP Basic on every request, including /v2/. Upstream Bearer
// challenges are never passed through, so the Docker client always keeps using
// the proxy's own password.

const API_VERSION = "registry/2.0";
const AUTH_CHALLENGE = 'Basic realm="docker-proxy", charset="UTF-8"';
const TOKEN_CACHE_MAX = 200;
const TOKEN_TTL_CAP_MS = 5 * 60 * 1000;

// Reference host -> endpoint that actually answers, for names that are aliases.
const HOST_ALIASES = {
  "docker.io": "registry-1.docker.io",
  "index.docker.io": "registry-1.docker.io",
};

// Labels, optional dots, optional explicit port.
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{2,5})?$/;

// Client request headers copied to the upstream request. `accept` must travel
// verbatim: manifests are multi-arch and the client picks the platform with it.
const REQUEST_HEADERS = [
  "accept",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  "user-agent",
];

// Upstream response headers copied back to the client.
const RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "docker-content-digest",
  "etag",
  "last-modified",
  "location",
  "range",
  "retry-after",
];

const tokenCache = new Map();

function registryError(status, code, message) {
  return new Response(JSON.stringify({ errors: [{ code, message }] }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "docker-distribution-api-version": API_VERSION,
    },
  });
}

function unauthorized(message) {
  const response = registryError(401, "UNAUTHORIZED", message || "authentication required");
  response.headers.set("www-authenticate", AUTH_CHALLENGE);
  return response;
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

// Returns "ok", "unauthorized" or "unconfigured".
function checkClient(request, env) {
  if (!env.LOGIN_USER || !env.LOGIN_PASS) return "unconfigured";
  const header = request.headers.get("authorization") || "";
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!match) return "unauthorized";

  let decoded;
  try {
    decoded = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "unauthorized";
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return "unauthorized";

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (!constantTimeEqual(user, env.LOGIN_USER)) return "unauthorized";
  if (!constantTimeEqual(password, env.LOGIN_PASS)) return "unauthorized";
  return "ok";
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream) {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const apiVersion = upstream.headers.get("docker-distribution-api-version");
  headers.set("docker-distribution-api-version", apiVersion || API_VERSION);
  if (upstream.status === 401) headers.set("www-authenticate", AUTH_CHALLENGE);
  return headers;
}

function passthrough(upstream) {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

// Parses `Bearer realm="...",service="...",scope="..."` (quoted or bare values).
function parseBearerChallenge(challenge) {
  const text = (challenge || "").trim();
  const scheme = text.split(/[\s,]+/, 1)[0].toLowerCase();
  if (scheme !== "bearer") return null;

  const params = {};
  const pattern = /([a-z_]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    params[match[1].toLowerCase()] = match[2] === undefined ? match[3] : match[2];
  }
  if (!params.realm) return null;
  return params;
}

function rememberToken(key, token) {
  let ttl = TOKEN_TTL_CAP_MS;
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.exp === "number") ttl = Math.min(ttl, claims.exp * 1000 - Date.now() - 30_000);
  } catch {
    // Not a JWT (or unreadable): keep the conservative cap.
  }
  if (ttl <= 0) ttl = 30_000;
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(key, { token, expiresAt: Date.now() + ttl });
}

// Fetches (or reuses) the anonymous token an upstream Bearer challenge asks for.
async function bearerToken(challenge) {
  const params = parseBearerChallenge(challenge);
  if (!params) return null;

  const key = `${params.realm}|${params.service || ""}|${params.scope || ""}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  tokenCache.delete(key);

  let realm;
  try {
    realm = new URL(params.realm);
  } catch {
    return null;
  }
  if (realm.protocol !== "https:") return null;
  if (params.service) realm.searchParams.set("service", params.service);
  for (const scope of (params.scope || "").split(/\s+/)) {
    if (scope) realm.searchParams.append("scope", scope);
  }

  let response;
  try {
    response = await fetchUpstream(realm.toString(), { headers: { accept: "application/json" }, redirect: "follow" });
  } catch {
    return null;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const token = typeof payload?.token === "string" ? payload.token
    : typeof payload?.access_token === "string" ? payload.access_token
    : null;
  if (!token) return null;

  rememberToken(key, token);
  return token;
}

// Transient network failures are common on the way to Docker Hub, and every
// method this proxy speaks (GET/HEAD) is safe to repeat: retry briefly instead
// of failing the whole `docker pull` at the first blip.
const RETRY_ATTEMPTS = 5;
const RETRYABLE_STATUS = [502, 503, 504];

const backoff = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 500)));

async function fetchUpstream(target, init) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(target, init);
      if (RETRYABLE_STATUS.includes(response.status) && attempt < RETRY_ATTEMPTS) {
        await response.body?.cancel().catch(() => {});
        await backoff(attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_ATTEMPTS) await backoff(attempt);
    }
  }
  throw lastError;
}

function ping() {
  return new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "docker-distribution-api-version": API_VERSION,
    },
  });
}

export default {
  async fetch(request, env) {
    const client = checkClient(request, env);
    if (client === "unconfigured") {
      return registryError(503, "UNAVAILABLE", "LOGIN_USER / LOGIN_PASS are not configured on this Worker");
    }
    if (client === "unauthorized") return unauthorized("wrong or missing login for this proxy");

    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const response = registryError(405, "UNSUPPORTED", `${method} is not supported (pull-only proxy)`);
      response.headers.set("allow", "GET, HEAD");
      return response;
    }

    const url = new URL(request.url);
    if (url.pathname === "/v2" || url.pathname === "/v2/") return ping();
    if (!url.pathname.startsWith("/v2/")) {
      return registryError(404, "NAME_UNKNOWN", "expected /v2/<upstream-host>/<repository>/manifests|blobs/<reference>");
    }

    const segments = url.pathname.slice(4).split("/");
    const reference = segments.shift();
    if (!reference) {
      return registryError(404, "NAME_UNKNOWN", "missing upstream host: /v2/<upstream-host>/...");
    }

    const host = HOST_ALIASES[reference.toLowerCase()] || reference.toLowerCase();
    if (!HOST_RE.test(host)) {
      return registryError(400, "NAME_INVALID", `"${reference}" is not a valid upstream host`);
    }

    const target = `https://${host}/v2/${segments.join("/")}${url.search}`;
    const headers = requestHeaders(request);

    let upstream;
    try {
      upstream = await fetchUpstream(target, { method, headers, redirect: "follow" });
    } catch (error) {
      return registryError(502, "UNKNOWN", `upstream ${host} unreachable: ${error.message}`);
    }

    if (upstream.status === 401) {
      const token = await bearerToken(upstream.headers.get("www-authenticate"));
      if (token) {
        await upstream.body?.cancel().catch(() => {});
        const authorized = new Headers(headers);
        authorized.set("authorization", `Bearer ${token}`);
        try {
          upstream = await fetchUpstream(target, { method, headers: authorized, redirect: "follow" });
        } catch (error) {
          return registryError(502, "UNKNOWN", `upstream ${host} unreachable: ${error.message}`);
        }
      }
    }

    return passthrough(upstream);
  },
};
