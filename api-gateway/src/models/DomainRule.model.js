const mongoose = require('mongoose');
const { AUTH_ROLES } = require('../services/rbac.service');

const DomainRuleSchema = new mongoose.Schema({
  domain: {
    type: String,
    required: true,
    unique: true, // stored lowercase
  },
  role: {
    type: String,
    enum: AUTH_ROLES,
    required: true,
    default: 'viewer',
  },
  primary_brand_id: {
    type: String,
    required: true,
  },
  brand_ids: {
    type: [String],
    default: [],
  },
  permissions: {
    type: [String],
    default: ['all'],
    enum: [
      'all',
      'overall_snapshot',
      'requests_panel',
      'requests_timeline',
      'bundles_panel',
      'inventory_panel',
      'daily_funnel_panel',
      'intent_funnel_panel',
      'weekly_report_preview',
      'utm_funnel_table',
      "product_type_filter",
      'product_filter',
      "daily_insight_view",
      'utm_filter',
      'product_utm_filter_sync',
      'discount_filter',
      'intent_metrics',
      "dashboard_layout_customize",
      "session_analytics",
      'web_vitals',
      'payment_split_order',
      'payment_split_sales',
      'traffic_split',
      'sales_channel_filter',
      'device_type_filter',
      'sessions_drop_off_funnel',
      'product_conversion',
      'compare_mode',
      'multiselectable_kpi_cards',
      "ci_events",
      "rto_kpi",
      'product_conversion:landing_page_path',
      'product_conversion:sessions',
      'product_conversion:atc',
      'product_conversion:atc_rate',
      'product_conversion:orders',
      'product_conversion:sales',
      'product_conversion:cvr',
      'product_conversion:drr',
      'product_conversion:doh',
      'product_table_filters',
      'product_table_filters:inventory',
      'product_table_filters:page_type',
      'product_table_filters:product_types',
      'product_table_filters:sort_filter',
    ],
  },
  status: {
    type: String,
    enum: ['active', 'suspended'],
    default: 'active',
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

DomainRuleSchema.index({ domain: 1 }, { unique: true });
DomainRuleSchema.index({ domain: 1, status: 1 });

module.exports = mongoose.model('DomainRule', DomainRuleSchema);
