#!/usr/bin/env bash
set -uo pipefail

mkdir -p logs
pids=()

# Map each service directory to the port it should run on. Keys must match the
# actual folder names; ports match each service's docker-compose port so the
# cross-service URLs below line up.
declare -A PORTS=(
  ["api-gateway"]=8081
  ["tenant-router"]=3004
  ["merchant-requests-service"]=4020
  ["alerts-service"]=5005
  ["analytics"]=3006
  ["sessions-service"]=4010
  ["daily-insights-service"]=4030
)

# health-monitor-service listens on HEALTH_MONITOR_PORT, not PORT.
export HEALTH_MONITOR_PORT="${HEALTH_MONITOR_PORT:-4015}"

# Cross-service URLs. In docker-compose the services find each other by compose
# hostname (tenant-router, health-monitor-service, ...). Running them directly on
# the host those names don't resolve, which shows up as "TypeError: fetch failed"
# (e.g. Google login -> fetchAllBrandIds -> tenant-router). Point them at
# localhost + the mapped port. Exported so every child process inherits them;
# dotenv won't override an already-set var, so these win over each service's .env.
export TENANT_ROUTER_URL="${TENANT_ROUTER_URL:-http://localhost:${PORTS[tenant-router]}}"
export HEALTH_MONITOR_REGISTER_URL="${HEALTH_MONITOR_REGISTER_URL:-http://localhost:${HEALTH_MONITOR_PORT}/register}"
export HEALTH_MONITOR_EVENTS_URL="${HEALTH_MONITOR_EVENTS_URL:-http://localhost:${HEALTH_MONITOR_PORT}/events}"

for dir in */; do
  dir="${dir%/}"
  pkg="$dir/package.json"

  if [ -f "$pkg" ]; then
    if command -v jq >/dev/null 2>&1; then
      has_dev=$(jq -r '.scripts.dev // empty' "$pkg")
      has_start=$(jq -r '.scripts.start // empty' "$pkg")
    else
      has_dev=$(grep -o '"dev"[[:space:]]*:' "$pkg" || true)
      has_start=$(grep -o '"start"[[:space:]]*:' "$pkg" || true)
    fi

    if [ -n "$has_dev" ]; then
      script="dev"
    elif [ -n "$has_start" ]; then
      script="start"
    else
      echo "==> Skipping $dir (no dev or start script)"
      continue
    fi

    port="${PORTS[$dir]:-}"
    if [ -z "$port" ]; then
      echo "==> WARNING: no port mapped for $dir — running with its default"
    else
      echo "==> Running 'npm run $script' in $dir on PORT=$port (log: logs/$dir.log)"
    fi

    ( cd "$dir" && ${port:+PORT="$port"} npm run "$script" ) > "logs/$dir.log" 2>&1 &
    pids+=($!)
  fi
done

echo "Started ${#pids[@]} process(es). PIDs: ${pids[*]}"
echo "Tail any service with: tail -f logs/<dir>.log"
echo "Stop all with: kill ${pids[*]}"

wait