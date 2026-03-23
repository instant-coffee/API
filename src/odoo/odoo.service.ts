import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import {
  OdooJsonRpcResponse,
  OdooAuthResult,
  OdooSession,
} from "./types/odoo.types";

// ─────────────────────────────────────────────────────────────────────────────
// OdooService — core JSON-RPC client
//
// Wraps all communication with Odoo behind three primitives:
//   authenticate()           → establish & cache a session
//   searchRead(...)          → model search_read shorthand
//   callKw(...)              → arbitrary model method call
//
// Session is cached in memory and re-authenticated when it expires or on any
// 401 / session-expired error from Odoo.
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class OdooService implements OnModuleInit {
  private readonly logger = new Logger(OdooService.name);

  private readonly baseUrl: string;
  private readonly db: string;
  private readonly login: string;
  private readonly password: string;

  private session: OdooSession | null = null;
  private _requestId = 1;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService
  ) {
    this.baseUrl = this.config.getOrThrow<string>("odoo.baseUrl");
    this.db = this.config.getOrThrow<string>("odoo.db");
    this.login = this.config.getOrThrow<string>("odoo.login");
    this.password = this.config.getOrThrow<string>("odoo.password");
  }

  async onModuleInit() {
    // Eagerly authenticate so the first real request is fast.
    try {
      await this.authenticate();
      this.logger.log(
        `Connected to Odoo at ${this.baseUrl} (uid: ${this.session?.uid}, cookie: ${this.session?.sessionId ? "✓" : "✗"})`
      );
    } catch (err) {
      this.logger.error("Failed to authenticate with Odoo on startup", err);
      // Non-fatal at startup — will retry on first request.
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Authenticate against Odoo and cache the session.
   * Called automatically by onModuleInit and when a session expires.
   *
   * Important: we make the HTTP call directly here (not via _rpc) so we can
   * capture the Set-Cookie response header. Odoo's real session token lives
   * there — the session_id in the JSON body is the same value, but using the
   * cookie header is more reliable across Odoo SH / SaaS configurations.
   */
  async authenticate(): Promise<OdooSession> {
    const url = `${this.baseUrl}/web/session/authenticate`;

    let httpResponse: any;
    try {
      httpResponse = await firstValueFrom(
        this.http.post(
          url,
          {
            jsonrpc: "2.0",
            method: "call",
            id: this._requestId++,
            params: { db: this.db, login: this.login, password: this.password },
          },
          { headers: { "Content-Type": "application/json" } }
        )
      );
    } catch (err: any) {
      throw new InternalServerErrorException(
        `Odoo auth HTTP error: ${err.message}`
      );
    }

    const body: OdooJsonRpcResponse<OdooAuthResult> = httpResponse.data;

    if (body.error) {
      const msg = body.error.data?.message ?? body.error.message;
      throw new InternalServerErrorException(`Odoo auth failed: ${msg}`);
    }

    const result = body.result;
    if (!result?.uid) {
      throw new InternalServerErrorException(
        "Odoo authentication failed — check ODOO_ADMIN_LOGIN/PASSWORD"
      );
    }

    // ── Extract session cookie from Set-Cookie header ─────────────────────
    // Odoo sets:  session_id=<value>; Path=/; HttpOnly; SameSite=Lax
    // We store the raw "session_id=<value>" string and replay it as a
    // Cookie header on every subsequent request.
    let sessionCookie = "";
    const setCookieHeader = httpResponse.headers["set-cookie"] as
      | string[]
      | string
      | undefined;

    if (setCookieHeader) {
      const cookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : [setCookieHeader];
      const found = cookies.find((c) => c.startsWith("session_id="));
      if (found) {
        sessionCookie = found.split(";")[0]; // "session_id=xxxx"
      }
    }

    // Fall back to the value in the JSON body if the header wasn't present
    if (!sessionCookie && result.session_id) {
      sessionCookie = `session_id=${result.session_id}`;
    }

    this.logger.debug(
      `Session cookie captured: ${sessionCookie ? "✓" : "✗ (none found)"}`
    );

    this.session = {
      uid: result.uid,
      sessionId: sessionCookie, // full "session_id=xxx" string, ready to use as Cookie header
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000), // 8 h
    };

    return this.session;
  }

  /**
   * Shorthand for model.search_read().
   *
   * @param model   Odoo model name, e.g. 'product.template'
   * @param domain  Odoo domain filter, e.g. [['active', '=', true]]
   * @param fields  Field names to return
   * @param opts    Optional limit, offset, order
   */
  async searchRead<T = any>(
    model: string,
    domain: any[][],
    fields: string[],
    opts: { limit?: number; offset?: number; order?: string } = {}
  ): Promise<T[]> {
    return this.callKw<T[]>(model, "search_read", [domain], {
      fields,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
      order: opts.order,
    });
  }

  /**
   * Generic model method call — equivalent to Odoo's call_kw endpoint.
   *
   * @param model   Odoo model name
   * @param method  Method name, e.g. 'search_read', 'create', 'write'
   * @param args    Positional arguments (array)
   * @param kwargs  Keyword arguments (object)
   */
  async callKw<T = any>(
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {}
  ): Promise<T> {
    await this._ensureSession();

    return this._rpc<T>("/web/dataset/call_kw", {
      model,
      method,
      args,
      kwargs: {
        context: { lang: "en_US", tz: "America/Vancouver" },
        ...kwargs,
      },
    });
  }

  /**
   * Get pricelist-adjusted prices for product variants.
   *
   * Uses product.pricelist.get_products_price() — the canonical Odoo API.
   * This correctly handles:
   *   - Products priced in USD with a CAD pricelist rule (returns CAD price)
   *   - Fixed-price pricelist rules (e.g. "CAD Retail 2026: $2,069")
   *   - Percentage-off rules
   *
   * Odoo 19 signature: get_products_price(products, quantities, partners)
   *   args: [[pricelistId], variantIds, [qty, qty...], [false, false...]]
   *   returns: { product_id: price_in_pricelist_currency }
   *
   * Returns {} on any failure so callers safely fall back to lst_price.
   *
   * @param pricelistId  Odoo pricelist ID
   * @param variantIds   Array of product.product IDs
   * @param quantity     Quantity (default 1 — affects tiered pricelist rules)
   */
  async getPricelistPrices(
    pricelistId: number,
    variantIds: number[],
    quantity = 1,
  ): Promise<Record<number, number>> {
    if (!variantIds?.length) return {};

    try {
      // Odoo 17: get_products_price(self, products, quantities, partners)
      // self   → [pricelistId]  (first positional arg = record IDs for the recordset)
      // products  → variantIds  (list of product.product IDs)
      // quantities → [qty, qty, ...] one per product
      // partners  → [false, false, ...] no partner filtering
      const quantities = Array(variantIds.length).fill(quantity);
      const partners = Array(variantIds.length).fill(false);

      const priceMap = await this.callKw<Record<string, number>>(
        "product.pricelist",
        "get_products_price",
        [[pricelistId], variantIds, quantities, partners]
      );

      // Odoo returns string keys — normalise to number keys
      const result: Record<number, number> = {};
      for (const [k, v] of Object.entries(priceMap)) {
        if (typeof v === "number") result[Number(k)] = v;
      }

      this.logger.debug(
        `Pricelist ${pricelistId} → ${Object.keys(result).length} prices via get_products_price`,
      );

      return result;
    } catch (err: any) {
      this.logger.warn(
        `getPricelistPrices (get_products_price) failed — falling back to lst_price: ${err?.message}`,
      );
      return {};
    }
  }

  // ─── Session helpers ───────────────────────────────────────────────────────

  private async _ensureSession(): Promise<void> {
    if (!this.session || new Date() >= this.session.expiresAt) {
      this.logger.log("Session expired or missing — re-authenticating");
      await this.authenticate();
    }
  }

  // ─── Low-level JSON-RPC ────────────────────────────────────────────────────

  private async _rpc<T>(
    endpoint: string,
    params: Record<string, any>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const id = this._requestId++;

    // DEBUG — log every outbound Odoo RPC call (model + method + args summary).
    // Only visible when LOG_LEVEL=debug. Safe to leave on in development.
    const model = params.model ?? "—";
    const method = params.method ?? "—";
    const argsPreview = JSON.stringify(params.args ?? []).slice(0, 200);
    this.logger.debug(
      `→ Odoo RPC #${id} ${model}.${method}() args=${argsPreview}`
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Pass session cookie for authenticated calls.
    // sessionId already contains the full "session_id=xxx" string.
    if (this.session?.sessionId) {
      headers["Cookie"] = this.session.sessionId;
    }

    let body: OdooJsonRpcResponse<T>;

    try {
      const response = await firstValueFrom(
        this.http.post<OdooJsonRpcResponse<T>>(
          url,
          { jsonrpc: "2.0", method: "call", id, params },
          { headers }
        )
      );
      body = response.data;
    } catch (err: any) {
      this.logger.error(`HTTP error calling Odoo ${endpoint}: ${err.message}`);
      throw new InternalServerErrorException(
        `Odoo request failed: ${err.message}`
      );
    }

    this.logger.debug(`← Odoo RPC #${id} ${model}.${method}() OK`);

    if (body.error) {
      const msg = body.error.data?.message ?? body.error.message;
      this.logger.error(`Odoo JSON-RPC error on ${endpoint}: ${msg}`);

      // Session expired — clear and let caller retry
      if (body.error.code === 100 || msg?.includes("session")) {
        this.session = null;
      }

      throw new InternalServerErrorException(`Odoo error: ${msg}`);
    }

    return body.result as T;
  }
}
