import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  OdooJsonRpcResponse,
  OdooAuthResult,
  OdooSession,
} from './types/odoo.types';

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

  /**
   * Ordered list of pricelist RPC method names to probe.
   *
   * Why this exists:
   * - Different Odoo versions/custom modules may expose different helpers.
   * - We prefer a deterministic order so behavior is stable across requests.
   *
   * Current strategy order:
   * 1) `get_products_price`  → common in many installations
   * 2) `_get_products_price` → alternative/private-style helper seen in some setups
   */
  private static readonly PRICELIST_METHOD_CANDIDATES = [
    'get_products_price',
    '_get_products_price',
  ] as const;

  private readonly baseUrl: string;
  private readonly db: string;
  private readonly login: string;
  private readonly password: string;

  private session: OdooSession | null = null;
  private _requestId = 1;

  /**
   * Memoized pricelist method decision.
   *
   * - `null`:  not probed yet in this process, so we should probe candidates.
   * - method: one candidate succeeded earlier; reuse it first for speed.
   * - `none`: all candidates failed; skip probing and return fallback immediately.
   */
  private _resolvedPricelistMethod:
    | (typeof OdooService.PRICELIST_METHOD_CANDIDATES)[number]
    | 'none'
    | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl  = this.config.getOrThrow<string>('odoo.baseUrl');
    this.db       = this.config.getOrThrow<string>('odoo.db');
    this.login    = this.config.getOrThrow<string>('odoo.login');
    this.password = this.config.getOrThrow<string>('odoo.password');
  }

  async onModuleInit() {
    // Eagerly authenticate so the first real request is fast.
    try {
      await this.authenticate();
      this.logger.log(`Connected to Odoo at ${this.baseUrl} (uid: ${this.session?.uid}, cookie: ${this.session?.sessionId ? '✓' : '✗'})`);
    } catch (err) {
      this.logger.error('Failed to authenticate with Odoo on startup', err);
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
            jsonrpc: '2.0',
            method:  'call',
            id:      this._requestId++,
            params:  { db: this.db, login: this.login, password: this.password },
          },
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    } catch (err: any) {
      throw new InternalServerErrorException(`Odoo auth HTTP error: ${err.message}`);
    }

    const body: OdooJsonRpcResponse<OdooAuthResult> = httpResponse.data;

    if (body.error) {
      const msg = body.error.data?.message ?? body.error.message;
      throw new InternalServerErrorException(`Odoo auth failed: ${msg}`);
    }

    const result = body.result;
    if (!result?.uid) {
      throw new InternalServerErrorException('Odoo authentication failed — check ODOO_ADMIN_LOGIN/PASSWORD');
    }

    // ── Extract session cookie from Set-Cookie header ─────────────────────
    // Odoo sets:  session_id=<value>; Path=/; HttpOnly; SameSite=Lax
    // We store the raw "session_id=<value>" string and replay it as a
    // Cookie header on every subsequent request.
    let sessionCookie = '';
    const setCookieHeader = httpResponse.headers['set-cookie'] as string[] | string | undefined;

    if (setCookieHeader) {
      const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      const found   = cookies.find((c) => c.startsWith('session_id='));
      if (found) {
        sessionCookie = found.split(';')[0]; // "session_id=xxxx"
      }
    }

    // Fall back to the value in the JSON body if the header wasn't present
    if (!sessionCookie && result.session_id) {
      sessionCookie = `session_id=${result.session_id}`;
    }

    this.logger.debug(`Session cookie captured: ${sessionCookie ? '✓' : '✗ (none found)'}`);

    this.session = {
      uid:       result.uid,
      sessionId: sessionCookie,   // full "session_id=xxx" string, ready to use as Cookie header
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
    opts: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<T[]> {
    return this.callKw<T[]>(model, 'search_read', [domain], {
      fields,
      limit:  opts.limit  ?? 100,
      offset: opts.offset ?? 0,
      order:  opts.order,
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
    kwargs: Record<string, any> = {},
  ): Promise<T> {
    await this._ensureSession();

    return this._rpc<T>('/web/dataset/call_kw', {
      model,
      method,
      args,
      kwargs: {
        context: { lang: 'en_US', tz: 'America/Vancouver' },
        ...kwargs,
      },
    });
  }

  /**
   * Get pricelist-adjusted prices for product variants with cross-version fallback.
   *
   * Behavior:
   * - Tries known pricelist RPC helpers in a deterministic order.
   * - Normalizes heterogeneous Odoo return shapes into `{ [variantId]: price }`.
   * - Caches the first successful method for future calls (process-local memoization).
   * - If all candidates fail, returns `{}` so callers can safely fall back to
   *   product `lst_price` without failing the request.
   *
   * Performance notes:
   * - The probing phase happens at most once per process until a method is found
   *   (or we determine no candidate exists).
   * - After that, only the resolved method is attempted.
   *
   * @param pricelistId  Odoo pricelist ID
   * @param variantIds   Array of product.product IDs
   * @param quantity     Quantity (default 1)
   * @returns Record keyed by variant ID, with numeric final prices.
   */
  async getPricelistPrices(
    pricelistId: number,
    variantIds: number[],
    quantity = 1,
  ): Promise<Record<number, number>> {
    this.logger.debug(
      `Getting pricelist prices for variants [${variantIds.join(', ')}] with pricelist ${pricelistId}`,
    );

    if (!variantIds?.length) return {};

    if (this._resolvedPricelistMethod === 'none') {
      return {};
    }

    const quantities = Array(variantIds.length).fill(quantity);

    const methodsToTry = this._resolvedPricelistMethod
      ? [this._resolvedPricelistMethod]
      : [...OdooService.PRICELIST_METHOD_CANDIDATES];

    for (const methodName of methodsToTry) {
      const response = await this._tryGetPricelistPricesByMethod(
        methodName,
        pricelistId,
        variantIds,
        quantities,
      );

      if (response) {
        this._resolvedPricelistMethod = methodName;
        return response;
      }
    }

    this._resolvedPricelistMethod = 'none';
    this.logger.warn(
      'No compatible pricelist RPC method found. Falling back to product list prices.',
    );
    return {};
  }

  /**
   * Attempt one specific Odoo pricelist method and normalize its output.
   *
   * Input contract we send:
   * - args: `[pricelistId, variantIds, quantities]`
   *
   * Normalization contract we return:
   * - `{ [variantId]: number }`
   *
   * If the method does not exist or returns an unsupported shape, we return
   * `null` so caller can try the next candidate.
   */
  private async _tryGetPricelistPricesByMethod(
    methodName: (typeof OdooService.PRICELIST_METHOD_CANDIDATES)[number],
    pricelistId: number,
    variantIds: number[],
    quantities: number[],
  ): Promise<Record<number, number> | null> {
    try {
      const rawResult = await this.callKw<any>(
        'product.pricelist',
        methodName,
        [pricelistId, variantIds, quantities],
      );

      const normalized = this._normalizePricelistResult(rawResult, pricelistId);

      this.logger.debug(`Using pricelist RPC method: product.pricelist.${methodName}`);
      return normalized;
    } catch (err: any) {
      this.logger.warn(
        `Pricelist method product.pricelist.${methodName} unavailable/failed: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Normalize various Odoo pricelist response shapes into a strict number map.
   *
   * Known shapes observed in Odoo/custom deployments:
   * - `{ "81368": 1080, "81369": 1080 }`
   * - `{ "81368": { "1": 1080 }, "81369": { "1": 1080 } }`
   *   where nested key may be the pricelist id as string.
   *
   * Unsupported or malformed values are ignored rather than throwing, to keep
   * pricing resilient and allow caller-level fallback to `lst_price`.
   */
  private _normalizePricelistResult(
    result: unknown,
    pricelistId: number,
  ): Record<number, number> {
    const normalized: Record<number, number> = {};

    if (!result || typeof result !== 'object') {
      return normalized;
    }

    const root = result as Record<string, unknown>;
    const pricelistKey = String(pricelistId);

    for (const [rawProductId, rawValue] of Object.entries(root)) {
      const productId = Number(rawProductId);
      if (!Number.isFinite(productId)) continue;

      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        normalized[productId] = rawValue;
        continue;
      }

      if (rawValue && typeof rawValue === 'object') {
        const nested = rawValue as Record<string, unknown>;
        const nestedValue = nested[pricelistKey];
        if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) {
          normalized[productId] = nestedValue;
        }
      }
    }

    return normalized;
  }

  // ─── Session helpers ───────────────────────────────────────────────────────

  private async _ensureSession(): Promise<void> {
    if (!this.session || new Date() >= this.session.expiresAt) {
      this.logger.log('Session expired or missing — re-authenticating');
      await this.authenticate();
    }
  }

  // ─── Low-level JSON-RPC ────────────────────────────────────────────────────

  private async _rpc<T>(endpoint: string, params: Record<string, any>): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const id  = this._requestId++;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Pass session cookie for authenticated calls.
    // sessionId already contains the full "session_id=xxx" string.
    if (this.session?.sessionId) {
      headers['Cookie'] = this.session.sessionId;
    }

    let body: OdooJsonRpcResponse<T>;

    try {
      const response = await firstValueFrom(
        this.http.post<OdooJsonRpcResponse<T>>(
          url,
          { jsonrpc: '2.0', method: 'call', id, params },
          { headers },
        ),
      );
      body = response.data;
    } catch (err: any) {
      this.logger.error(`HTTP error calling Odoo ${endpoint}: ${err.message}`);
      throw new InternalServerErrorException(`Odoo request failed: ${err.message}`);
    }

    if (body.error) {
      const msg = body.error.data?.message ?? body.error.message;
      this.logger.error(`Odoo JSON-RPC error on ${endpoint}: ${msg}`);

      // Session expired — clear and let caller retry
      if (body.error.code === 100 || msg?.includes('session')) {
        this.session = null;
      }

      throw new InternalServerErrorException(`Odoo error: ${msg}`);
    }

    return body.result as T;
  }
}
