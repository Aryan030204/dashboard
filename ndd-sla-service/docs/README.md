# Sample files for manual upload

Use these to try the **Upload reports** button on the NDD / SLA page. Pick report date **2026-11-19**.

| File | Upload as |
| --- | --- |
| `sample-gokwik-orders-2026-11-19.csv` | GoKwik report |
| `sample-easycom-shipments-2026-11-19.csv` | EasyCom report |

Plain `.csv` or gzipped `.csv.gz` both work.

## Columns the service reads

GoKwik file: `Reference Code`, `Client Location`, `Order Status`, `Courier`, `Order Date`.
EasyCom file: `Reference Code`, `Shipment(Pickup At)`.

Column order does not matter. Headers ignore case, spaces and punctuation, common alternative names are accepted
(e.g. `Courier Name`, `Shipment Picked At`, `Pickup At`), and a banner/blank lines above the header row are skipped.
Reference Codes are compared without a leading backtick/apostrophe (Excel text prefix). Dates: `YYYY-MM-DD HH:mm[:ss]`,
`MM/DD/YYYY HH:mm` (EasyCom export), `DD-MM-YYYY HH:mm`, optional AM/PM; if day/month is ambiguous, `/` is month-first and `-` is day-first.
The real exports are in `easy ecom OG.csv` and `gokwik OG.csv`.

Header names are matched ignoring case and extra spaces. Other columns (such as `Remarks`, `AWB`) are ignored.
If your real files use different names, set `NDD_SLA_COL_*` and `NDD_SLA_EASYCOM_FILE_COL_*` in `ndd-sla-service/.env`
(see `.env.example`). Dates are read as `YYYY-MM-DD HH:mm:ss` or `DD-MM-YYYY HH:mm:ss`, in IST.

## Expected result for 2026-11-19

Windows: NDD orders 18 Nov 12:00 PM to 19 Nov 12:00 PM, all other orders 18 Nov 3:00 PM to 19 Nov 3:00 PM
(start included, end excluded).

| | Orders | SLA Met | SLA Breached |
| --- | --- | --- | --- |
| **Total** | **8** | **5** | **3** |
| AJMAL & SONS | 5 | 3 (AJM-1001, AJM-1003, AJM-1005) | 2 (AJM-1002, AJM-1004) |
| Emiza Gurgaon | 3 | 2 (EMZ-2001, EMZ-2002) | 1 (EMZ-2003) |

Row counts: 17 read, 8 kept, 1 other client, 3 excluded statuses, 3 outside their window,
1 duplicate, 1 invalid date. EMZ-2003 is also counted as "not found in EasyCom".

Each excluded row says why in its `Remarks` column. Missing, empty or `00-01-1900` pickup values are stored as
no pickup (NULL) and count as SLA Breached.

---

# Rich sample files (random but reproducible)

Larger, realistic files for trying the page with real-looking volume. Report date **2026-11-19**.

| File | Upload as |
| --- | --- |
| `sample-gokwik-orders-rich-2026-11-19.csv` | GoKwik report (778 rows) |
| `sample-easycom-shipments-rich-2026-11-19.csv` | EasyCom report (731 rows) |
| `sample-expected-rich-2026-11-19.json` | What the report must show (not uploaded) |

What is in them:
- Many couriers: NDD ones (`ElasticrunDirectNDD`, `BlitzNDD`, `Shadowfax NDD`, `dunzo ndd`) and regular ones (Delhivery, BlueDart, Ecom Express, XpressBees, DTDC, and more).
- Both clients, 12 cities, prepaid / COD orders, order values, customer names, AWB numbers, and remarks with commas and quotes.
- Orders spread over the whole window, with some exactly on the window start and end.
- Everything the rules must reject: other clients (including `ajmal and sons`, which is not an exact match), cancelled / on hold / returned in several spellings, orders outside their window, duplicate Reference Codes, unreadable order dates, and rows with no Reference Code.
- EasyCom pickups that are blank, the Excel `00-01-1900` placeholder, the text `pending`, in `DD-MM-YYYY` format, re-scan rows with an empty pickup before the real one, shipments for unknown orders, and about 4% of orders missing entirely.

Expected result (also in the JSON, together with the hourly breakdown):

| | Orders | SLA Met | SLA Breached |
| --- | --- | --- | --- |
| **Total** | **646** | **507** | **139** |
| AJMAL & SONS | 450 | 355 | 95 |
| Emiza Gurgaon | 196 | 152 | 44 |

Rows excluded: 35 other client, 40 excluded status, 28 outside their window, 15 duplicates, 14 invalid.
27 kept orders are not in the EasyCom file (counted as breached and shown as "not found in EasyCom").

Regenerate (same seed gives the same files) or change the data with `--seed`:

```
node scripts/generate-sample-data.js --seed 19112026
```
