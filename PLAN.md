# Plan and acceptance

Frozen requirements (2026-10-08) and how each one is met.

| Requirement | Where |
|---|---|
| Per-request upstream from the path, full references only, no shorthand | `src/index.js` fetch handler: first segment after `/v2/` is the host |
| No allow-list, any public registry | `HOST_RE` + pass-through; only `docker.io` is aliased |
| Not the `registry-mirrors` mode, no `daemon.json` change | explicit `docker.<domain>/<host>/<repo>` references |
| Pull only | `GET`/`HEAD` proxied, everything else 405 |
| Password gate, credentials live only in Cloudflare | `LOGIN_USER` / `LOGIN_PASS` secrets, constant-time compare |
| No upstream credentials stored, anonymous pulls | `bearerToken()` from the upstream challenge, in-memory cache |
| Client talks only to Cloudflare (blobs included) | `redirect: "follow"` inside the Worker |

Acceptance (verified locally against `wrangler dev` before deploying):

1. `docker login 127.0.0.1:8787` succeeds; anonymous and wrong-password requests
   get 401. ✔
2. `docker pull …/docker.io/library/hello-world:latest`, `…/alpine:3.20`,
   `…/nginx:1.27-alpine`, `…/ghcr.io/…/alpine:latest`, `…/registry.k8s.io/pause:3.9`
   all succeed with Docker verifying the digests. ✔
3. `docker logout` then pull → refused. ✔
4. `node test/worker.test.mjs` green. ✔

After deploy the same acceptance runs against `docker.i-yongqi.xyz`.

Post-deploy finding (2026-10-09): `ghcr.io` and `registry.k8s.io` pull fine
through the deployed Worker, but `docker.io` answers 429 — Docker Hub's
anonymous limit is per egress IP and Cloudflare's shared IPs sit over it. Added
optional `DOCKERHUB_USER` / `DOCKERHUB_TOKEN` secrets (authenticated pulls,
counted per account) and documented `mirror.gcr.io` as the credential-free
alternative. The gate means only this user spends that account's quota.
