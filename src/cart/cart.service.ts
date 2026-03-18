import { Injectable, Logger } from '@nestjs/common';
import { OdooService } from '../odoo/odoo.service';
import { SiteContext } from '../config/site-context';
import { CreateCartDto } from './dto/create-cart.dto';
import { OdooSaleOrder } from '../odoo/types/odoo.types';

// ─────────────────────────────────────────────────────────────────────────────
// CartService — creates sale.orders in Odoo
//
// This is the critical integration test for the POC:
// Does a sale.order land in Odoo correctly with no_variant attribute values
// populated on each order line? If yes, manufacturing can see Freehub/Brake
// selections without those choices creating inventory variants.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateOrderResult {
  orderId:   number;
  orderName: string;    // e.g. "S00042"
  total:     number;
  currency:  string;
}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(private readonly odoo: OdooService) {}

  async createOrder(
    dto: CreateCartDto,
    site: SiteContext,
    dealerPartnerId?: number,   // set if authenticated dealer
    dealerPricelistId?: number, // set from dealer JWT payload
  ): Promise<CreateOrderResult> {

    // ── 1. Resolve or create res.partner ─────────────────────────────────────
    const partnerId = dealerPartnerId ?? await this._resolveGuestPartner(dto);

    // ── 2. Build sale.order header ────────────────────────────────────────────
    const orderVals: Record<string, any> = {
      partner_id:    partnerId,
      // Dealers get their assigned pricelist from JWT; guests use site default.
      pricelist_id:  dealerPricelistId ?? site.pricelistId,
      // Note: website_id can be set here once multi-website is configured
    };

    const orderId = await this.odoo.callKw<number>(
      'sale.order',
      'create',
      [orderVals],
    );

    this.logger.log(`Created sale.order ${orderId} for site ${site.siteId}`);

    // ── 3. Create order lines ─────────────────────────────────────────────────
    for (const line of dto.lines) {
      const lineVals: Record<string, any> = {
        order_id:   orderId,
        product_id: line.variantId,
        product_uom_qty: line.quantity,
      };

      // ── The key no_variant integration ───────────────────────────────────
      // product_no_variant_attribute_value_ids uses Odoo's (6, 0, ids) command
      // to set a many2many field to exactly the given IDs.
      if (line.noVariantValueIds?.length) {
        lineVals['product_no_variant_attribute_value_ids'] = [
          [6, 0, line.noVariantValueIds],
        ];
      }

      await this.odoo.callKw<number>(
        'sale.order.line',
        'create',
        [lineVals],
      );

      this.logger.log(
        `Created order line: variant ${line.variantId}, ` +
        `no_variant attrs: [${line.noVariantValueIds?.join(', ') ?? 'none'}]`,
      );
    }

    // ── 4. Read back the created order for confirmation ───────────────────────
    const [order] = await this.odoo.searchRead<OdooSaleOrder>(
      'sale.order',
      [['id', '=', orderId]],
      ['id', 'name', 'amount_total', 'currency_id'],
    );

    return {
      orderId:   order.id,
      orderName: order.name,
      total:     order.amount_total,
      currency:  order.currency_id[1],
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Find or create a guest res.partner for the order.
   * For guest checkout, Odoo needs at minimum a partner_id.
   * We create a minimal contact record if no matching email is found.
   */
  private async _resolveGuestPartner(dto: CreateCartDto): Promise<number> {
    const customer = dto.customer;

    if (!customer) {
      // Use the generic public / guest partner (partner_id = 9 in most Odoo setups)
      // TODO: verify the guest partner ID in your Odoo instance
      return 9;
    }

    // Try to find existing partner by email
    const existing = await this.odoo.searchRead<{ id: number }>(
      'res.partner',
      [['email', '=', customer.email]],
      ['id'],
      { limit: 1 },
    );

    if (existing.length) return existing[0].id;

    // Create new contact
    const newId = await this.odoo.callKw<number>(
      'res.partner',
      'create',
      [{
        name:  `${customer.firstName} ${customer.lastName}`,
        email: customer.email,
        phone: customer.phone ?? false,
        customer_rank: 1,
      }],
    );

    return newId;
  }
}
