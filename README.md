# Cloudflare Docker registry proxy

A small Cloudflare Worker that proxies **any public container registry** behind one
of your own domains, so you can pull through Cloudflare instead of talking to the
registry directly:

```sh
docker login docker.i-yongqi.xyz -u <LOGIN_USER> -p <LOGIN_PASS>

docker pull docker.i-yongqi.xyz/docker.io/library/nginx:1.27
docker pull docker.i-yongqi.xyz/ghcr.io/owner/repo:v1
docker pull docker.i-yongqi.xyz/registry.k8s.io/pause:3.9
```

The image reference is always written in full — the segment right after `/v2/` is
the real registry host. Nothing is guessed from a shorthand, and there is no
registry list to maintain: any public registry works.

Built for a network where Docker Hub and its CDN are flaky: the client only ever
talks to Cloudflare, and the Worker does the talking to the origin.

## How it works

* **Pull only.** `GET` and `HEAD` are proxied; `push` returns 405.
* **Password gate.** Every request, `/v2/` included, needs HTTP Basic credentials
  that match the `LOGIN_USER` / `LOGIN_PASS` secrets. Anyone without them gets
  401, which keeps a shared Worker from being used by everybody.
* **No stored upstream credentials.** When an upstream answers `401` with a
  `Bearer` challenge, the anonymous token the challenge names (realm, service,
  scope) is fetched, used for the retry, and cached in memory for its lifetime.
  Nothing is persisted, and the upstream's challenge is never forwarded to the
  client — so the Docker client keeps using the proxy password.
* **Blobs stream through the edge.** Upstream redirects (Docker Hub sends blobs
  to a CDN) are followed inside the Worker, so the client is never sent to a host
  it might not reach.
* **Retries.** Network blips and 502/503/504 are retried with backoff, because
  every method here is safe to repeat and a single blip should not kill a pull.
* **`docker.io` is the only alias.** The reference name is rewritten to
  `registry-1.docker.io`; every other host is used verbatim.

Supported by tests: multi-arch manifests (the client `Accept` header travels
verbatim), blob and manifest streaming, digest headers, `HEAD`, retries, the
gate, and the token exchange.

## Which registries work

Verified against the deployed Worker on 2026-10-09 with real `docker pull`
commands (Docker verifies every digest):

| Upstream | Status |
|---|---|
| `ghcr.io` | works |
| `registry.k8s.io` | works |
| `quay.io` | works |
| `gcr.io` | works |
| `mcr.microsoft.com` | works |
| `mirror.gcr.io` | works (Docker Hub content via Google's cache) |
| `docker.io` | **429** — Docker Hub's anonymous per-IP limit, see below |

Everything else is forwarded the same way; there is no allow-list.

## Docker Hub (`docker.io`) and its rate limit

`docker.io` is the one upstream that fails, for a reason outside this code:
Docker Hub limits *anonymous* pulls per egress IP (100 per 6 hours) and
Cloudflare's egress IPs are shared widely enough to sit over that limit
essentially permanently. The upstream says so itself:

```json
{"errors":[{"code":"TOOMANYREQUESTS","message":"You have reached your unauthenticated pull rate limit. ..."}]}
```

The diagnosis is unambiguous: the same Worker, same egress IP, same moment —
`docker.io` answers 429 while the six registries above answer 200.

Two ways around it. They can coexist; **A** needs nothing but a different
reference, **B** keeps the `docker.io` spelling.

### A. Pull Docker Hub images through `mirror.gcr.io` (no credentials)

Google runs a Docker Hub mirror. Paths are identical to Docker Hub, only the
host changes, and the bytes are the same (digests match):

```sh
docker pull docker.i-yongqi.xyz/mirror.gcr.io/library/nginx:1.27-alpine
#               same image as docker.io/library/nginx:1.27-alpine
```

Checked on 2026-10-09: 10/10 sampled images byte-identical to `docker.io`
(official `library/*` plus `bitnami/`, `grafana/`, `linuxserver/`, `smallstep/`,
`jgraph/`), and a digest-pinned reference worked as well. Caveats:

* **Write the reference in full** — `docker.io/library/nginx` becomes
  `mirror.gcr.io/library/nginx`, official-image `library/` prefix included.
* **Only explicit references reach the Worker.** `image: nginx` in a Compose
  file or a Helm chart resolves to `docker.io` and never touches this proxy;
  rewrite those to `docker.i-yongqi.xyz/mirror.gcr.io/...`, or add a
  `registry-mirrors` entry pointing at
  `https://docker.i-yongqi.xyz/mirror.gcr.io` if the editing gets tedious.
* **Public images only** — `mirror.gcr.io` is anonymous, so private Docker Hub
  repositories are out either way.
* It is Google's service, not ours: a pull-through cache can occasionally miss
  or lag an image. When that happens, use `docker.io/...` through the Worker —
  it is rate-limited, not blocked.

### B. Configure a Docker Hub account (keeps `docker.io` in the reference)

Add `DOCKERHUB_USER` and `DOCKERHUB_TOKEN` (a free Docker Hub account plus a
read-only personal access token) as Worker secrets. Requests to Docker Hub are
then authenticated up front and counted against that account (200 pulls per 6
hours, per account) instead of the shared IP — which is exactly what the gate
password is for: only you spend that quota. Without the secrets the Worker stays
anonymous, exactly as before.

## Deploy

Everything below is done once, in the Cloudflare dashboard.

1. **Create the Worker from this repo**: Workers & Pages → Create → Workers →
   connect the GitHub repository. Keep the default build settings — the Worker
   name (`cloudflare-docker-proxy`) and entrypoint come from `wrangler.toml`.
2. **Add the gate password**: Worker → Settings → Variables and Secrets → add
   `LOGIN_PASS` as type *Secret*. `LOGIN_USER` is not secret and comes from
   `[vars]` in `wrangler.toml`; the password is deliberately not in this public
   repo. Until the Secret exists the Worker answers 503 to everything, so add it
   right after the first deploy. Change the password later by editing the Secret —
   no rebuild needed.
   Optionally add `DOCKERHUB_USER` and `DOCKERHUB_TOKEN` as Secrets too (see
   [Docker Hub rate limits](#docker-hub-rate-limits)).
3. **Make sure the domain is free**: a custom domain can only be attached to one
   Worker. If `docker.i-yongqi.xyz` is already on another (for example
   freshly created) Worker, remove it there first — `wrangler.toml` declares it
   and the build attaches it to this Worker.
4. Deploy. Later pushes to `main` rebuild automatically.

`daemon.json` needs no changes: these pulls use an explicit registry host, so
Docker's `registry-mirrors` setting does not apply to them.

## Use

```sh
docker login docker.i-yongqi.xyz -u "$LOGIN_USER" -p "$LOGIN_PASS"
docker pull  docker.i-yongqi.xyz/docker.io/library/hello-world:latest
```

The password lands in `~/.docker/config.json` in clear text — that is the Docker
client's behaviour, not a property of this Worker. `docker logout
docker.i-yongqi.xyz` removes it and makes pulls fail again.

## Local development

```sh
cp .dev.vars.example .dev.vars   # local LOGIN_USER / LOGIN_PASS
npx wrangler dev --port 8787

curl -u "$LOGIN_USER:$LOGIN_PASS" http://127.0.0.1:8787/v2/
docker login 127.0.0.1:8787 -u "$LOGIN_USER" -p "$LOGIN_PASS"
docker pull  127.0.0.1:8787/docker.io/library/hello-world:latest
```

Offline unit tests (no network, no secrets):

```sh
node test/worker.test.mjs
```

## Limits

* Anonymous pulls only, unless `DOCKERHUB_USER` / `DOCKERHUB_TOKEN` are set:
  private registries that need their own credentials are out of scope, and
  Docker Hub's anonymous per-IP limit applies to `docker.io/...` references
  (see above for the two workarounds).
* Pull only: `docker push` is not proxied.
* The gate is a shared password, not per-user accounts; whoever holds it can use
  the Worker.
