// ─────────────────────────────────────────────────────────────────────────────
// Site Context — maps a site identifier to its brand, currency, and Odoo IDs.
//
// The Nuxt frontend sends a `x-site-context` header (or query param) on every
// API request. NestJS reads this and resolves the correct pricelist + currency.
//
// Site IDs correspond to what will be configured in Odoo → Website settings.
// Pricelist IDs will need to be confirmed against production Odoo.
// ─────────────────────────────────────────────────────────────────────────────

export type SiteId = 'nobl_ca' | 'nobl_us' | 'wb_ca' | 'wb_us';

export interface SiteContext {
  siteId:          SiteId;
  brand:           'nobl' | 'westernbike';
  currency:        'CAD' | 'USD';
  locale:          string;
  pricelistId:     number;   // Odoo product.pricelist ID — retail
  dealerPricelistId?: number; // Odoo product.pricelist ID — dealer tier
  odooWebsiteId?:  number;   // Odoo website ID (if multi-website is configured)
  domain:          string;   // canonical public domain
}

// ─── Site registry ────────────────────────────────────────────────────────────
// ⚠️  Pricelist IDs below are placeholders — confirm against your Odoo instance:
//     Settings → Sales → Pricelists (developer mode required)

export const SITE_CONTEXTS: Record<SiteId, SiteContext> = {
  nobl_ca: {
    siteId:           'nobl_ca',
    brand:            'nobl',
    currency:         'CAD',
    locale:           'en-CA',
    pricelistId:      1,     // TODO: confirm Odoo pricelist ID for NOBL CAD retail
    dealerPricelistId: 3,    // TODO: confirm Odoo pricelist ID for NOBL dealer CAD
    domain:           'shop.noblwheels.ca',
  },
  nobl_us: {
    siteId:           'nobl_us',
    brand:            'nobl',
    currency:         'USD',
    locale:           'en-US',
    pricelistId:      2,     // TODO: confirm Odoo pricelist ID for NOBL USD retail
    dealerPricelistId: 4,    // TODO: confirm Odoo pricelist ID for NOBL dealer USD
    domain:           'shop.noblwheels.com',
  },
  wb_ca: {
    siteId:           'wb_ca',
    brand:            'westernbike',
    currency:         'CAD',
    locale:           'en-CA',
    pricelistId:      1,     // TODO: may share CAD pricelist with NOBL or be separate
    dealerPricelistId: 3,
    domain:           'shop.westernbike.ca',
  },
  wb_us: {
    siteId:           'wb_us',
    brand:            'westernbike',
    currency:         'USD',
    locale:           'en-US',
    pricelistId:      2,     // TODO: may share USD pricelist with NOBL or be separate
    dealerPricelistId: 4,
    domain:           'shop.westernbike.com',
  },
};

export const DEFAULT_SITE: SiteId = 'nobl_ca';

/**
 * Resolve a SiteContext from the value of the x-site-context header.
 * Falls back to nobl_ca if the value is missing or unrecognised.
 */
export function resolveSiteContext(siteId?: string): SiteContext {
  if (siteId && siteId in SITE_CONTEXTS) {
    return SITE_CONTEXTS[siteId as SiteId];
  }
  return SITE_CONTEXTS[DEFAULT_SITE];
}
