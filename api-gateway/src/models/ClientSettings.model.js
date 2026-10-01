const mongoose = require('mongoose');

// Single global document (key: 'global') holding site-wide, non-brand-scoped
// settings toggled by admins/authors from the dashboard's Client Side
// Settings panel.
const ClientSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'global',
  },
  dashboardBannerEnabled: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

module.exports = mongoose.model('ClientSettings', ClientSettingsSchema);
