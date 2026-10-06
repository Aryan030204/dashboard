# kafka-service

Single-broker Kafka for the intent-event pipeline. **Infrastructure only**: no producers, consumers or application logic live here.

## What runs
| Service | Purpose |
|---|---|
| `kafka-service` | Kafka broker (`apache/kafka:3.9.1`, KRaft mode, no ZooKeeper). Container `kafka-service-main`. |
| `kafka-init` | One-shot job. Creates topics from `topics.conf` once the broker is healthy, then exits 0. |

Both are defined in the root `docker-compose.yml` and listed in `scripts/compose-stack.js` (`BASE_SERVICES`), so the normal deploy starts them.

## Why this image and mode
Official Apache image, pinned to a minor release. KRaft mode removes the need for a separate ZooKeeper service; one node acts as broker and controller. Bump `KAFKA_IMAGE_TAG` to upgrade.

## Network and security
- Attached to `pipeline-net` only. Other containers use `kafka-service:9092`. No IPs, no `localhost`.
- `pipeline-net` is **external** (also used by `intent-pipeline`). Create it once per host if missing: `docker network create pipeline-net`. Without it, `up` fails.
- No host ports are published. Listener is PLAINTEXT without authentication or TLS. Security assumption: Kafka is trusted because it is reachable only from containers on the internal Docker network of the host. Do not publish port 9092.
- A service that should use Kafka must join `pipeline-net` (alerts-service is currently on `saas-net` only).

## Storage
Named volume `kafka-data-main` mounted at `/var/lib/kafka/data`. Survives restart, recreate and `compose down` (without `-v`). **Do not run `down -v` in production**: it deletes the data.

## Topics (`topics.conf`)
| Topic | Partitions | Replication | Retention |
|---|---|---|---|
| `intent.checkout` | 2 | 1 | 7 days, 1 GiB per partition |
| `intent.atc` | 2 | 1 | 7 days, 1 GiB per partition |
| `intent.click` | 3 | 1 | 7 days, 1 GiB per partition |
| `intent.other` | 3 | 1 | 7 days, 1 GiB per partition |

- **Partitions** are a fixed infrastructure number, not one per actor. Messages will be keyed by `brand_id + actor_id`, and Kafka hashes keys across partitions, so events for one actor stay ordered. Current load is a few events per second, so counts are small and for consumer parallelism only. Partitions can be increased later, never decreased. Increasing changes which partition new messages for a key go to, so do it with consumers drained.
- **Replication 1**: this is a single broker on one EC2 host. It is not highly available. A disk or host loss loses unconsumed data. Multi-broker HA is out of scope.
- **Retention**: 7 days gives replay time after a bad deploy or weekend gap. The 1 GiB per-partition cap (about 10 GiB across all partitions at most) stops the disk from filling.

### Add a topic
Add a line to `topics.conf` (`name partitions retention_ms retention_bytes`) and re-run `docker compose up -d kafka-init` (or `docker compose run --rm kafka-init`). Existing topics are never altered or deleted.

### Change an existing topic
The init script only creates. Use the Kafka CLI inside the broker container:
```
docker exec kafka-service-main /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics --entity-name intent.click --add-config retention.ms=259200000
docker exec kafka-service-main /opt/kafka/bin/kafka-topics.sh  --bootstrap-server localhost:9092 --alter --topic intent.click --partitions 4
```
Keep `topics.conf` in step with what you changed.

## Resources (4 GB EC2 host shared with the other services)
- JVM heap `-Xms512m -Xmx512m` (`KAFKA_HEAP_OPTS`).
- Container memory cap 1 GiB (`KAFKA_MEM_LIMIT`): heap plus headroom for the page cache. Measured about 410 MiB idle.
- No CPU limit. Watch host memory after deploy.

## Health and readiness
The healthcheck calls `kafka-broker-api-versions.sh` against the broker, which is a real protocol request, not just an open port. `kafka-init` waits for `service_healthy`. A service that needs Kafka and the topics should use:
```
depends_on:
  kafka-init:
    condition: service_completed_successfully
```

## Configuration
Defaults live in `docker-compose.yml`. Overrides: see `.env.example` (`KAFKA_IMAGE_TAG`, `KAFKA_HEAP_OPTS`, `KAFKA_MEM_LIMIT`, `KAFKA_REPLICATION_FACTOR`, `KAFKA_BOOTSTRAP_SERVERS`). `auto.create.topics.enable` is off, so topics exist only through `topics.conf`.
