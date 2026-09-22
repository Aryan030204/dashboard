# Datum — Deployment / Server Migration Guide

This is a field guide for standing Datum up on a new server (or diagnosing why
an existing one is misbehaving). It intentionally spends most of its length on
**quirks and failure modes that are not discoverable from the error message
alone** — cases where the symptom points nowhere near the actual cause.

Nothing in this document changes behavior. Every root cause below is described
as-is, with file:line references, so a fix can be applied deliberately later
instead of guessed at under pressure.

## 1. Topology recap

- **Frontend** (`client/dashboard`) — React + Vite SPA, deployed to Vercel.
  Production is `datum.trytechit.co`; there's also a raw
  `dashboard-topaz-psi.vercel.app` deployment URL that shows up in CORS allow
  lists (see §3.5).
- **Backend** — a Docker Compose stack on a single EC2 host, fronted by
  `api-gateway` (OpenResty/nginx + Lua, listens on container port `18080`).
  `api-gateway` reverse-proxies to `auth-service`, `analytics-service`,
  `alerts-service`, `merchant-requests-service`, `daily-insights-service`,
  `tenant-router`, `sessions-service`, and (separately) `health-monitor-service`.
- **Two environments on one host**: `main` branch → production stack
  (`/home/ubuntu/dashboard-main/dashboard`, compose project `dashboard-prod`),
  `staging` branch → staging stack (`/home/ubuntu/datum-deploy/dashboard`,
  compose project `dashboard-staging`). Both are deployed by GitHub Actions
  over SSH (`.github/workflows/deploy-ec2-main.yml` /
  `deploy-ec2-staging.yml`).
- Base deploy steps for a brand new box are in `DEPLOY_EC2.md` — this doc
  assumes that's already been done and focuses on what goes wrong next.

---

## 2. Frontend / Vercel quirks

### 2.1 `VITE_API_BASE` must be empty — filling it in breaks auth

**Symptom:** login appears to work (you get redirected in), but the session
randomly dies, or every request behaves as if logged out shortly after
login — no explicit error, just silent auth failure.

**Root cause:**

`client/dashboard/src/lib/api.js:3-7`:

```js
function resolveApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE || "").trim();
  if (!envBase) return "/api";
  return envBase;
}
```

When `VITE_API_BASE` is **empty**, every API call is a *relative* path
(`/api/...`) on the same origin as the frontend. Vercel routes that through
`client/dashboard/api/proxy.js` (see `vercel.json:10-13`), a serverless
function that:
- reads the real backend URL from **`API_BASE_URL`** (a server-side env var,
  never exposed to the browser),
- forwards the request there,
- and — critically — **rewrites `Set-Cookie` to strip the upstream `Domain`**
  (`api/proxy.js:330-333` / `:397`) so the `refresh_token` cookie sticks to
  the Vercel host instead of the backend's own domain.

This makes the whole thing same-origin from the browser's point of view: no
CORS, and the refresh cookie is a normal first-party cookie.

If `VITE_API_BASE` is filled in with the backend's real URL (e.g.
`https://api.trytechit.co` or the EC2 IP), the browser talks to the backend
**directly, cross-origin**, bypassing the proxy entirely. Two things then
have to be independently correct, and by default they aren't:

1. **CORS.** `api-gateway/src/app.js:19-46` only adds
   `Access-Control-Allow-Origin` etc. if `CORS_ORIGINS` is non-empty *and*
   lists the calling origin. `api-gateway/.env.example` doesn't even mention
   `CORS_ORIGINS` — it's easy to deploy without it set, in which case the
   whole CORS block is skipped and the browser blocks the response outright.
2. **Cookie `SameSite`.** The refresh cookie's `SameSite` comes from
   `COOKIE_SAMESITE` (`api-gateway/src/controllers/auth.controller.js:15-20`),
   which **defaults to `lax`**. A `lax` cookie is never sent on cross-site
   `fetch`/XHR (only top-level navigations), so even with CORS fixed, the
   `/auth/refresh` call from `client/dashboard/src/lib/api.js:104` silently
   never receives the refresh cookie. `refreshAccessToken()` treats this as a
   transient failure and retries with backoff (not an immediate logout — see
   the comment at `api.js:97-100`), which is *why the failure looks random*
   instead of immediate: the access token keeps working until it expires,
   then refresh quietly can't succeed, and the user falls off session.

**Fix (for later, not applied here):** leave `VITE_API_BASE` unset/empty in
every Vercel environment. If a future requirement forces direct cross-origin
calls, `CORS_ORIGINS` and `COOKIE_SAMESITE=none` (with `secure` cookies) need
to be set together — one without the other still breaks silently.

### 2.2 Vercel "entry point" / 404 not found

**Symptom:** a fresh Vercel import builds "successfully" but every route
(including `/`) returns 404, or the build can't find a framework at all.

**Root cause:** the frontend is not at the repo root — it's nested at
`client/dashboard`. Confirmed:

```
$ ls package*.json
package-lock.json   # 88 bytes, no package.json at all
```

There is **no root `package.json`**, so Vercel's zero-config framework
detection (which scans the repo root on import) finds nothing to build and
either fails or serves an empty/blank deployment. Vercel's **Root Directory**
project setting has to be pointed at `client/dashboard` manually — it is not
inferred.

This matters beyond the initial build, too: `client/dashboard/vercel.json`
holds the SPA rewrites that make deep-linked/refreshed routes work (e.g.
`/dashboard`, `/alerts`, `/session-analytics` all rewrite to `/`, see
`vercel.json:14-28`). **`vercel.json` is only read from whatever directory
Root Directory points to.** If Root Directory is left at the repo root, that
file is never picked up even if the build itself is coerced into working some
other way — so any client-side route other than `/` 404s on direct load or
refresh, which is the exact symptom reported.

**Fix (for later):** Project Settings → Build & Development Settings → Root
Directory = `client/dashboard`. Re-verify after any Vercel project
recreation/reimport, since this setting doesn't come from the repo.

---

## 3. EC2 / Docker Compose quirks

### 3.1 `main` vs `staging` — how the two stacks actually separate

Both branches deploy to the **same host**. What keeps them from colliding is
entirely in `docker-compose.staging.override.yml`, layered on top of the base
`docker-compose.yml` by `scripts/compose-stack.js` when
`COMPOSE_ENV_SUFFIX=staging` is set (`deploy-staging.sh:14`):

| | production (`main`) | staging |
|---|---|---|
| Checkout path | `/home/ubuntu/dashboard-main/dashboard` | `/home/ubuntu/datum-deploy/dashboard` |
| Compose project name | `dashboard-prod` | `dashboard-staging` |
| Container names | `*-main` (e.g. `api-gateway-main`) | `*-staging` |
| Docker network | `saas-net-main` | `saas-net-staging` |
| `api-gateway` host port | `8081` → container `18080` | `8091` → container `18080` |
| `analytics-service` host port | `3006` | `3016` |

None of this is "prod-something" naming inside `docker-compose.yml` — the
literal suffixes are `-main` and `-staging` (see `container_name:` fields in
`docker-compose.yml` vs the overrides in
`docker-compose.staging.override.yml`). If you're grepping for containers on
the host, look for those suffixes, not "prod".

**The part that isn't in this repo at all:** whatever reverse proxy on the
EC2 host routes public traffic (`datum.trytechit.co`, and whatever staging
uses — `client/dashboard/.env.local` has a commented reference to
`https://api.trytechit.co/staging`) to `localhost:8081` vs `localhost:8091`
is **host-level nginx that lives outside this git repo** (not
`api-gateway/gateway/nginx.conf`, which only runs *inside* the api-gateway
container and knows nothing about ports 8081/8091 — it always listens on
`18080`). That host nginx config has to be:
- kept in sync by hand whenever these ports change in the compose files,
- and correctly mapped per-domain/per-path, or staging traffic silently lands
  on the prod containers (or vice versa) with no error from Compose or the
  app — everything looks healthy on both sides individually.

Because it's not version-controlled, there's no diff to review when it
drifts. **Action item, not a fix:** find and either commit a copy of that
host nginx config into this repo (e.g. under `docs/` or an `infra/` folder)
or at minimum document its exact `proxy_pass` targets next to this section,
so a server rebuild doesn't have to reverse-engineer it from a running box.

### 3.2 Staging auto-deploy may currently be a no-op — verify before relying on it

While tracing the staging deploy path: `deploy-ec2-staging.yml` SSHes in and
runs `.github/workflows/deploy-main-staging.sh`. That file currently reads:

```bash
# exec bash /home/ubuntu/datum-deploy/dashboard/.github/workflows/deploy-staging.sh
```

The actual invocation of `deploy-staging.sh` (the script that does
`down` / `build --no-cache` / `up -d`) is **commented out**. As written, a
push to `staging` only does the `git fetch && git reset --hard origin/staging`
in the workflow YAML itself — the containers are never rebuilt or restarted.
This may be intentional (e.g. temporarily disabled during other work) or may
be a leftover from a refactor — the surrounding comment
(`deploy-main-staging.sh:1-11`) only explains why the file exists, not why
the line is commented. **Worth confirming on the actual host before assuming
`git push origin staging` deploys anything.**

### 3.3 `GATEWAY_SHARED_SECRET` — set it in root `.env`, not just `api-gateway/.env`

**Symptom:** `/auth/login`, `/auth/refresh`, `/auth/me` all work fine. Every
*other* authenticated route — `/analytics/...`, `/pnl/...`,
`/daily-insights`, `/merchant-requests`, `/health-monitor` — returns `401
Unauthorized` even though the JWT is valid and the user is clearly logged in.

This is the single most misleading failure mode in the stack, because `/me`
working makes it look like auth is fine.

**Root cause, in full:**

1. `api-gateway/gateway/lua/auth.lua:308-322` — after verifying the JWT,
   the gateway signs a small HMAC over the resolved identity
   (`user|brand|role|ts`) using `GATEWAY_SHARED_SECRET`, and attaches it as
   `x-gw-ts` / `x-gw-sig` headers **only if the secret is non-empty**:
   ```lua
   local gw_secret = os.getenv("GATEWAY_SHARED_SECRET")
   if gw_secret and gw_secret ~= "" then
       -- ...sets x-gw-ts / x-gw-sig...
   end
   ```
   If `gw_secret` is empty, this block is silently skipped — no error, no
   log, the request just proceeds without those headers.

2. Downstream services (`analytics/shared/middleware/identityEdge.js:12-13`,
   `daily-insights-service/src/middleware/auth.js`,
   `merchant-requests-service/src/middleware/auth.js`,
   `health-monitor-service/src/middleware/gatewayAuth.js`) each independently
   check `GATEWAY_SHARED_SECRET` from *their own* environment. If **they**
   have a real secret configured, `verifyGatewaySignature()` requires
   `x-gw-ts`/`x-gw-sig` to be present and correct
   (`identityEdge.js:12-32`) — missing headers → `401`.

3. `/auth/*` is exempt from all of this. In
   `api-gateway/gateway/nginx.conf:93-103`, `location /auth/` only runs
   `ratelimit.enforce()` — it never calls `auth.authenticate()`, so no
   gateway signature is generated or required for it. `/auth/me`'s handler
   (`api-gateway/src/controllers/auth.controller.js:189-216`) verifies the
   bearer access token **directly** via `TokenService.verifyAccessToken` and
   never looks at `x-gw-sig`/`GATEWAY_SHARED_SECRET` at all. That's the whole
   reason `/me` (and login/refresh/logout) keep working no matter what state
   the gateway signature is in — they don't participate in that mechanism.

4. **Why it's specifically "root `.env` vs `api-gateway/.env`":**
   `docker-compose.yml`'s `api-gateway` service has *both*:
   ```yaml
   env_file:
     - .env
     - ./api-gateway/.env
   environment:
     GATEWAY_SHARED_SECRET: ${GATEWAY_SHARED_SECRET}
   ```
   An explicit `environment:` entry always wins over anything from
   `env_file:`. But `${GATEWAY_SHARED_SECRET}` here is **Compose's own
   variable-interpolation syntax**, which Compose resolves from the shell
   environment plus the root `.env` file *sitting next to the compose file*
   — it does **not** read `./api-gateway/.env` for this purpose. Those are
   two unrelated mechanisms that happen to both be called "env files":
   `env_file:` (loaded into the container) vs. the top-level `.env` used for
   `${...}` substitution in the YAML itself.

   So: if `GATEWAY_SHARED_SECRET` is only set in `api-gateway/.env` (which
   *feels* like the right place — it's the gateway's own secret), the
   `${GATEWAY_SHARED_SECRET}` substitution evaluates to an empty string, and
   the explicit `environment:` block stamps that empty value into the
   **api-gateway container specifically**, overwriting whatever `env_file:`
   would otherwise have provided. Every *other* service in
   `docker-compose.yml` (`auth-service`, `tenant-router`, `alerts-service`,
   `merchant-requests-service`, `daily-insights-service`,
   `analytics-service`, `sessions-service`) has no such `environment:`
   override — for them, setting the secret in either file (or both) works
   fine via normal `env_file:` precedence (later file wins on key
   conflicts).

   **This is not hypothetical for this checkout** — as of this writing, the
   local `api-gateway/.env` has `GATEWAY_SHARED_SECRET` set, but the local
   root `.env` does not. `analytics/.env`, `daily-insights-service/.env`,
   `merchant-requests-service/.env`, and `health-monitor-service/.env` all
   have the same real secret configured. Deployed as-is via
   `docker-compose.yml`, the api-gateway container's copy resolves to empty
   while every downstream service that checks it has a real value — i.e.
   the exact 401-everywhere-except-`/me`
   failure described above would reproduce today.

   Also note `api-gateway/.env.example` and the root `.env.example` **don't
   mention `GATEWAY_SHARED_SECRET` at all** — only
   `daily-insights-service/.env.example` and
   `analytics/.env.production.example` do. Someone provisioning a new server
   strictly from the `.env.example` templates has no signal this variable
   needs to exist, let alone that it needs to live in root `.env`
   specifically for `api-gateway` to see it.

**Fix (for later):** set `GATEWAY_SHARED_SECRET` in the root `.env` (the one
next to `docker-compose.yml`) — that's the only file Compose reads for
`${...}` substitution. Keep it mirrored into `api-gateway/.env` and every
downstream service's `.env` for consistency, since they all need the
identical value. Consider also just deleting the redundant `environment:`
override in `docker-compose.yml` for `api-gateway`, since `env_file:` order
already gives root `.env` priority-by-last-write-if-duplicated the same
outcome the override is trying to force — the override is what makes root
`.env` the *only* source instead of one of two, which is the trap.

### 3.4 `env` directives in `nginx.conf` — the same trap bites `PUSH_TOKEN` too, permanently

Related to §3.3 but a distinct, separate mechanism: **nginx clears almost the
entire process environment when it forks worker processes.** Only variables
explicitly declared with an `env` directive survive into a worker process
(and therefore into `os.getenv()` calls from Lua). `api-gateway/gateway/nginx.conf:1-4`
declares exactly four:

```
env GATEWAY_SHARED_SECRET;
env RATE_LIMIT_DISABLED;
env X_PIPELINE_KEY;
env PIPELINE_AUTH_HEADER;
```

`auth.lua:78` also reads `os.getenv("PUSH_TOKEN")` for the notification
push-bypass check (`x-push-token` header on `/push/receive`), with a
hardcoded fallback:

```lua
local secret_push_token = os.getenv("PUSH_TOKEN") or "push@notify321"
```

`PUSH_TOKEN` is **not** in the `env` directive list above. That means, no
matter what `PUSH_TOKEN` is set to in `api-gateway/.env` (it currently *is*
set there, and in `alerts-service/.env`), the nginx worker process will
**never see it** — `os.getenv("PUSH_TOKEN")` always returns `nil`, and the
gateway always falls back to the hardcoded `"push@notify321"` value. The
configured value is silently dead code; the real bypass token in production
is permanently the hardcoded default, regardless of what operators believe
they've set. This is worth flagging as a security-relevant finding on its
own, independent of the deploy-quirk documentation goal.

**General rule for this file:** any new env var read via `os.getenv()` in
`gateway/lua/*.lua` must be added to the `env <NAME>;` list at the top of
`nginx.conf`, or it will always read as `nil` in Lua no matter what the
container's actual environment contains — with no warning at startup.

### 3.5 `CORS_ORIGIN` vs `CORS_ORIGINS` — the env var name isn't consistent across services

Not one of the four originally flagged issues, but adjacent enough to §2.1 to
be worth catching here: the services disagree on the variable name for the
same concept.

| Service | Var name(s) it actually reads |
|---|---|
| `api-gateway` (`src/app.js:19`) | `CORS_ORIGINS` only |
| `analytics` (`app.js:43`, `utils/socket.js:7`) | `CORS_ORIGIN` only |
| `sessions-service` (`src/app.js:18`) | `CORS_ORIGIN` only — **defaults to `'*'` if unset** (fails open, opposite of everything else) |
| `merchant-requests-service` (`src/config.js:48`) | `CORS_ORIGINS` **or** `CORS_ORIGIN`, either works |
| `daily-insights-service` (`src/config.js:4`) | `CORS_ORIGINS` **or** `CORS_ORIGIN`, either works |
| `tenant-router` (`src/utils/socket.js:12`) | `CORS_ORIGINS` **or** `CORS_ORIGIN` |

Setting only `CORS_ORIGINS` (plural) in root `.env` — the natural thing to do
after reading `api-gateway`'s source — silently does nothing for `analytics`
or `sessions-service`, which only look at the singular form. `analytics`
fails closed (blocks the request) if its `CORS_ORIGIN` is unset;
`sessions-service` fails *open* (`'*'`) if its `CORS_ORIGIN` is unset, which
is easy to miss in review since it never errors. Locally, `analytics/.env`
does have the singular form set correctly — just be aware the two names
aren't interchangeable project-wide, only where a service explicitly falls
back to both.

---

## 4. `api-gateway/gateway/lua/` — pain points by file

### 4.1 `auth.lua`

- **Authorization header is stripped after processing**
  (`auth.lua:324`, `ngx.req.clear_header("Authorization")`). By design —
  downstream services are meant to trust `x-user-id`/`x-role`/etc. instead of
  re-verifying the JWT — but it means you cannot debug a downstream 401/403
  by checking whether the raw JWT arrived; it never does, on purpose. Debug
  via `x-user-id`/`x-brand-id`/`x-role`/`x-gw-sig` instead.
- **Bypass paths run *before* JWT verification**, in order: speed-key bypass
  for `/analytics/metrics/top-pdps` (`auth.lua:14-69`), push-token bypass for
  `/push/receive` (`:76-89`), then pipeline-key bypass for a fixed allowlist
  of tenant/onboarding/api-key routes (`:91-134`). If you're chasing "why did
  this request skip auth entirely," check these three blocks and their
  header names (`x-push-token`, `x-pipeline-key`) before assuming the JWT
  path is misbehaving.
- **Brand resolution precedence** (`:226-243`) is query `brand_key` → header
  `x-brand-id` → JWT's `primary_brand_id`. A stale `x-brand-id` header
  forwarded from a proxy/test tool ahead of the gateway can silently override
  the token's own brand and produce confusing 403s ("Access denied to this
  brand") that look like a permissions bug but are actually a brand-context
  bug.
- **Gateway-signature block silently no-ops on empty secret** — see §3.3.
  There is no log line when this happens; the request just proceeds without
  `x-gw-sig`.

### 4.2 `jwks.lua`

- **Hand-rolled JWK→PEM conversion** (`:20-80`) — a minimal ASN.1/DER
  encoder written by hand instead of using an OpenSSL binding. It only
  supports RSA `n`/`e` pairs; if `auth-service`'s JWKS endpoint ever emits a
  key shaped differently (different `kty`, missing `n`/`e`), this fails
  silently (`jwk_to_pem` returns `nil`) rather than raising — the symptom
  downstream is `"Unknown or Invalid Key ID"` from `auth.lua:186`, which
  looks like a `kid` mismatch even when the real problem is a malformed key.
- **`JWKS_URL` is hardcoded** to `http://auth-service:3001/auth/.well-known/jwks.json`
  (`jwks.lua:7`) — the Docker service name `auth-service` is baked in. If the
  service is ever renamed in `docker-compose.yml`, this breaks with no
  compile-time signal; the failure only shows up as a runtime DNS resolution
  error on first login after deploy.
- **`jwks_cache` is a 1MB shared dict** (`nginx.conf:19`,
  `lua_shared_dict jwks_cache 1m;`) versus `jwt_cache` at 10MB
  (`nginx.conf:20`). PEM strings are small so 1MB is normally plenty for a
  handful of signing keys, but it's worth knowing the two caches are sized
  very differently on purpose (one caches keys, the other caches full
  verified JWT payloads per-token) if either ever needs bumping.
- **Fetch-once-per-cache-miss locking** (`:92-109`, via `resty.lock`) means a
  cold cache (fresh deploy, or first request after a TTL expiry) causes every
  concurrent request for that `kid` to serialize behind one JWKS fetch. Not a
  bug, just worth knowing if you see a burst of slightly slower requests
  right after a restart.
- **The signing-key side of this** (`auth-service`) reads `AUTH_KEYS` as a
  **JSON array string** and `AUTH_ACTIVE_KID` for which entry is active
  (`api-gateway/src/services/token.service.js:17-61`), both required at
  startup or the service refuses to boot. `AUTH_KEYS` has to be valid JSON
  containing PEM private keys with literal `\n` escapes inside a
  single-line `.env` value — a very easy thing to corrupt by pasting from an
  editor that reflows or unescapes newlines. If `auth-service` won't start,
  check this before anything else; the error message
  (`Missing AUTH_ACTIVE_KID environment variable` /
  `AUTH_KEYS must be a non-empty JSON array` /
  `` Active key `${kid}` not found in AUTH_KEYS `` ) is direct, but easy to
  miss in container logs if you're looking at the gateway instead of
  `auth-service`'s own log.

### 4.3 `ratelimit.lua`

- **Fails open on internal errors** (`:24-30`): if `resty.limit.req`
  errors for any reason other than an actual rate-limit rejection, the
  request is allowed through (`return true`) rather than blocked. Intentional
  (availability over strictness), but means rate limiting can be silently
  broken (e.g. a full `rate_limit_store` shared dict) while every request
  still succeeds — there's no user-visible signal that limiting isn't
  actually happening, only the error log line.
- **`RATE_LIMIT_DISABLED=1` bypasses rate limiting entirely** (`:42-44`).
  It's in the `env` directive list (§3.4) so it does work when set, unlike
  `PUSH_TOKEN` — but it's easy to leave this set to `1` from local dev in a
  copied `.env` and not notice production has no rate limiting at all, since
  nothing fails when it's on.
- Limits are per-nginx-worker-process state via `lua_shared_dict
  rate_limit_store`, which is fine as-is because `worker_processes 1;`
  (`nginx.conf:5`) — shared dicts are actually shared across worker
  processes regardless, so this isn't a real gap, but if `worker_processes`
  is ever bumped for throughput, re-verify rate limiting still behaves as
  expected (it should, but it wasn't necessarily exercised under multi-worker
  conditions).

### 4.4 `resty/evp.lua` — the vendored copy silently shadows the one the Dockerfile downloads

This is the least obvious one in the whole gateway.

`api-gateway/Dockerfile:5-19` downloads four Lua libraries straight from
GitHub release tarballs at **build time** (`lua-resty-jwt`, `lua-resty-http`,
`lua-resty-string`, `lua-resty-hmac`) and installs them into
`/usr/local/openresty/lualib/resty/`. `lua-resty-string` includes its own
`evp.lua`.

But the repo **also** ships its own copy at
`api-gateway/gateway/lua/resty/evp.lua`, which gets `COPY`'d into the image
at `gateway/lua/` (`Dockerfile:22`).

`nginx.conf:13`'s Lua search path is:
```
lua_package_path "$prefix/gateway/lua/?.lua;$prefix/gateway/lua/resty/?.lua;$prefix/lualib/?.lua;...";
```
A `require("resty.evp")` call resolves module name `resty.evp` against each
pattern in order. The **first** pattern, `$prefix/gateway/lua/?.lua`,
matches `$prefix/gateway/lua/resty/evp.lua` — the repo's own committed
copy — before the search ever reaches `$prefix/lualib/?.lua`, where the
Dockerfile's freshly-downloaded `lua-resty-string` copy lives.

**Practical effect:** the repo-committed `evp.lua` always wins, silently.
Bumping the `lua-resty-string` version pinned in the Dockerfile (currently
`v0.16`) has **zero effect** on the actual `evp.lua` in use unless the
committed file at `gateway/lua/resty/evp.lua` is also updated (or removed) to
match. There's no error, no version check — the stale file just keeps being
the one that loads. Combined with `lua_code_cache on;` (`nginx.conf:15`),
any change here also needs a full container rebuild (not just a config
reload) to take effect at all.

### 4.5 The image build has a hard, unpinned runtime dependency on GitHub

All four Lua libraries in `Dockerfile:5-19` are fetched via `curl` from
`github.com` during `docker build`, pinned only to a git tag (not a commit
SHA or checksum). Two consequences worth knowing before a from-scratch server
build:

- If GitHub is unreachable, rate-limiting the build host, or the tag/asset
  layout ever changes upstream, `docker compose build` for `api-gateway`
  fails outright with no local fallback — there's no vendored copy of these
  four libraries anywhere in the repo (only the one `evp.lua` from §4.4 is
  committed, and that's incidental, not a deliberate vendoring strategy).
- Nothing verifies the downloaded tarball contents beyond "the URL responded
  200" — a tag being force-pushed upstream (rare, but possible for any
  GitHub project) would silently change what ships in the image on the next
  `--no-cache` build, with no diff visible in this repo.

---

## 5. Quick-reference checklist for a new server

Given everything above, before declaring a fresh EC2 box "deployed":

1. `git clone`, `cp .env.example .env`, fill in root `.env` — **including
   `GATEWAY_SHARED_SECRET`**, even though `.env.example` doesn't list it
   (§3.3).
2. Fill in each service's own `.env` from its `.env.example`, using the
   *same* `GATEWAY_SHARED_SECRET` value everywhere it's checked (`analytics`,
   `daily-insights-service`, `merchant-requests-service`,
   `health-monitor-service`, `api-gateway`).
3. If `PUSH_TOKEN` matters for your deployment, know it's currently inert at
   the gateway layer until `env PUSH_TOKEN;` is added to `nginx.conf` (§3.4).
4. Set `CORS_ORIGINS` **and** `CORS_ORIGIN` (both spellings) everywhere a
   frontend origin needs to be allowed, until/unless the naming is
   unified (§3.5).
5. `node scripts/compose-stack.js up -d --build` — expect a live network
   dependency on GitHub for the `api-gateway` image build (§4.5).
6. Set up host-level nginx (or equivalent) to route the public domain(s) to
   `127.0.0.1:8081` (prod) / `127.0.0.1:8091` (staging) — this step is not
   captured anywhere in this repo (§3.1); write down whatever you configure.
7. On Vercel: import with **Root Directory = `client/dashboard`** (§2.2), and
   leave `VITE_API_BASE` unset in every environment (§2.1). Set
   `API_BASE_URL` (server-side, no `VITE_` prefix) to the backend's public
   URL for `api/proxy.js` to use.
8. Confirm the staging GitHub Actions workflow actually rebuilds containers
   on push before relying on it (§3.2) — the entry-point script currently has
   that line commented out.
