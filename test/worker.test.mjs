// Offline unit tests: no network, no secrets. Run with `node test/worker.test.mjs`.
import worker from "../src/index.js";

const BASE = "https://docker.i-yongqi.xyz";
const ENV = { LOGIN_USER: "u_test", LOGIN_PASS: "p_test" };
const MANIFEST_ACCEPT = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json";

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log("  ok   -", name);
  } else {
    failures += 1;
    console.log("  FAIL -", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

let calls = [];
function mockFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const target = typeof url === "string" ? url : url.toString();
    const headers = new Headers(init?.headers || {});
    calls.push({ url: target, method: init?.method, redirect: init?.redirect, headers });
    return responder(target, init);
  };
}

function basic(user, password) {
  return "Basic " + btoa(`${user}:${password}`);
}

function req(path, { method = "GET", auth = basic("u_test", "p_test"), headers = {} } = {}) {
  const all = new Headers(headers);
  if (auth !== null) all.set("authorization", auth);
  return new Request(BASE + path, { method, headers: all });
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const bearerChallenge = (realm, service, scope) =>
  `Bearer realm="${realm}",service="${service}",scope="${scope}"`;

// ---------------------------------------------------------------- gate

mockFetch(() => json({}, 200));
let res = await worker.fetch(req("/v2/", { auth: null }), ENV);
check("anonymous /v2/ -> 401", res.status === 401, res.status);
check("401 carries a Basic challenge", (res.headers.get("www-authenticate") || "").startsWith("Basic"));

res = await worker.fetch(req("/v2/", { auth: basic("u_test", "nope") }), ENV);
check("wrong password -> 401", res.status === 401, res.status);

res = await worker.fetch(req("/v2/", { auth: basic("other", "p_test") }), ENV);
check("wrong user -> 401", res.status === 401, res.status);

res = await worker.fetch(req("/v2/", { auth: `Bearer ${basic("u_test", "p_test")}` }), ENV);
check("Bearer-wrapped creds are rejected (client must use Basic)", res.status === 401, res.status);

res = await worker.fetch(req("/v2/"), ENV);
check("login with correct creds -> 200", res.status === 200, res.status);
check("ping answers with the v2 api version", res.headers.get("docker-distribution-api-version") === "registry/2.0");
check("ping does not touch the network", calls.length === 0, calls.length);

res = await worker.fetch(req("/v2/"), { LOGIN_USER: "u" });
check("missing secrets -> 503", res.status === 503, res.status);

// ---------------------------------------------------------------- routing

mockFetch(() => json({ schemaVersion: 2 }, 200, { "docker-content-digest": "sha256:abc" }));
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1.27", { headers: { accept: MANIFEST_ACCEPT } }), ENV);
check("docker.io is rewritten to registry-1.docker.io", calls[0]?.url === "https://registry-1.docker.io/v2/library/nginx/manifests/1.27", calls[0]?.url);
check("manifest accept header is forwarded verbatim", calls[0]?.headers.get("accept") === MANIFEST_ACCEPT);
check("client credentials are not sent upstream", calls[0]?.headers.get("authorization") === null);
check("redirects are followed inside the Worker", calls[0]?.redirect === "follow");
check("manifest status is passed through", res.status === 200, res.status);
check("digest header survives", res.headers.get("docker-content-digest") === "sha256:abc");
check("api version header is set even when upstream omits it", res.headers.get("docker-distribution-api-version") === "registry/2.0");
check("body survives", (await res.json()).schemaVersion === 2);

await worker.fetch(req("/v2/ghcr.io/owner/repo/manifests/v1"), ENV);
check("ghcr.io routing", calls.at(-1)?.url === "https://ghcr.io/v2/owner/repo/manifests/v1", calls.at(-1)?.url);

await worker.fetch(req("/v2/registry.k8s.io/pause/manifests/3.9"), ENV);
check("registry.k8s.io routing", calls.at(-1)?.url === "https://registry.k8s.io/v2/pause/manifests/3.9", calls.at(-1)?.url);

await worker.fetch(req("/v2/quay.io/prometheus/node-exporter/blobs/sha256:deadbeef?x=1"), ENV);
check("unknown but valid host is forwarded as-is", calls.at(-1)?.url === "https://quay.io/v2/prometheus/node-exporter/blobs/sha256:deadbeef?x=1", calls.at(-1)?.url);

await worker.fetch(req("/v2/lib/nginx/manifests/1"), ENV);
check("host without a dot is used as-is (no shorthand guessing)", calls.at(-1)?.url === "https://lib/v2/nginx/manifests/1", calls.at(-1)?.url);

res = await worker.fetch(req("/v2/ba_d/nginx/manifests/1"), ENV);
check("invalid host -> 400", res.status === 400, res.status);

res = await worker.fetch(req("/"), ENV);
check("non /v2 path -> 404", res.status === 404, res.status);

res = await worker.fetch(req("/v2/"), ENV);
check("bare /v2 -> 200", res.status === 200, res.status);

res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1", { method: "POST" }), ENV);
check("POST -> 405 pull-only", res.status === 405, res.status);
check("405 advertises GET, HEAD", res.headers.get("allow") === "GET, HEAD");

// ---------------------------------------------------------------- upstream auth

let tokenCalls = 0;
mockFetch((target) => {
  if (target.startsWith("https://auth.docker.io/token")) {
    tokenCalls += 1;
    return json({ token: "tok_1" });
  }
  if (calls.filter((c) => c.url === target).length === 1) {
    return json({ errors: [] }, 401, { "www-authenticate": bearerChallenge("https://auth.docker.io/token", "registry.docker.io", "repository:library/nginx:pull") });
  }
  return json({ schemaVersion: 2 });
});

res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1.27"), ENV);
const registryCalls = calls.filter((c) => c.url.startsWith("https://registry-1.docker.io"));
const retry = registryCalls[1];
check("401 triggers a retry", registryCalls.length === 2, registryCalls.length);
check("retry carries the anonymous token", retry?.headers.get("authorization") === "Bearer tok_1");
check("final response is the retried one", res.status === 200, res.status);
check("upstream Bearer challenge is not leaked to the client", res.headers.get("www-authenticate") === null);

const tokenUrl = calls.find((c) => c.url.startsWith("https://auth.docker.io/token"))?.url;
check("token request carries service", tokenUrl?.includes("service=registry.docker.io"), tokenUrl);
check("token request carries scope", tokenUrl?.includes("scope=repository%3Alibrary%2Fnginx%3Apull"), tokenUrl);

const before = tokenCalls;
await worker.fetch(req("/v2/docker.io/library/nginx/blobs/sha256:deadbeef"), ENV);
check("token is cached across requests", tokenCalls === before, tokenCalls);

mockFetch(() => json({}, 401));
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), ENV);
check("401 without a challenge falls back to a Basic challenge", res.status === 401 && (res.headers.get("www-authenticate") || "").startsWith("Basic"));

// multi-scope challenge becomes repeated scope parameters
let realmUrl = "";
mockFetch((target) => {
  if (target.startsWith("https://auth.example.com/token")) {
    realmUrl = target;
    return json({ access_token: "tok_2" });
  }
  return inspect();
});
function inspect() {
  return json({}, 401, { "www-authenticate": bearerChallenge("https://auth.example.com/token", "svc", "repository:a:pull repository:b:pull") });
}
await worker.fetch(req("/v2/example.com/a/b/manifests/1"), ENV);
check("multiple scopes are sent as repeated params", realmUrl.includes("scope=repository%3Aa%3Apull&scope=repository%3Ab%3Apull"), realmUrl);
check("access_token is accepted as a token", calls.some((c) => c.headers.get("authorization") === "Bearer tok_2"));

// ---------------------------------------------------------------- bodies, head, failures

mockFetch(() => new Response("layer-bytes", { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "11" } }));
res = await worker.fetch(req("/v2/docker.io/library/nginx/blobs/sha256:abc"), ENV);
check("blob body streams through", (await res.text()) === "layer-bytes");
check("blob content headers survive", res.headers.get("content-type") === "application/octet-stream" && res.headers.get("content-length") === "11");

mockFetch(() => new Response(null, { status: 200, headers: { "content-length": "11" } }));
res = await worker.fetch(req("/v2/docker.io/library/nginx/blobs/sha256:abc", { method: "HEAD" }), ENV);
check("HEAD is forwarded as HEAD", calls[0]?.method === "HEAD");
check("HEAD body is empty", (await res.text()) === "");

mockFetch(() => json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404));
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/nope"), ENV);
check("upstream 404 passes through", res.status === 404, res.status);

mockFetch(() => { throw new Error("boom"); });
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), ENV);
check("unreachable upstream -> 502", res.status === 502, res.status);

mockFetch(() => { throw new Error("boom"); });
res = await worker.fetch(req("/v2/ghcr.io/owner/repo/manifests/1"), ENV);
check("token endpoint failure still returns the upstream error", res.status === 502, res.status);

// ---------------------------------------------------------------- retries

let attempts = 0;
mockFetch(() => {
  attempts += 1;
  if (attempts === 1) throw new Error("flaky");
  return json({ schemaVersion: 2 });
});
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), ENV);
check("a single network blip is retried, not surfaced", res.status === 200 && attempts === 2, attempts);

attempts = 0;
mockFetch(() => {
  attempts += 1;
  return attempts < 3 ? json({ errors: [] }, 503) : json({ schemaVersion: 2 });
});
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), ENV);
check("upstream 503 is retried", res.status === 200 && attempts === 3, attempts);

attempts = 0;
mockFetch(() => {
  attempts += 1;
  throw new Error("down");
});
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), ENV);
check("persistent failure ends as 502 after all attempts", res.status === 502 && attempts === 5, attempts);

// ---------------------------------------------------------------- optional Docker Hub account

const HUB_ENV = { ...ENV, DOCKERHUB_USER: "hubuser", DOCKERHUB_TOKEN: "hubtok" };

mockFetch((target) => {
  if (target.startsWith("https://auth.docker.io/token")) return json({ token: "hub_1" });
  return json({ schemaVersion: 2 });
});
res = await worker.fetch(req("/v2/docker.io/library/nginx/manifests/1"), HUB_ENV);
check("account token is fetched before touching the registry", calls[0]?.url.startsWith("https://auth.docker.io/token") === true, calls[0]?.url);
check("token request authenticates with the account", calls[0]?.headers.get("authorization") === `Basic ${btoa("hubuser:hubtok")}`);
check("scope is built from the repository", calls[0]?.url.includes("scope=repository%3Alibrary%2Fnginx%3Apull"), calls[0]?.url);
check("registry request carries the account token", calls[1]?.headers.get("authorization") === "Bearer hub_1");
check("no anonymous first attempt when the account is configured", calls.length === 2, calls.length);

const beforeHub = calls.length;
await worker.fetch(req("/v2/docker.io/library/nginx/blobs/sha256:abc"), HUB_ENV);
check("account token is cached", calls.length === beforeHub + 1, calls.length - beforeHub);

mockFetch((target) => {
  if (target.startsWith("https://auth.docker.io/token")) return json({ token: "hub_2" });
  return json({ schemaVersion: 2 });
});
await worker.fetch(req("/v2/docker.io/owner/sub/img/manifests/tag"), HUB_ENV);
check("nested repository keeps its full path in the scope", calls[0]?.url.includes("scope=repository%3Aowner%2Fsub%2Fimg%3Apull"), calls[0]?.url);

mockFetch((target) => {
  if (target.startsWith("https://auth.docker.io/token")) return json({ token: "hub_3" });
  return json({}, 401, { "www-authenticate": bearerChallenge("https://auth.docker.io/token", "registry.docker.io", "repository:x:pull") });
});
res = await worker.fetch(req("/v2/docker.io/x/y/manifests/1"), HUB_ENV);
check("a 401 is still handled on top of the account token", res.status === 401 && (res.headers.get("www-authenticate") || "").startsWith("Basic"));

mockFetch(() => json({}, 200, { "ratelimit-remaining": "42", "docker-ratelimit-source": "203.0.113.7" }));
res = await worker.fetch(req("/v2/ghcr.io/a/b/manifests/1"), ENV);
check("upstream rate limit headers are visible to the client", res.headers.get("ratelimit-remaining") === "42" && res.headers.get("docker-ratelimit-source") === "203.0.113.7");

attempts = 0;
mockFetch(() => {
  attempts += 1;
  return attempts < 3 ? json({ errors: [] }, 429) : json({ schemaVersion: 2 });
});
res = await worker.fetch(req("/v2/ghcr.io/a/b/manifests/1"), ENV);
check("429 is retried", res.status === 200 && attempts === 3, attempts);

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
