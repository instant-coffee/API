import { Controller, Get } from "@nestjs/common";
import { OdooService } from "../odoo/odoo.service";

/**
 * Debug endpoints — read-only discovery tools.
 * Remove or guard behind an env flag before any public deployment.
 */
@Controller("debug")
export class DebugController {
  constructor(private readonly odoo: OdooService) {}

  /**
   * GET /api/v1/debug/pricelists
   * Returns all active pricelists with their IDs, currencies, and company assignments.
   * Use this to populate the correct IDs in src/config/site-context.ts.
   */
  @Get("pricelists")
  async getPricelists() {
    // Note: discount_policy was removed in Odoo 19
    const pricelists = await this.odoo.searchRead(
      "product.pricelist",
      [["active", "=", true]],
      ["id", "name", "currency_id", "company_id"],
    );

    return {
      count: pricelists.length,
      pricelists: pricelists.map((p: any) => ({
        id: p.id,
        name: p.name,
        currency: p.currency_id?.[1] ?? "unknown",
        currencyId: p.currency_id?.[0] ?? null,
        company: p.company_id?.[1] ?? "All companies (shared)",
        companyId: p.company_id?.[0] ?? null,
      })),
    };
  }

  /**
   * GET /api/v1/debug/companies
   * Returns all companies configured in Odoo.
   */
  @Get("companies")
  async getCompanies() {
    const companies = await this.odoo.searchRead(
      "res.company",
      [],
      ["id", "name", "currency_id", "country_id"],
    );

    return {
      count: companies.length,
      companies: companies.map((c: any) => ({
        id: c.id,
        name: c.name,
        currency: c.currency_id?.[1] ?? "unknown",
        country: c.country_id?.[1] ?? "unknown",
      })),
    };
  }

  /**
   * GET /api/v1/debug/websites
   * Returns Odoo Website records if the Website module is installed.
   * Each website record ties a domain → company → pricelist together natively.
   */
  @Get("websites")
  async getWebsites() {
    try {
      // pricelist_id was removed from the website model in Odoo 19 —
      // pricelist is now resolved via the visitor's country/currency context
      const websites = await this.odoo.searchRead(
        "website",
        [],
        ["id", "name", "domain", "company_id"],
      );

      return {
        count: websites.length,
        websites: websites.map((w: any) => ({
          id: w.id,
          name: w.name,
          domain: w.domain || "(not set)",
          company: w.company_id?.[1] ?? "unknown",
          companyId: w.company_id?.[0] ?? null,
        })),
      };
    } catch (err: any) {
      return {
        error: err.message,
        note: "The website model may not be accessible via JSON-RPC — check Odoo module installation.",
      };
    }
  }
}
