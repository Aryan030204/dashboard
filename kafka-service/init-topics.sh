#!/bin/sh
# Creates the topics listed in topics.conf. Idempotent: existing topics are left
# untouched (--if-not-exists), so it is safe to run on every `up`.
set -eu

BOOTSTRAP="${KAFKA_BOOTSTRAP_SERVERS:-kafka-service:9092}"
REPLICATION="${KAFKA_REPLICATION_FACTOR:-1}"
CONF="${TOPICS_CONF:-/config/topics.conf}"
KAFKA_BIN="${KAFKA_BIN:-/opt/kafka/bin}"

echo "[kafka-init] bootstrap=${BOOTSTRAP} replication=${REPLICATION} conf=${CONF}"

# The compose healthcheck already gates this container; this guards direct runs.
tries=0
until "${KAFKA_BIN}/kafka-broker-api-versions.sh" --bootstrap-server "${BOOTSTRAP}" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "${tries}" -ge 30 ]; then
    echo "[kafka-init] broker not reachable at ${BOOTSTRAP}" >&2
    exit 1
  fi
  sleep 2
done

while read -r topic partitions retention_ms retention_bytes _; do
  case "${topic}" in
    ''|'#'*) continue ;;
  esac
  if [ -z "${partitions:-}" ] || [ -z "${retention_ms:-}" ] || [ -z "${retention_bytes:-}" ]; then
    echo "[kafka-init] invalid line for topic '${topic}' in ${CONF}" >&2
    exit 1
  fi
  "${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "${BOOTSTRAP}" --create --if-not-exists \
    --topic "${topic}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention_ms}" \
    --config "retention.bytes=${retention_bytes}"
done < "${CONF}"

echo "[kafka-init] topics now present:"
"${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "${BOOTSTRAP}" --list
