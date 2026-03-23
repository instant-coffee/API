// ─────────────────────────────────────────────────────────────────────────────
// Site Context — maps a site identifier to its brand, currency, and Odoo IDs.
//
// The Nuxt frontend sends a `x-site-context` header (or query param) on every
// API request. NestJS reads this and resolves the correct pricelist + currency.
//
// Pricelist IDs confirmed against staging (2026-03-18):
//   GET /api/v1/debug/pricelists
//
// ─── Odoo Pricelist ID Reference ─────────────────────────────────────────────
//  ID  Name                           Currency  Company
//  85  CAD Retail 2026                CAD       WBC Ltd. (ID 2)
//  66  CAD Dealer Level 1 - Bronze    CAD       WBC Ltd. (ID 2)
//  67  CAD Dealer Level 2 - Silver    CAD       WBC Ltd. (ID 2)
//  68  CAD Dealer Level 3 - Gold      CAD       WBC Ltd. (ID 2)
//  69  CAD Dealer VIP                 CAD       WBC Ltd. (ID 2)
//  58  USD                            USD       WBC USA Inc. (ID 1)
//  59  USD Dealer 1                   USD       WBC USA Inc. (ID 1)
//  60  USD Dealer 2                   USD       WBC USA Inc. (ID 1)
//  61  USD Dealer 3                   USD       WBC USA Inc. (ID 1)
//  70  USD Dealer 3 [DUPLICATE — tbc] USD       WBC USA Inc. (ID 1)
//  87  [TEST] Bundle 40% Off          CAD       WBC Ltd. (ID 2)   ← test only
//
// ⚠️  No "USD VIP" pricelist exists yet — create in Odoo before going live.
// ⚠️  Pricelist ID 70 (USD Dealer 3) appears to be a duplicate of 61 — confirm
//     which is active and archive the other.
//
// ─── Odoo Website ID Reference ────────────────────────────────────────────────
//  ID  Name                  Company             Domain
//  1   NOBL Wheels           WBC USA Inc. (ID 1) (not set — needs configuration)
//  2   NOBL Wheels Canada    WBC Ltd. (ID 2)     (not set — needs configuration)
//  3   Western Bike Co.      WBC Ltd. (ID 2)     (not set — needs configuration)
//  Note: No "Western Bike USA" website record exists yet.
// ─────────────────────────────────────────────────────────────────────────────

export type SiteId = "nobl_ca" | "nobl_us" | "wb_ca" | "wb_us";

export interface SiteContext {
  siteId: SiteId;
  brand: "nobl" | "westernbike";
  currency: "CAD" | "USD";
  currencyId: number; // Odoo res.currency ID
  locale: string;
  companyId: number; // Odoo res.company ID
  pricelistId: number; // Odoo product.pricelist ID — retail (unauthenticated)
  odooWebsiteId: number; // Odoo website ID
  domain: string; // canonical public domain
}

// ─── Site registry ─────────────────────────────────────────────────────────────

export const SITE_CONTEXTS: Record<SiteId, SiteContext> = {
  nobl_ca: {
    siteId: "nobl_ca",
    brand: "nobl",
    currency: "CAD",
    currencyId: 3,
    locale: "en-CA",
    companyId: 2, // WBC Ltd.
    pricelistId: 85, // CAD Retail 2026
    odooWebsiteId: 2, // NOBL Wheels Canada
    domain: "shop.noblwheels.ca",
  },
  nobl_us: {
    siteId: "nobl_us",
    brand: "nobl",
    currency: "USD",
    currencyId: 1,
    locale: "en-US",
    companyId: 1, // WBC USA Inc.
    pricelistId: 58, // USD (retail)
    odooWebsiteId: 1, // NOBL Wheels
    domain: "shop.noblwheels.com",
  },
  wb_ca: {
    siteId: "wb_ca",
    brand: "westernbike",
    currency: "CAD",
    currencyId: 3,
    locale: "en-CA",
    companyId: 2, // WBC Ltd.
    pricelistId: 85, // CAD Retail 2026 (shared with nobl_ca)
    odooWebsiteId: 3, // Western Bike Co.
    domain: "shop.westernbike.ca",
  },
  wb_us: {
    siteId: "wb_us",
    brand: "westernbike",
    currency: "USD",
    currencyId: 1,
    locale: "en-US",
    companyId: 1, // WBC USA Inc.
    pricelistId: 58, // USD (retail) — shared with nobl_us
    odooWebsiteId: 0, // ⚠️ No "Western Bike USA" website record yet — needs creating
    domain: "shop.westernbike.com",
  },
};

export const DEFAULT_SITE: SiteId = "nobl_ca";

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
