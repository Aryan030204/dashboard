import { useEffect, useMemo, useState } from "react";
import { Box, Chip, CircularProgress, FormControl, InputLabel, MenuItem, Select, Typography } from "@mui/material";
import PublishedReports from "./PublishedReports.jsx";
import ManagerView from "./ManagerView.jsx";

const norm = (v) => (v || "").toString().trim().toUpperCase();

// One panel for both audiences. `canManage` only chooses which UI to render; the service
// independently refuses every manage call from a non-elevated user, and re-checks that the
// selected brand is one the caller may use.
export default function WeeklyReportsPanel({ brands = [], brandsLoading = false, initialBrandKey = "", canManage }) {
  const options = useMemo(() => {
    const seen = new Set();
    return brands
      .map((b) => norm(typeof b === "string" ? b : b?.key))
      .filter((key) => key && !seen.has(key) && seen.add(key));
  }, [brands]);

  const [brand, setBrand] = useState(() => norm(initialBrandKey));

  // Pick a sensible brand once the list is known: the app's current brand if it is allowed,
  // otherwise the first one available.
  useEffect(() => {
    if (!options.length) return;
    if (!brand || !options.includes(brand)) {
      const preferred = norm(initialBrandKey);
      setBrand(options.includes(preferred) ? preferred : options[0]);
    }
  }, [options, brand, initialBrandKey]);

  const showDropdown = options.length > 1;

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", width: "100%", pb: 4 }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "stretch", sm: "center" },
          justifyContent: "space-between",
          gap: 1.5,
          mb: 2.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h1" sx={{ fontSize: { xs: 22, md: 26 }, fontWeight: 700, color: "text.primary", lineHeight: 1.2 }}>
            Weekly Reports
          </Typography>
          <Typography sx={{ color: "text.secondary", mt: 0.5, fontSize: 14 }}>
            {canManage ? "Upload, publish and manage the weekly presentations for a brand." : "Preview the weekly presentations shared with your brand."}
          </Typography>
        </Box>

        {brandsLoading && !options.length ? (
          <CircularProgress size={22} aria-label="Loading brands" />
        ) : showDropdown ? (
          <FormControl size="small" sx={{ minWidth: { sm: 220 } }} fullWidth={false}>
            <InputLabel id="wr-brand-label">Brand</InputLabel>
            <Select
              labelId="wr-brand-label"
              label="Brand"
              value={options.includes(brand) ? brand : ""}
              onChange={(e) => setBrand(e.target.value)}
              MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
              sx={{ width: { xs: "100%", sm: 220 } }}
            >
              {options.map((key) => (
                <MenuItem key={key} value={key}>{key}</MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : brand ? (
          <Chip label={brand} variant="outlined" sx={{ alignSelf: { xs: "flex-start", sm: "center" }, fontWeight: 600, color: "text.primary" }} />
        ) : null}
      </Box>

      {!brand ? (
        <Typography sx={{ color: "text.secondary" }}>No brand is available for your account.</Typography>
      ) : canManage ? (
        <ManagerView key={brand} brandKey={brand} />
      ) : (
        <PublishedReports key={brand} brandKey={brand} />
      )}
    </Box>
  );
}
