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

## Docker Hub rate limits

Cloudflare's egress IPs are shared and sit over Docker Hub's *anonymous* per-IP
limit, so `docker.io` pulls regularly answer `429` while `ghcr.io`,
`registry.k8s.io` and the rest are unaffected. Two ways out:

* **Configure an account (recommended — keeps `docker.io` in the reference).**
  Add `DOCKERHUB_USER` and `DOCKERHUB_TOKEN` (a free Docker Hub account and a
  read-only personal access token) as Worker secrets. Requests to Docker Hub are
  then authenticated up front and counted against that account instead of the
  shared IP — which is also why the gate password exists. Without them the
  Worker stays anonymous, exactly as before.
* **Pull through a mirror.** `docker.i-yongqi.xyz/mirror.gcr.io/library/nginx`
  needs no credentials. The reference just names a different host.

Rate limit headers from the upstream (`ratelimit-remaining`,
`docker-ratelimit-source`) are passed through, so the cause of a 429 is visible
with `curl -D -`.

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

* Anonymous pulls only: private registries that need credentials are out of
  scope, and anonymous rate limits (Docker Hub counts them per egress IP, and
  Cloudflare's is shared) are accepted as they are.
* Pull only: `docker push` is not proxied.
* The gate is a shared password, not per-user accounts; whoever holds it can use
  the Worker.
