# weekly-reports-service

Brand-scoped Weekly Reports: authors upload a PPT/PPTX, it is converted to slide images, and clients
with `weekly_report_preview` can preview the published reports of their brand. Product requirements: `docs/datum-weekly-reports-prd.pdf`.

Two containers from one image (`Dockerfile` targets):

- `api` (`weekly-reports-service`, port 4040): HTTP API behind the gateway at `/weekly-reports`.
- `worker` (`weekly-reports-worker`): claims `PROCESSING` reports, runs LibreOffice and poppler, writes
  WebP slides to the bucket, sets `READY`.

## Security model (do not weaken)

- Brand and role come only from the gateway-signed headers (`x-brand-id`, `x-role`, HMAC `x-gw-sig`).
  A brand in the query or body must agree with it or the request is rejected (400).
- Preview = `weekly_report_preview`: lists and previews only the PUBLISHED reports of the user's own
  brand, nothing else. Manage (upload, publish, unpublish, delete, drafts and history) = elevated roles
  only; no permission can substitute.
- Publishing only changes the report being published: any number of presentations can be published at
  once, and the admin unpublishes the ones that should not be visible.
- The original file has no route. Slides are streamed through the API (no overlay is applied);
  the bucket is private and no storage URL is ever returned.
- The service refuses to start without `GATEWAY_SHARED_SECRET`.

## First-time setup (once per environment)

1. Create a **private** S3 bucket (Block Public Access on, default encryption on) and give the host's
   IAM role Get/Put/Delete on that bucket only. Set `WEEKLY_REPORTS_BUCKET`.
2. Apply `migrations/001-create-weekly-reports.sql`, then `migrations/002-add-progress-columns.sql`
   (once each, in that order) to the central MySQL 8 database (needs `FOR UPDATE SKIP LOCKED`).
3. Copy `.env.example` to `.env` and fill `WR_DB_*`, `WEEKLY_REPORTS_BUCKET`, `GATEWAY_SHARED_SECRET`.
4. Optional: put brand fonts used in decks into `fonts/` before building the worker image.
5. Build and start: `docker compose up -d --build weekly-reports-service weekly-reports-worker api-gateway`.
6. Grant `weekly_report_preview` to client users per brand in Access Control.

The worker image installs LibreOffice, so the first build is large. The worker is capped at 2 GB
(`WEEKLY_REPORTS_WORKER_MEM_LIMIT`) because the EC2 host also runs Kafka.

## Tests

```
npm test                       # routes, isolation matrix, upload validation, processor, slide cache
```

The real-SQL tests are skipped unless a MySQL 8 is available:

```
docker run -d --name wr-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=wr -p 33310:3306 mysql:8
WR_TEST_DB_HOST=127.0.0.1 WR_TEST_DB_PORT=33310 WR_TEST_DB_USER=root WR_TEST_DB_PASSWORD=pw WR_TEST_DB_NAME=wr npm test
```
