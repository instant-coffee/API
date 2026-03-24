import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { OdooJsonV2Error } from "./types/odoo.types";

// ─────────────────────────────────────────────────────────────────────────────
// OdooService — JSON API v2 client
//
// Uses Odoo's modern /json/2/<model>/<method> REST API with bearer-token auth.
// No session management needed — the API key is sent on every request.
//
// Endpoint pattern:  POST /json/2/<model>/<method>
// Required headers:  Authorization: bearer <key>
//                    X-Odoo-Database: <db>
//
// Body shapes per method:
//   search_read  → { domain, fields, limit, offset, order, context }
//   read         → { ids, fields, context }
//   create       → { values, context }
//   write        → { ids, values, context }
//   unlink       → { ids, context }
//   (other)      → kwargs passed through as-is
//
// Response: the result value directly (not wrapped in jsonrpc envelope).
// Errors:   HTTP 4xx/5xx with { error: { message, data } } body.
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class OdooService implements OnModuleInit {
  private readonly logger = new Logger(OdooService.name);

  private readonly baseUrl: string;
  private readonly db: string;
  private readonly authHeader: string; // full "bearer <key>" string

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.getOrThrow<string>("odoo.baseUrl");
    this.db = this.config.getOrThrow<string>("odoo.db");
    // ODOO_API_KEY may be stored as "bearer <key>" or just "<key>".
    // Normalise so we always send "bearer <key>".
    const raw = this.config.getOrThrow<string>("odoo.apiKey");
    this.authHeader = raw.startsWith("bearer ") ? raw : `bearer ${raw}`;
  }

  async onModuleInit() {
    // Smoke-test the connection by reading the current user record.
    try {
      const result = await this.searchRead<{ id: number; name: string }>(
        "res.users",
        [["id", "=", 1]],
        ["id", "name"],
        { limit: 1 },
      );
      const user = result[0];
      this.logger.log(
        `Connected to Odoo at ${this.baseUrl} (user: ${user?.name ?? "unknown"}, id: ${user?.id ?? "?"})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to connect to Odoo on startup: ${err?.message}`,
      );
      // Non-fatal — will surface on first real request.
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Shorthand for model.search_read().
   */
  async searchRead<T = any>(
    model: string,
    domain: any[][],
    fields: string[],
    opts: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<T[]> {
    return this._jsonApi<T[]>(model, "search_read", {
      domain,
      fields,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
      ...(opts.order ? { order: opts.order } : {}),
    });
  }

  /**
   * Generic model method call — mirrors the old call_kw interface so callers
   * don't need to change, but translates args/kwargs to the JSON API v2 body
   * shape expected by each standard method.
   *
   * Method body translations:
   *   create      args[0] = vals dict              → { values: vals }
   *   write       args[0] = [ids], args[1] = vals  → { ids, values: vals }
   *   read        args[0] = [ids]                  → { ids, fields }
   *   unlink      args[0] = [ids]                  → { ids }
   *   search_read args[0] = [domain]               → { domain, ...kwargs }
   *   (other)     kwargs passed through directly
   */
  async callKw<T = any>(
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {},
  ): Promise<T> {
    const context = { lang: "en_US", tz: "America/Vancouver" };

    let body: Record<string, any>;

    switch (method) {
      case "create":
        body = { values: args[0], context };
        break;

      case "write":
        body = { ids: args[0], values: args[1], context };
        break;

      case "read":
        body = { ids: args[0], fields: kwargs.fields ?? [], context };
        break;

      case "unlink":
        body = { ids: args[0], context };
        break;

      case "search_read": {
        const { fields, limit, offset, order, ...rest } = kwargs;
        body = {
          domain: args[0] ?? [],
          fields: fields ?? [],
          limit: limit ?? 100,
          offset: offset ?? 0,
          ...(order ? { order } : {}),
          ...rest,
          context,
        };
        break;
      }

      default:
        // Arbitrary method — pass kwargs directly. args are not forwarded
        // since the v2 API is kwargs-only. If a method genuinely needs
        // positional args, the caller should use _jsonApi directly.
        body = { ...kwargs, context };
        break;
    }

    return this._jsonApi<T>(model, method, body);
  }

  /**
   * Get pricelist-adjusted prices for product variants.
   *
   * Reads product.pricelist.item records for the pricelist and matches them
   * to our variants by template or variant ID. Returns fixed_price in the
   * pricelist's currency (e.g. CAD $2,069) or computes percentage-off prices.
   *
   * NOTE on Odoo 18/19: The `price` computed field on product.product and
   * `product.pricelist.get_products_price()` were both removed. Reading
   * pricelist items directly is the only reliable external API approach.
   */
  async getPricelistPrices(
    pricelistId: number,
    variantIds: number[],
    quantity = 1,
  ): Promise<Record<number, number>> {
    if (!variantIds?.length) return {};

    try {
      const variantMeta = await this.searchRead<{
        id: number;
        product_tmpl_id: [number, string];
        lst_price: number;
        price_extra: number;
      }>(
        "product.product",
        [["id", "in", variantIds]],
        ["id", "product_tmpl_id", "lst_price", "price_extra"],
      );

      const templateIds = [
        ...new Set(variantMeta.map((v) => v.product_tmpl_id[0])),
      ];

      const items = await this.searchRead<{
        product_id: [number, string] | false;
        product_tmpl_id: [number, string] | false;
        applied_on: string;
        compute_price: string;
        fixed_price: number;
        percent_price: number;
      }>(
        "product.pricelist.item",
        [
          ["pricelist_id", "=", pricelistId],
          "|",
          ["product_id", "in", variantIds],
          ["product_tmpl_id", "in", templateIds],
        ] as any[],
        [
          "product_id",
          "product_tmpl_id",
          "applied_on",
          "compute_price",
          "fixed_price",
          "percent_price",
        ],
      );

      const priceMap: Record<number, number> = {};
      for (const v of variantMeta) {
        const tmplId = v.product_tmpl_id[0];

        const rule =
          items.find(
            (i) =>
              i.applied_on === "0_product_variant" &&
              !!i.product_id &&
              (i.product_id as [number, string])[0] === v.id,
          ) ??
          items.find(
            (i) =>
              i.applied_on === "1_product" &&
              !!i.product_tmpl_id &&
              (i.product_tmpl_id as [number, string])[0] === tmplId,
          );

        if (!rule) continue;

        if (rule.compute_price === "fixed") {
          priceMap[v.id] = rule.fixed_price;
        } else if (rule.compute_price === "percentage") {
          const base = v.lst_price + (v.price_extra ?? 0);
          priceMap[v.id] = base * (1 - rule.percent_price / 100);
        }
      }

      const resolvedCount = Object.keys(priceMap).length;
      if (resolvedCount === 0) {
        this.logger.debug(
          `Pricelist ${pricelistId} → no items found (USD native pricing or rules not yet configured)`,
        );
      } else {
        this.logger.debug(
          `Pricelist ${pricelistId} → ${resolvedCount}/${variantIds.length} prices via pricelist.item`,
        );
      }
      return priceMap;
    } catch (err: any) {
      this.logger.warn(
        `pricelist.item lookup failed: ${err?.message} — callers will use lst_price`,
      );
    }

    return {};
  }

  // ─── Low-level JSON API v2 ─────────────────────────────────────────────────

  private async _jsonApi<T>(
    model: string,
    method: string,
    body: Record<string, any>,
  ): Promise<T> {
    const url = `${this.baseUrl}/json/2/${model}/${method}`;

    this.logger.debug(
      `→ Odoo /json/2/ ${model}.${method}() body=${JSON.stringify(body).slice(0, 200)}`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": this.authHeader,
      "X-Odoo-Database": this.db,
    };

    let responseData: any;

    try {
      const response = await firstValueFrom(
        this.http.post<any>(url, body, { headers }),
      );
      responseData = response.data;
    } catch (err: any) {
      // Axios throws on 4xx/5xx — extract Odoo error message if present
      const odooError: OdooJsonV2Error | undefined =
        err?.response?.data?.error;
      const msg =
        odooError?.data?.message ??
        odooError?.message ??
        err.message;
      this.logger.error(`Odoo API error ${model}.${method}: ${msg}`);
      throw new InternalServerErrorException(`Odoo error: ${msg}`);
    }

    // The v2 API returns the result directly (not wrapped in a jsonrpc envelope).
    // Guard against unexpected error objects in a 200 body (shouldn't happen,
    // but be defensive).
    if (
      responseData !== null &&
      typeof responseData === "object" &&
      "error" in responseData &&
      !Array.isArray(responseData)
    ) {
      const odooError = responseData.error as OdooJsonV2Error;
      const msg = odooError?.data?.message ?? odooError?.message ?? "Unknown Odoo error";
      this.logger.error(`Odoo API logical error ${model}.${method}: ${msg}`);
      throw new InternalServerErrorException(`Odoo error: ${msg}`);
    }

    this.logger.debug(`← Odoo /json/2/ ${model}.${method}() OK`);
    return responseData as T;
  }
}
