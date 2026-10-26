import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { toast } from "react-toastify";
import {
  checkWeeklyReport,
  uploadWeeklyReport,
  weeklyReportErrorMessage,
} from "../../../lib/api.js";
import {
  ACCEPT_ATTRIBUTE,
  MAX_TITLE_LENGTH,
  MAX_WEEK,
  MIN_WEEK,
  formatFileSize,
  isValidWeek,
  titleFromFileName,
  validatePresentationFile,
} from "../weeklyReportsFormat.js";

export default function UploadCard({ brandKey, onUploaded }) {
  const inputRef = useRef(null);
  const uploadRef = useRef(null);
  const titleTouchedRef = useRef(false);

  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [title, setTitle] = useState("");
  const [week, setWeek] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [existing, setExisting] = useState(null);

  const weekValid = isValidWeek(week);
  const canUpload = Boolean(file) && Boolean(title.trim()) && weekValid && !uploading;

  // Abort an in-flight upload if the card goes away (e.g. the brand changes).
  useEffect(() => () => uploadRef.current?.abort(), []);

  // Warn early when this title or week already has an upload for the brand.
  useEffect(() => {
    setExisting(null);
    const trimmedTitle = title.trim();
    if (!brandKey || !trimmedTitle || !weekValid) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const res = await checkWeeklyReport({
        brandKey,
        title: trimmedTitle,
        reportingWeek: week.trim(),
        signal: controller.signal,
      });
      if (!res.error && !controller.signal.aborted) setExisting(res.data);
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [brandKey, title, week, weekValid]);

  const selectFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (files.length > 1) {
      setFileError("Please upload one file at a time.");
      return;
    }
    const picked = files[0];
    const problem = validatePresentationFile(picked);
    if (problem) {
      setFile(null);
      setFileError(problem);
      return;
    }
    setFileError("");
    setUploadError("");
    setFile(picked);
    if (!titleTouchedRef.current) setTitle(titleFromFileName(picked.name));
  }, []);

  const resetForm = () => {
    setFile(null);
    setFileError("");
    setTitle("");
    setWeek("");
    setProgress(0);
    titleTouchedRef.current = false;
  };

  const handleUpload = async () => {
    if (!canUpload) return;
    setUploading(true);
    setProgress(0);
    setUploadError("");
    const upload = uploadWeeklyReport({
      brandKey,
      file,
      title: title.trim(),
      reportingWeek: week.trim(),
      onProgress: setProgress,
    });
    uploadRef.current = upload;
    const res = await upload.promise;
    uploadRef.current = null;
    setUploading(false);

    if (res.aborted) return;
    if (res.error) {
      setUploadError(
        weeklyReportErrorMessage(res, "Upload failed. Check your connection and try again."),
      );
      return;
    }
    if (res.data?.title_adjusted && res.data?.title) {
      toast.info(`That title already existed, so it was saved as "${res.data.title}".`);
    }
    toast.success("Uploaded. Converting the slides now.");
    resetForm();
    onUploaded?.();
  };

  const dropzoneDisabled = uploading;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
        Upload a presentation
      </Typography>

      <Box
        role="button"
        tabIndex={dropzoneDisabled ? -1 : 0}
        aria-label="Upload a PPT, PPTX or PDF file"
        aria-disabled={dropzoneDisabled}
        onClick={() => !dropzoneDisabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (dropzoneDisabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dropzoneDisabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!dropzoneDisabled) selectFiles(event.dataTransfer?.files);
        }}
        sx={{
          border: "1px dashed",
          borderColor: dragging ? "primary.main" : "divider",
          bgcolor: dragging ? "action.hover" : "transparent",
          borderRadius: 2,
          py: 4,
          px: 2,
          textAlign: "center",
          cursor: dropzoneDisabled ? "default" : "pointer",
          opacity: dropzoneDisabled ? 0.7 : 1,
          outline: "none",
          "&:focus-visible": { borderColor: "primary.main" },
        }}
      >
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            selectFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <CloudUploadOutlinedIcon color="primary" sx={{ fontSize: 30 }} />
        {file ? (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="center"
            sx={{ mt: 0.5 }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" fontWeight={700} noWrap>
                {file.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatFileSize(file.size)}
              </Typography>
            </Box>
            {!uploading && (
              <IconButton
                size="small"
                aria-label="Remove file"
                onClick={(event) => {
                  event.stopPropagation();
                  setFile(null);
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            )}
          </Stack>
        ) : (
          <>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 0.5 }}>
              Drop a PPT, PPTX or PDF here
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              or choose a file (max 50 MB)
            </Typography>
            <Button
              size="small"
              variant="outlined"
              sx={{ mt: 1.5 }}
              disabled={dropzoneDisabled}
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              Choose file
            </Button>
          </>
        )}
      </Box>

      {fileError && (
        <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setFileError("")}>
          {fileError}
        </Alert>
      )}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2 }}>
        <TextField
          label="Title"
          size="small"
          fullWidth
          value={title}
          disabled={uploading}
          onChange={(event) => {
            titleTouchedRef.current = true;
            setTitle(event.target.value);
          }}
          inputProps={{ maxLength: MAX_TITLE_LENGTH }}
        />
        <TextField
          label="Reporting week"
          size="small"
          type="number"
          value={week}
          disabled={uploading}
          onChange={(event) => setWeek(event.target.value)}
          error={Boolean(week) && !weekValid}
          helperText={
            week && !weekValid ? `Enter a week from ${MIN_WEEK} to ${MAX_WEEK}` : undefined
          }
          inputProps={{ min: MIN_WEEK, max: MAX_WEEK, step: 1 }}
          sx={{ width: { xs: "100%", sm: 200 }, flexShrink: 0 }}
        />
      </Stack>

      {existing?.title_exists && existing?.suggested_title && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          A presentation with this title already exists, so this one will be saved as "
          {existing.suggested_title}".
        </Alert>
      )}
      {existing?.week_exists && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          Week {week.trim()} already has {existing.week_count || 1}{" "}
          {Number(existing.week_count) === 1 || !existing.week_count ? "upload" : "uploads"}{" "}
          for {brandKey}. This will be added as a new version.
        </Alert>
      )}

      {uploadError && (
        <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setUploadError("")}>
          {uploadError}
        </Alert>
      )}

      {uploading && (
        <Box sx={{ mt: 2 }}>
          <LinearProgress
            variant={progress >= 1 ? "indeterminate" : "determinate"}
            value={Math.round(progress * 100)}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
            {progress >= 1 ? "Finishing up…" : `Uploading… ${Math.round(progress * 100)}%`}
          </Typography>
        </Box>
      )}

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }} flexWrap="wrap">
        <Button variant="contained" disabled={!canUpload} onClick={handleUpload}>
          Upload
        </Button>
        {uploading && (
          <Button variant="outlined" color="inherit" onClick={() => uploadRef.current?.abort()}>
            Cancel
          </Button>
        )}
        <Typography variant="caption" color="text.secondary">
          Saved to {brandKey}. It stays hidden from users until you publish it.
        </Typography>
      </Stack>
    </Paper>
  );
}
