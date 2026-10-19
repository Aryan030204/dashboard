import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, LinearProgress, Paper, Stack, TextField, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import { uploadWeeklyReport } from "../../lib/api.js";
import {
  MAX_UPLOAD_BYTES,
  defaultReportingWeek,
  describeFailure,
  formatBytes,
  hasAcceptedExtension,
  titleFromFilename,
} from "./reportUi.js";

// Uploads for the SELECTED brand only. There is no brand field in the form: the service takes the
// brand from the gateway-signed identity and rejects a different one.
export default function ReportUploader({ brandKey, onUploaded }) {
  const theme = useTheme();
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [week, setWeek] = useState(() => defaultReportingWeek());
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pick = useCallback((picked) => {
    setError("");
    if (!picked) return;
    if (!hasAcceptedExtension(picked.name)) {
      setFile(null);
      setError("Only .pptx or .ppt files are supported.");
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setError(`File is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
      return;
    }
    setFile(picked);
    setTitle((current) => current || titleFromFilename(picked.name));
  }, []);

  const submit = async () => {
    if (!file || uploading) return;
    if (!title.trim() || !week.trim()) {
      setError("Enter a presentation title and a reporting week.");
      return;
    }
    setError("");
    setUploading(true);
    setProgress(0);
    abortRef.current = new AbortController();
    const result = await uploadWeeklyReport(
      brandKey,
      { file, title: title.trim(), reportingWeek: week.trim() },
      { onProgress: setProgress, signal: abortRef.current.signal },
    );
    setUploading(false);
    if (result.aborted) return;
    if (result.error) {
      setError(describeFailure(result, "Upload failed. Please try again."));
      return;
    }
    setFile(null);
    setTitle("");
    if (inputRef.current) inputRef.current.value = "";
    onUploaded?.(result.data);
  };

  const pct = Math.round(progress * 100);

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2.5 } }}>
      <Typography component="h2" sx={{ color: "text.primary", fontWeight: 700, fontSize: 17, mb: 1.5 }}>
        Upload a presentation
      </Typography>

      <Box
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) pick(e.dataTransfer.files?.[0]);
        }}
        sx={{
          border: "2px dashed",
          borderColor: dragging ? "primary.main" : "divider",
          bgcolor: dragging ? alpha(theme.palette.primary.main, 0.08) : "transparent",
          borderRadius: 2,
          p: { xs: 2, md: 3 },
          textAlign: "center",
          transition: "border-color .15s, background-color .15s",
        }}
      >
        <CloudUploadOutlinedIcon sx={{ color: "primary.main", fontSize: 30 }} />
        {file ? (
          <>
            <Typography sx={{ color: "text.primary", fontWeight: 600, overflowWrap: "anywhere" }}>{file.name}</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>{formatBytes(file.size)}</Typography>
          </>
        ) : (
          <Typography sx={{ color: "text.primary", fontWeight: 600 }}>Drop a PPT or PPTX here</Typography>
        )}
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.25 }}>
          or choose a file (max {Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)
        </Typography>
        <Button variant="outlined" size="small" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {file ? "Choose a different file" : "Choose file"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".pptx,.ppt"
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
          data-testid="report-file-input"
        />
      </Box>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2 }}>
        <TextField
          label="Title"
          size="small"
          fullWidth
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={uploading}
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <TextField
          label="Reporting week"
          size="small"
          value={week}
          onChange={(e) => setWeek(e.target.value)}
          disabled={uploading}
          sx={{ minWidth: { sm: 180 } }}
          slotProps={{ htmlInput: { maxLength: 40 } }}
        />
      </Stack>

      {uploading && (
        <Box sx={{ mt: 2 }} aria-live="polite">
          <Typography variant="body2" sx={{ color: "text.primary", fontWeight: 600 }}>
            {pct < 100 ? `Uploading file: ${pct}%` : "Upload complete. Starting conversion..."}
          </Typography>
          <LinearProgress variant="determinate" value={pct} sx={{ mt: 0.75, height: 6, borderRadius: 3 }} />
        </Box>
      )}
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ mt: 2 }} alignItems={{ xs: "stretch", sm: "center" }}>
        <Button variant="contained" disableElevation onClick={submit} disabled={!file || uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        {uploading && <Button onClick={() => abortRef.current?.abort()}>Cancel</Button>}
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Saved to {brandKey}. It stays hidden from users until you publish it.
        </Typography>
      </Stack>
    </Paper>
  );
}
