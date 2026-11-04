const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const {
  buildProductConversionService,
} = require('../../services/productConversionService');
const { resolveShopSubdomain } = require('../../shared/utils/shop');
const {
  buildInventoryOosService,
  normalizeOosTrendRequest,
} = require('../../services/inventoryOosService');

function buildProductConversionController() {
  const productConversionService = buildProductConversionService();
  const inventoryOosService = buildInventoryOosService();

  return {
    // Out-of-stock trend for the Inventory panel (inventory_oos_history of the brand database).
    oosTrend: async (req, res) => {
      try {
        const normalized = normalizeOosTrendRequest(req.query, { timezone: req.tenantRoute?.timezone });
        if (!normalized.ok) return res.status(normalized.status).json(normalized.body);

        const conn = req.brandDb?.sequelize;
        if (!conn) return res.status(500).json({ error: 'Brand DB connection unavailable' });

        return res.json(
          await inventoryOosService.getOosTrend({
            ...normalized.spec,
            conn,
            brandKey: req.brandKey,
            resolveShopSubdomain,
          }),
        );
      } catch (e) {
        return handleControllerError(res, e, 'oos-trend failed');
      }
    },

    productConversion: async (req, res) => {
      try {
        const normalized = productConversionService.normalizeProductConversionRequest(req.query, {
          timezone: req.tenantRoute?.timezone,
        });
        if (!normalized.ok) return res.status(normalized.status).json(normalized.body);
        
        const spec = normalized.spec;
        
        // --- Security Filtering: Granular Column Access ---
        if (!req.user.isAuthor) {
          const userPermissions = req.user.permissions || [];
          const hasInventoryPanel = userPermissions.includes('inventory_panel');
          const permittedColumns = userPermissions
            .filter(p => p.startsWith('product_conversion:'))
            .map(p => p.split(':')[1]);

          if (hasInventoryPanel) {
            permittedColumns.push('orders', 'drr', 'doh');
          }
          
          // landing_page_path is always public for anyone with product_conversion scope
          permittedColumns.push('landing_page_path');

          if (spec.visibleColumns) {
            spec.visibleColumns = spec.visibleColumns.filter(c => permittedColumns.includes(c));
          } else {
            // Default to only permitted columns if none specified
            spec.visibleColumns = permittedColumns;
          }
        }

        const conn = req.brandDb?.sequelize;
        if (!conn) return res.status(500).json({ error: 'Brand DB connection unavailable' });
        
        return res.json(
          await productConversionService.getProductConversion({ 
            ...spec, 
            conn,
            resolveShopSubdomain
          }),
        );
      } catch (e) {
        return handleControllerError(res, e, 'product-conversion failed');
      }
    },

    productConversionCsv: async (req, res) => {
      try {
        const normalized = productConversionService.normalizeProductConversionRequest(req.query, {
          timezone: req.tenantRoute?.timezone,
        });
        if (!normalized.ok) return res.status(normalized.status).json(normalized.body);
        
        const spec = normalized.spec;

        // --- Security Filtering: Granular Column Access ---
        if (!req.user.isAuthor) {
          const userPermissions = req.user.permissions || [];
          const hasInventoryPanel = userPermissions.includes('inventory_panel');
          const permittedColumns = userPermissions
            .filter(p => p.startsWith('product_conversion:'))
            .map(p => p.split(':')[1]);

          if (hasInventoryPanel) {
            permittedColumns.push('orders', 'drr', 'doh');
          }
          
          permittedColumns.push('landing_page_path');

          if (spec.visibleColumns) {
            spec.visibleColumns = spec.visibleColumns.filter(c => permittedColumns.includes(c));
          } else {
            spec.visibleColumns = permittedColumns;
          }
        }

        const conn = req.brandDb?.sequelize;
        if (!conn) return res.status(500).json({ error: 'Brand DB connection unavailable' });
        
        const exportResult = await productConversionService.getProductConversionCsv({
          ...spec,
          conn,
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
        return res.send(exportResult.csv);
      } catch (e) {
        return handleControllerError(res, e, 'product-conversion-csv failed');
      }
    },
  };
}

module.exports = { buildProductConversionController };
