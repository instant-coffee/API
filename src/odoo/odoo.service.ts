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

  private readonly baseUrl: string;
  private readonly db: string;
  private readonly login: string;
  private readonly password: string;

  private session: OdooSession | null = null;
  private _requestId = 1;

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
      this.logger.log(`Connected to Odoo at ${this.baseUrl} (uid: ${this.session?.uid})`);
    } catch (err) {
      this.logger.error('Failed to authenticate with Odoo on startup', err);
      // Non-fatal at startup — will retry on first request.
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Authenticate against Odoo and cache the session.
   * Called automatically by onModuleInit and when a session expires.
   */
  async authenticate(): Promise<OdooSession> {
    const response = await this._rpc<OdooAuthResult>(
      '/web/session/authenticate',
      { db: this.db, login: this.login, password: this.password },
    );

    if (!response.uid) {
      throw new InternalServerErrorException('Odoo authentication failed — check ODOO_ADMIN_LOGIN/PASSWORD');
    }

    this.session = {
      uid:       response.uid,
      sessionId: response.session_id,
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
   * Get pricelist-adjusted prices for a set of product variants.
   * Uses product.pricelist.get_products_price() — returns { variantId: price }
   *
   * @param pricelistId  Odoo pricelist ID
   * @param variantIds   Array of product.product IDs
   * @param quantity     Quantity (default 1)
   */
  async getPricelistPrices(
    pricelistId: number,
    variantIds: number[],
    quantity = 1,
  ): Promise<Record<number, number>> {
    return this.callKw<Record<number, number>>(
      'product.pricelist',
      'get_products_price',
      [pricelistId, variantIds, Array(variantIds.length).fill(quantity)],
    );
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

    // Pass session cookie for authenticated calls
    if (this.session?.sessionId) {
      headers['Cookie'] = `session_id=${this.session.sessionId}`;
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
