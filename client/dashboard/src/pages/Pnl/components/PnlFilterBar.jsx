import {
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import { FunnelRangeOrDatePicker } from "../../../components/DailyFunnelPanel.jsx";

export default function PnlFilterBar({
  start,
  end,
  granularity,
  onRangeChange,
  onGranularityChange,
}) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "stretch", sm: "center" }}
      spacing={1.25}
      flexWrap="wrap"
      useFlexGap
    >
      <FunnelRangeOrDatePicker
        startDate={start}
        endDate={end}
        onApply={onRangeChange}
        compact
      />

      <ToggleButtonGroup
        size="small"
        value={granularity}
        exclusive
        onChange={(_event, next) => next && onGranularityChange(next)}
      >
        <ToggleButton value="daily">Daily</ToggleButton>
        <ToggleButton value="monthly">Monthly</ToggleButton>
      </ToggleButtonGroup>

      <Tooltip title="Channel-level breakdown is to be implemented">
        <span>
          <Select size="small" value="all" disabled sx={{ minWidth: 140 }}>
            <MenuItem value="all">All Channels</MenuItem>
          </Select>
        </span>
      </Tooltip>

      <Tooltip title="Product-level breakdown is to be implemented">
        <span>
          <Select size="small" value="all" disabled sx={{ minWidth: 140 }}>
            <MenuItem value="all">All Products</MenuItem>
          </Select>
        </span>
      </Tooltip>
    </Stack>
  );
}
