# Running versions side by side on Docker Swarm

`docker-compose.yml` still runs one copy of the app. The files here run any
number of versions at once on Swarm, with one of them marked **latest**, the
version you get when you don't ask for a specific one.

```
                         :8081
                    ┌──────────────┐
  client ──────────▶│ Traefik edge │  (stack dash-infra)
                    └──────┬───────┘
       Host v2.* or        │        anything else
   X-App-Version: v2       │        → "latest" pointer
            ┌──────────────┴──────────────┐
            ▼                             ▼
   ┌─ dash-v2 (net dash-v2-app) ┐  ┌─ dash-v1 (net dash-v1-app) ┐
   │ api-gateway → auth-service │  │ api-gateway → auth-service │
   │   tenant-router, alerts …  │  │   tenant-router, alerts …  │
   └────────────┬───────────────┘  └────────────┬───────────────┘
                └──── alerts-service ──▶ kafka-service (dash-infra, shared)
```

Each version is a separate stack with its own private overlay network. The
service names that are hardcoded across the code (`auth-service`,
`tenant-router:3004`, `health-monitor-service:4015`, the hosts in nginx.conf and
the Lua code) therefore resolve to that version's containers only. No app
changes were needed for this.

## Usage

```sh
scripts/swarm.sh release v3          # build → deploy → wait healthy → promote → remove previous
```

`release` moves latest only if every image builds **and** every service passes
its healthcheck within `WAIT_TIMEOUT` (default 300s). Otherwise it exits
non-zero, the previous latest keeps serving, and nothing is removed. Each
release needs a new version name: rebuilding an existing tag would not roll
anything out.

Once the edge is serving the new version, `release` waits `DRAIN_SECONDS`
(default 30) for open sockets and in-flight requests, then removes the
previous latest. Other running versions are left alone. Set
`KEEP_PREVIOUS=true` to keep the previous latest. Images stay on disk, so
rolling back to a removed version takes seconds:
`scripts/swarm.sh deploy v2 && scripts/swarm.sh promote v2`.

The same steps one at a time:

```sh
scripts/swarm.sh build v3            # images from the working tree (or: build v3 <git-ref>)
scripts/swarm.sh deploy v3           # runs next to the others; latest is unchanged
curl -H 'X-App-Version: v3' localhost:8081/health    # try it explicitly
curl http://v3.localhost:8081/health                 # same, by host
scripts/swarm.sh promote v3          # v3 becomes the default; no restarts
scripts/swarm.sh promote v2          # rollback is the same command
scripts/swarm.sh rm v1               # retire an old version (latest can't be removed)
scripts/swarm.sh ls
```

Every response carries an `X-App-Version` header naming the version that
served it. When a request matches more than one rule, the header beats the host,
and the host beats latest. An unknown version falls through to latest.

`promote` rewrites a label on the Traefik service. Traefik picks up the change
within about 5 seconds and nothing restarts. The `infra` command reads the
current latest back from that label, so redeploying infra keeps it.

## Things to know

- **Env files.** Stacks use the same `.env` files as compose. `swarm.sh` renders
  them with `docker compose config` before `docker stack deploy`, because
  `stack deploy` alone keeps the quotes around values (`AUTH_KEYS='[...]'`
  breaks). Always deploy through the script.
- **Shared external state.** Every version uses the same Mongo, RDS and Redis
  from `.env`, so schema and data changes must stay compatible with the older
  versions that are still running.
- **Background jobs run once per version.** These include the Todoist reconcile
  in merchant-requests, the inventory cache refresh in alerts, and analytics'
  hourly job (if enabled). Two live versions run each job twice.
- **Health monitor.** Each version gets its own copy (it is on by default and
  controlled by `HEALTH_MONITOR` in `.env`), so incident emails can arrive once
  per version. Set `HEALTH_MONITOR=false` in the environment when you
  experiment locally.
- **Kafka** is shared. All versions publish to the same topics.
- **Not carried over from compose:** `shared-net` and the direct `:3006`
  (analytics) and `:4015` (health monitor) host ports. Reach those services
  through the gateway, or add them back if something outside depends on them.
- **Multi-node.** Images are local (`IMAGE_PREFIX=dashboard`). For more than one
  node, push to a registry and set `IMAGE_PREFIX=<registry>/dashboard`. Kafka,
  Traefik and the health monitor are pinned to manager nodes.
- **Frontend.** For the hosted frontend to reach a specific version, either
  point it at a `v2.<domain>` host (needs wildcard DNS) or have its `/api`
  proxy send `X-App-Version`.
