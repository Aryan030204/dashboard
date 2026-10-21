# weekly-reports-service

Brand-scoped Weekly Reports: authors upload a PPT, PPTX or PDF, it is converted to slide images, and clients
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

## Accepted files

`.pptx`, `.ppt` and `.pdf`, up to `MAX_UPLOAD_BYTES` (50 MB) and `MAX_SLIDES` pages (100).

- Each type is checked by its real content, not just the extension (a `.pdf` must contain the `%PDF-`
  header, a `.pptx` must be a valid OOXML zip without macros, a `.ppt` must be an OLE file).
- Presentations are converted with LibreOffice first. A PDF skips that step and goes straight to poppler.
- Every page is rendered scaled to `SLIDE_WIDTH` (1920 px), so memory use is bounded. A PDF with a page
  that would render absurdly tall, with too many pages, or that is damaged/password-protected is
  rejected with a clear message and never shown to clients.
- PDFs are only rasterised: no scripts or embedded content ever run.

## Duplicate titles and weeks

Both are warnings, never errors. The upload form asks `GET /weekly-reports/check` first.

- **Same title** (per brand, case-insensitive, ignoring deleted/cancelled presentations): the form warns
  and names what it would be saved as. If the admin uploads anyway, the server saves it as
  `Title (1)`, then `(2)`, and so on. The server does this itself, so direct API calls get the same
  result. A per-brand database lock stops two simultaneous uploads taking the same title.
- **Same week**: the form warns how many presentations that week already has. If the admin uploads
  anyway, the title and the week text stay exactly as typed; it is stored as the next version of
  that week and nothing is replaced.
- Same title and same week together: only the title gets the suffix; the week text never changes.

## Delete and cancel

- **Delete** (finished or failed presentations, never a published one) hides the report and deletes
  everything under `<BRAND>/<report id>/` in S3: the original upload, slides and thumbnails.
- **Cancel** (presentations still queued or converting) hides the report, stops a running conversion
  (the worker kills LibreOffice within about `CANCEL_POLL_MS`) and deletes every file already written.
- If S3 is unreachable or a worker still holds the report, the files are removed by the worker's
  cleanup sweep as soon as possible; it retries until they are gone. It also cleans up reports deleted
  before migration 003 existed, the first time the worker runs.
- The IAM policy needs `s3:DeleteObject` on the bucket's objects and `s3:ListBucket` on the bucket.

## First-time setup (once per environment)

1. Create a **private** S3 bucket (Block Public Access on, default encryption on) and give the host's
   IAM role Get/Put/Delete on that bucket only. Set `WEEKLY_REPORTS_BUCKET`.
2. Apply `migrations/001-create-weekly-reports.sql`, `002-add-progress-columns.sql`,
   `003-add-storage-purge.sql` and `004-allow-pdf-source.sql` (once each, in that order) to the central
   MySQL 8 database (needs `FOR UPDATE SKIP LOCKED`).
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
