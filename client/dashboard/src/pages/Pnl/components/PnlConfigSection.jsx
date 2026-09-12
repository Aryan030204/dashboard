import { Box, Card, Chip, Stack, Typography } from "@mui/material";

const CONFIG_CATEGORIES = [
  { label: "COGS (SKU level)" },
  { label: "Packaging Cost" },
  { label: "Freight Inwards" },
  { label: "Shipping / RTO Costs" },
  { label: "Brand Marketing Costs" },
  { label: "Operating Expenses" },
];

export default function PnlConfigSection() {
  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={0.5} sx={{ mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Brand Cost Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Manual cost inputs (category, amount, date/month, recurring or one-time) will be
          configurable here once the cost-configuration API is built.
        </Typography>
      </Stack>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(3, 1fr)" },
          gap: 1.5,
        }}
      >
        {CONFIG_CATEGORIES.map((category) => (
          <Stack
            key={category.label}
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ p: 1.5, border: "1px dashed", borderColor: "divider", borderRadius: 1.5 }}
          >
            <Typography variant="body2">{category.label}</Typography>
            <Chip label="To be implemented" size="small" variant="outlined" />
          </Stack>
        ))}
      </Box>
    </Card>
  );
}
