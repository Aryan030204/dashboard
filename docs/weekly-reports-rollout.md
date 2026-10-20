# Weekly Reports: verification and rollout runbook

Everything below is run by you. Nothing here has been run against Docker, MySQL, S3 or the gateway
yet; the unit tests (`npm test` in `weekly-reports-service`) and the client build pass locally.

## 1. Prerequisites

- [ ] MySQL 8 database for the three tables; apply `weekly-reports-service/migrations/001-create-weekly-reports.sql`
      then `002-add-progress-columns.sql` and `003-add-storage-purge.sql` (once each, in that order).
- [ ] Private S3 bucket (Block Public Access on, default encryption on) + IAM permission
      Get/Put/Delete on that bucket only for the EC2 role.
- [ ] `weekly-reports-service/.env` from `.env.example` (`WR_DB_*`, `WEEKLY_REPORTS_BUCKET`,
      `GATEWAY_SHARED_SECRET` identical to the gateway's).
- [ ] Brand fonts used in decks copied into `weekly-reports-service/fonts/` (optional).
- [ ] About 1-2 GB RAM free on the host beside Kafka (worker cap defaults to 2 GB).

## 2. Local checks (Docker Desktop on your machine)

### a) Real SQL: version numbers, job claiming, publish swap

```
docker run -d --name wr-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=wr -p 33310:3306 mysql:8
cd weekly-reports-service
WR_TEST_DB_HOST=127.0.0.1 WR_TEST_DB_PORT=33310 WR_TEST_DB_USER=root WR_TEST_DB_PASSWORD=pw WR_TEST_DB_NAME=wr npm test
docker rm -f wr-mysql
```
Expected: all tests pass, none skipped (the MySQL ones included).

### b) Real conversion (LibreOffice + poppler)

```
cd weekly-reports-service
pip install python-pptx
python scripts/make-sample-deck.py sample.pptx 18
docker build --target worker -t weekly-reports-worker .
docker run --rm -v "%cd%:/data" weekly-reports-worker node scripts/convert-local.js /data/sample.pptx /data/out
```
(PowerShell: use `${PWD}` instead of `%cd%`.) Expected: "converted 18 slide(s)", and `out/001.webp ...`
plus thumbnails. Open a few images and check text, chart and fonts. Also try one real Canva export
and one deck with the brand fonts; this is the biggest fidelity risk.

### c) Config validity

```
docker compose config -q                       # compose file parses
docker run --rm -v "%cd%\api-gateway\gateway\nginx.conf:/tmp/nginx.conf:ro" openresty/openresty:alpine nginx -t -c /tmp/nginx.conf
```
The second command may complain about missing Lua modules or hostnames when run alone; the real check
is that the gateway container starts after `docker compose up -d --build api-gateway`.

## 3. Staging smoke test (real gateway, S3, MySQL)

Use one author account and one client account that has `weekly_report_preview` on brand A only.

| # | Do | Expect |
|---|---|---|
| 1 | Author, brand A: upload the 18-slide sample | Row appears as PROCESSING, becomes READY within ~2 min, 18 slides |
| 2 | Author: Preview | Viewer opens, arrows/thumbnails/fullscreen/keys work |
| 3 | Client, brand A | Empty state: no presentations yet |
| 4 | Author: Publish | Client reload lists it; Preview opens the viewer |
| 5 | Client: DevTools network | Slide requests go to `/weekly-reports/<id>/slides/<n>`, no S3 URL anywhere, no source file request |
| 6 | Client: try `POST /weekly-reports`, publish, delete from DevTools | 403 each |
| 7 | Client: switch to brand B (if a member) | Sees only B's report or the empty state |
| 8 | Client: request a brand-B report id while on brand A | 403 |
| 9 | Author: upload same week again, publish v2 | Client sees v2; v1 is UNPUBLISHED in history |
| 10 | Author: upload a .pdf, a renamed .txt, a 60 MB file | Rejected with a clear message each time |
| 11 | Remove `weekly_report_preview` from the client | Menu item gone; `/weekly-reports` redirects; API 403 |
| 11a | Upload a deck with a title that already exists for the brand | Warning appears, nothing uploaded yet; button reads "Upload anyway". Clicking it saves the deck as `Title (1)` and shows a toast saying so |
| 11b | Upload a deck into a week that already has one, with a new title | Warning about the week; "Upload anyway" saves it with the exact title and week typed (as the next version of that week) |
| 11c | Edit the title or week after a warning | The warning disappears and the next click checks again |
| 12 | Delete a finished presentation, then look in the bucket | Its `<BRAND>/<id>/` folder is gone (source, slides, thumbnails); other presentations' folders remain |
| 13 | Upload two decks back to back; Cancel the second while it is queued | It disappears from the list; its folder is removed from the bucket; the first deck keeps converting |
| 14 | Cancel a deck while it shows "Converting" | It disappears; within a few seconds the worker log shows it stopped, no soffice process remains, its folder is removed |
| 15 | Stop the worker mid-conversion | Report goes FAILED (`PROCESSING_TIMEOUT`) after ~6 min, never visible to clients |

## 4. Production

1. Deploy with nobody holding the permission (only elevated roles can see the panel).
2. Pilot with one brand (BBB): upload, preview, publish, check as a real client user.
3. Grant `weekly_report_preview` to client users in Access Control.

The gateway does not wait for the weekly-reports containers. If they are down or not deployed yet,
`/weekly-reports` answers 502 and everything else in Datum keeps working, so it is safe to deploy
`main` before the bucket, migrations and `.env` exist. Check once with
`docker compose stop weekly-reports-service weekly-reports-worker && docker compose up -d api-gateway`.

## 5. Rollback

Stop `weekly-reports-service` and `weekly-reports-worker` and remove the `/weekly-reports` nginx
locations. No existing service or table is modified, so there is nothing to undo elsewhere.
Reports already in the bucket are untouched.
