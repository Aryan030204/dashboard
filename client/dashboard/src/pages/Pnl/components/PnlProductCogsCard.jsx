import { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import { downloadProductCogsTemplate, getProductCogsConfig, uploadProductCogsTemplate } from "../../../lib/api.js";
import { Banner, Icon, SourceCard } from "./pnlUi.jsx";
import { ICONS } from "./pnlIcons.js";

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

// Flat per-product COGS: download a CSV of this brand's products (product_id
// + title, from product_landing_mapping), fill in a cogs value per product,
// and upload it back. The upload replaces the brand's whole product_config
// document and also rolls the sum into the COGS cost line, so onUploaded
// refreshes the page's cost config to keep the statement's COGS row in sync.
export default function PnlProductCogsCard({ brandKey, onUploaded }) {
  const [status, setStatus] = useState(null); // { exists, productConfig, updatedByEmail, updatedAt }
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState([]);
  const fileRef = useRef(null);

  const loadStatus = (cancelledRef) =>
    getProductCogsConfig({ brand_key: brandKey }).then((result) => {
      if (cancelledRef?.cancelled) return;
      setStatus(result.error ? null : result.data?.config || null);
    });

  useEffect(() => {
    if (!brandKey) return undefined;
    const ref = { cancelled: false };
    setMessage("");
    setError("");
    setRowErrors([]);
    loadStatus(ref);
    return () => {
      ref.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandKey]);

  const handleDownload = async () => {
    setDownloading(true);
    setError("");
    setMessage("");
    const result = await downloadProductCogsTemplate({ brand_key: brandKey });
    setDownloading(false);
    if (result.error) {
      setError("Failed to download the template.");
      return;
    }
    downloadBlob(result.blob, result.filename);
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file after a failed upload
    if (!file) return;

    setUploading(true);
    setError("");
    setMessage("");
    setRowErrors([]);
    const result = await uploadProductCogsTemplate({ brand_key: brandKey, file });
    setUploading(false);

    if (result.error) {
      setError(result.data?.error || "Failed to upload the CSV.");
      return;
    }
    const data = result.data || {};
    setRowErrors((data.results || []).filter((row) => row.status === "error"));
    if (data.succeeded > 0) {
      const aggregate = Number.isFinite(data.aggregateCogs) ? data.aggregateCogs.toFixed(2) : data.aggregateCogs;
      setMessage(
        data.success
          ? `Saved COGS for ${data.succeeded} product${data.succeeded === 1 ? "" : "s"}. The total (${aggregate}) now feeds the COGS line.`
          : `Saved COGS for ${data.succeeded} product(s); ${data.failed} row(s) had errors — see below.`,
      );
    } else {
      setError(data.error || "No valid rows were found in the CSV.");
    }
    await loadStatus();
    onUploaded?.();
  };

  const configuredCount = status?.productConfig ? Object.keys(status.productConfig).length : 0;

  return (
    <SourceCard
      id="source-cogs"
      name="Per-product COGS"
      status={configuredCount ? `${configuredCount} product${configuredCount === 1 ? "" : "s"}` : null}
      tone="neutral"
    >
      <p className="pnl-source-detail" style={{ flex: "1 1 auto" }}>
        Download this brand&apos;s product list, fill in a cost per product, and upload it back.
        {status?.updatedAt
          ? ` Last uploaded ${dayjs(status.updatedAt).format("DD MMM YYYY, HH:mm")}${status.updatedByEmail ? ` by ${status.updatedByEmail}` : ""}.`
          : ""}
      </p>

      {error ? <Banner tone="bad">{error}</Banner> : null}
      {message ? <Banner tone="good">{message}</Banner> : null}
      {rowErrors.length > 0 ? (
        <Banner>
          {rowErrors.length} row{rowErrors.length === 1 ? "" : "s"} skipped:{" "}
          {rowErrors
            .slice(0, 5)
            .map((row) => `line ${row.line} (${row.error})`)
            .join(", ")}
          {rowErrors.length > 5 ? "…" : ""}
        </Banner>
      ) : null}

      <div className="pnl-edit-actions">
        <button type="button" className="pnl-ctl" onClick={handleDownload} disabled={downloading}>
          <Icon d={ICONS.download} stroke={1.9} />
          <span>{downloading ? "Downloading…" : "Template"}</span>
        </button>
        <button type="button" className="pnl-ctl" onClick={() => fileRef.current?.click()} disabled={uploading}>
          <Icon d={ICONS.upload} stroke={1.9} />
          <span>{uploading ? "Uploading…" : "Upload CSV"}</span>
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={handleFileChange} />
      </div>
    </SourceCard>
  );
}
