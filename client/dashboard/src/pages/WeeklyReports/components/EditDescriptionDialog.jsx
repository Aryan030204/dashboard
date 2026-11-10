import { useEffect, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from "@mui/material";
import { MAX_DESCRIPTION_WORDS, countWords, limitWords } from "../weeklyReportsFormat.js";

// Author-only editor for a presentation's description. Saving an empty box clears it.
export default function EditDescriptionDialog({ report, saving = false, onSave, onClose }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (report) setValue(report.description || "");
  }, [report]);

  const unchanged = value.trim() === (report?.description || "").trim();

  return (
    <Dialog open={Boolean(report)} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit description</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={5}
          maxRows={12}
          margin="dense"
          label={report?.title ? `Description for "${report.title}"` : "Description"}
          placeholder="Up to 100 words. Only authors can see it."
          value={value}
          disabled={saving}
          onChange={(event) => setValue(limitWords(event.target.value, MAX_DESCRIPTION_WORDS))}
          helperText={`${countWords(value)} / ${MAX_DESCRIPTION_WORDS} words`}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={saving || unchanged}
          onClick={() => onSave(value.trim())}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
