const ClientSettings = require('../models/ClientSettings.model');

const GLOBAL_KEY = 'global';

class ClientSettingsService {
  static async getSettings() {
    const doc = await ClientSettings.findOneAndUpdate(
      { key: GLOBAL_KEY },
      { $setOnInsert: { key: GLOBAL_KEY } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { dashboardBannerEnabled: !!doc.dashboardBannerEnabled };
  }

  static async updateSettings({ dashboardBannerEnabled }) {
    const doc = await ClientSettings.findOneAndUpdate(
      { key: GLOBAL_KEY },
      { $set: { dashboardBannerEnabled: !!dashboardBannerEnabled } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { dashboardBannerEnabled: !!doc.dashboardBannerEnabled };
  }
}

module.exports = ClientSettingsService;
