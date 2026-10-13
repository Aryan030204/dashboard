#!/usr/bin/env bash
# Run several versions of the dashboard side by side on Docker Swarm.
#
#   scripts/swarm.sh build   <version> [git-ref]  build images (from the working tree, or from git-ref)
#   scripts/swarm.sh deploy  <version>            deploy/update stack dash-<version> (infra too, if missing)
#   scripts/swarm.sh promote <version>            make <version> the default ("latest") — no restarts
#   scripts/swarm.sh release <version> [git-ref]  build + deploy + promote, then remove the previous latest;
#                                                 nothing changes unless every step succeeds
#   scripts/swarm.sh rm      <version>            remove a version (refuses to remove latest)
#   scripts/swarm.sh ls                           list deployed versions
#   scripts/swarm.sh infra                        (re)deploy the shared infra stack, keeping latest
#
# Reaching a version through the edge (default port 8081):
#   http://localhost:8081/...                         -> latest
#   http://v2.localhost:8081/...                      -> v2
#   curl -H 'X-App-Version: v2' localhost:8081/...    -> v2
#
# Env: IMAGE_PREFIX (default "dashboard"; set to a registry path for multi-node),
#      EDGE_PORT (default 8081), HEALTH_MONITOR (else read from .env, default on),
#      WAIT_TIMEOUT (health wait, default 300s), DRAIN_SECONDS (release: grace period
#      before the previous version is removed, default 30), KEEP_PREVIOUS=true (release: keep it).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWARM_DIR="$ROOT_DIR/swarm"
INFRA_STACK="dash-infra"
EDGE_SERVICE="${INFRA_STACK}_edge"
export IMAGE_PREFIX="${IMAGE_PREFIX:-dashboard}"
export EDGE_PORT="${EDGE_PORT:-8081}"

# service name -> "<context dir>:<dockerfile>"
SERVICES=(
  "api-gateway:api-gateway:Dockerfile"
  "auth-service:api-gateway:Dockerfile.auth"
  "tenant-router:tenant-router:Dockerfile"
  "alerts-service:alerts-service:Dockerfile"
  "merchant-requests-service:merchant-requests-service:Dockerfile"
  "daily-insights-service:daily-insights-service:Dockerfile"
  "analytics-service:analytics:Dockerfile"
  "sessions-service:sessions-service:Dockerfile"
  "health-monitor-service:health-monitor-service:Dockerfile"
)

log() { printf '[swarm] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

check_version() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] ||
    die "version must match [a-z0-9-] (e.g. v1, v2, rc-3); got '${1:-}'"
}

health_monitor_enabled() {
  local value="${HEALTH_MONITOR:-}"
  if [[ -z "$value" && -f "$ROOT_DIR/.env" ]]; then
    value="$(sed -n 's/^HEALTH_MONITOR=//p' "$ROOT_DIR/.env" | tail -1 | tr -d "\"'" | tr '[:upper:]' '[:lower:]')"
  fi
  case "$value" in 0|false|no|off) return 1 ;; *) return 0 ;; esac
}

# `docker stack deploy` parses env_file differently from compose: it keeps the
# surrounding quotes (AUTH_KEYS='[...]' arrives as literal '[...]'). Render the
# stack with compose's own parser first so .env files mean exactly what they
# mean under docker compose, then hand the result to swarm over stdin.
stack_deploy() {
  local stack="$1"; shift
  local files=() opts=()
  while (( $# )); do
    case "$1" in
      -c) files+=(-f "$2"); shift 2 ;;
      *) opts+=("$1"); shift ;;
    esac
  done
  # compose emits `name:` (unknown to swarm) and quotes published ports.
  docker compose -p "$stack" "${files[@]}" config 2> >(grep -vE 'only (appl|honored)' >&2) |
    sed -e '/^name:/d' -e 's/^\( *published: \)"\([0-9]*\)"$/\1\2/' |
    docker stack deploy --detach=true --prune "${opts[@]}" -c - "$stack" >/dev/null
}

stack_exists() { docker stack ls --format '{{.Name}}' | grep -qx "$1"; }

current_latest() {
  docker service inspect "$EDGE_SERVICE" \
    --format '{{index .Spec.Labels "traefik.http.routers.latest.service"}}' 2>/dev/null |
    sed -n 's/^gw-\(.*\)@swarm$/\1/p'
}

wait_for_stack() {
  local stack="$1" deadline=$((SECONDS + ${WAIT_TIMEOUT:-300}))
  log "waiting for $stack to converge (timeout ${WAIT_TIMEOUT:-300}s)..."
  while true; do
    # One-shot jobs (kafka-init) finish with 0 running replicas; skip them.
    local pending
    pending="$(docker service ls --filter "label=com.docker.stack.namespace=$stack" \
      --format '{{.Name}} {{.Replicas}}' | grep -v '_kafka-init ' | awk '{split($2,r,"/"); if (r[1] != r[2]) print $1" "$2}')"
    [[ -z "$pending" ]] && { log "$stack is up"; return 0; }
    if (( SECONDS > deadline )); then
      log "$stack did not converge; still pending:"; sed 's/^/  /' <<<"$pending" >&2
      return 1
    fi
    sleep 5
  done
}

cmd_build() {
  local version="$1" ref="${2:-}" src="$ROOT_DIR"
  check_version "$version"
  if [[ -n "$ref" ]]; then
    BUILD_TMP="$(mktemp -d)"
    trap 'rm -rf "$BUILD_TMP"' EXIT
    log "exporting $ref to $BUILD_TMP"
    git -C "$ROOT_DIR" archive "$ref" | tar -x -C "$BUILD_TMP"
    src="$BUILD_TMP"
  fi
  local entry name ctx file
  for entry in "${SERVICES[@]}"; do
    IFS=: read -r name ctx file <<<"$entry"
    log "building $IMAGE_PREFIX/$name:$version"
    docker build -q -t "$IMAGE_PREFIX/$name:$version" \
      --label "org.opencontainers.image.revision=$(git -C "$ROOT_DIR" rev-parse "${ref:-HEAD}")" \
      -f "$src/$ctx/$file" "$src/$ctx" >/dev/null
  done
  log "built $version"
}

deploy_infra() {
  local latest="$1"
  export LATEST_VERSION="$latest"
  # The kafka-service/.env knobs (heap, memory, image tag) feed the infra stack.
  # Parsed as dotenv, not sourced: values like `-Xms512m -Xmx512m` are unquoted.
  if [[ -f "$ROOT_DIR/kafka-service/.env" ]]; then
    local key value
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
      value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
      export "$key=$value"
    done < "$ROOT_DIR/kafka-service/.env"
  fi
  export KAFKA_TOPICS_HASH="$(sha256sum "$ROOT_DIR/kafka-service/topics.conf" | cut -c1-12)"
  export KAFKA_INIT_HASH="$(sha256sum "$ROOT_DIR/kafka-service/init-topics.sh" | cut -c1-12)"
  log "deploying $INFRA_STACK (latest=$latest)"
  stack_deploy "$INFRA_STACK" -c "$SWARM_DIR/infra.yml"
  wait_for_stack "$INFRA_STACK"
}

cmd_deploy() {
  local version="$1"
  check_version "$version"
  docker image inspect "$IMAGE_PREFIX/api-gateway:$version" >/dev/null 2>&1 ||
    [[ "$IMAGE_PREFIX" == */* ]] || die "no images for $version; run: $0 build $version"

  if ! stack_exists "$INFRA_STACK"; then
    # First version ever deployed becomes latest. Traefik tolerates the
    # reference to gw-<version> until the app stack below registers it.
    deploy_infra "$version"
  fi

  local files=(-c "$SWARM_DIR/app.yml")
  health_monitor_enabled && files+=(-c "$SWARM_DIR/health-monitor.yml")
  export VERSION="$version"
  local resolve=()
  [[ "$IMAGE_PREFIX" == */* ]] || resolve=(--resolve-image never)
  log "deploying dash-$version"
  stack_deploy "dash-$version" "${resolve[@]}" "${files[@]}"
  wait_for_stack "dash-$version"
  log "dash-$version reachable at http://$version.localhost:$EDGE_PORT (latest is $(current_latest))"
}

cmd_promote() {
  local version="$1"
  check_version "$version"
  stack_exists "dash-$version" || die "dash-$version is not deployed"
  wait_for_stack "dash-$version"
  local previous; previous="$(current_latest)"
  # Service labels (not container labels) change without restarting the task.
  docker service update --detach=true --quiet \
    --label-add "traefik.http.routers.latest.service=gw-$version@swarm" \
    --label-add "traefik.http.routers.latest.middlewares=ver-$version@swarm" \
    "$EDGE_SERVICE" >/dev/null
  log "latest: ${previous:-none} -> $version (Traefik picks it up within ~5s)"
}

cmd_release() {
  local version="$1" ref="${2:-}"
  check_version "$version"
  # Rebuilding an existing tag would not roll anything out (the service spec
  # stays identical), so every release needs a fresh version name.
  ! stack_exists "dash-$version" || die "dash-$version already exists; release under a new version name"
  local previous; previous="$(current_latest)"
  # Each step runs as its own process: inside `if`/`||` bash ignores set -e,
  # which would let a half-failed deploy fall through to promote.
  "$0" build "$version" ${ref:+"$ref"}
  if ! "$0" deploy "$version"; then
    log "dash-$version is unhealthy; latest stays ${previous:-unset}."
    log "inspect: docker stack ps dash-$version --no-trunc   remove: $0 rm $version"
    exit 1
  fi
  "$0" promote "$version"

  [[ -n "$previous" && "$previous" != "$version" ]] || return 0
  if [[ "${KEEP_PREVIOUS:-false}" == "true" ]]; then
    log "keeping dash-$previous (KEEP_PREVIOUS=true)"
    return 0
  fi
  # Only retire the old version once the edge is really serving the new one,
  # then give in-flight requests and open sockets time to finish.
  local deadline=$((SECONDS + 60))
  until [[ "$(curl -s -o /dev/null -D - "http://127.0.0.1:$EDGE_PORT/health" |
              tr -d '\r' | sed -n 's/^[Xx]-[Aa]pp-[Vv]ersion: //p')" == "$version" ]]; do
    if (( SECONDS > deadline )); then
      log "edge is not serving $version yet; leaving dash-$previous running. Remove it with: $0 rm $previous"
      return 1
    fi
    sleep 2
  done
  log "edge serves $version; removing dash-$previous in ${DRAIN_SECONDS:-30}s"
  sleep "${DRAIN_SECONDS:-30}"
  "$0" rm "$previous" >/dev/null
  log "removed dash-$previous (images kept; roll back with: $0 deploy $previous && $0 promote $previous)"
}

cmd_rm() {
  local version="$1"
  check_version "$version"
  [[ "$(current_latest)" != "$version" ]] || die "$version is latest; promote another version first"
  docker stack rm "dash-$version"
}

cmd_ls() {
  local latest; latest="$(current_latest)"
  docker stack ls --format '{{.Name}} {{.Services}}' | while read -r name count; do
    [[ "$name" == dash-* && "$name" != "$INFRA_STACK" ]] || continue
    local v="${name#dash-}"
    printf '%-12s %2s services%s\n' "$v" "$count" "$([[ "$v" == "$latest" ]] && echo '  <- latest')"
  done
}

cmd_infra() {
  local latest; latest="$(current_latest)"
  [[ -n "$latest" ]] || die "no latest version known; deploy a version first"
  deploy_infra "$latest"
}

case "${1:-}" in
  build)   shift; cmd_build "$@" ;;
  deploy)  shift; cmd_deploy "$@" ;;
  promote) shift; cmd_promote "$@" ;;
  release) shift; cmd_release "$@" ;;
  rm)      shift; cmd_rm "$@" ;;
  ls)      cmd_ls ;;
  infra)   cmd_infra ;;
  *) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 1 ;;
esac
