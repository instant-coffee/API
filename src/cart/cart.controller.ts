import { Controller, Post, Body, Headers, UseGuards, Request, Logger } from '@nestjs/common';
import { CartService } from './cart.service';
import { CreateCartDto } from './dto/create-cart.dto';
import { resolveSiteContext } from '../config/site-context';
import { OptionalJwtGuard } from '../auth/guards/optional-jwt.guard';

@Controller('cart')
export class CartController {
  private readonly logger = new Logger(CartController.name);

  constructor(private readonly cart: CartService) {}

  /**
   * POST /cart
   * Create a sale.order in Odoo.
   *
   * Works for both:
   *   - Guest checkout (no auth header)
   *   - Authenticated dealer (Bearer token → dealer pricelist applied)
   *
   * Body: CreateCartDto
   * Headers:
   *   x-site-context: nobl_ca | nobl_us | wb_ca | wb_us
   *   Authorization: Bearer <jwt>  (optional — dealer only)
   */
  @Post()
  @UseGuards(OptionalJwtGuard)
  createOrder(
    @Body() dto: CreateCartDto,
    @Headers('x-site-context') siteHeader?: string,
    @Request() req?: any,
  ) {
    const site = resolveSiteContext(siteHeader ?? dto.siteId);
    const dealerPartnerId   = req?.user?.odooPartnerId ?? undefined;
    const dealerPricelistId = req?.user?.pricelistId   ?? undefined;

    this.logger.log(
      `POST /cart — site: ${site.siteId} | ` +
      `lines: ${dto.lines.length} | ` +
      `dealer: ${dealerPartnerId ?? 'guest'} | ` +
      `bikeDetails: ${dto.bikeDetails ? JSON.stringify(dto.bikeDetails) : 'none'}`,
    );

    dto.lines.forEach((line, i) => {
      this.logger.log(
        `  Line ${i + 1}: variantId=${line.variantId} qty=${line.quantity} ` +
        `noVariantIds=[${line.noVariantValueIds?.join(', ') ?? 'none'}]`,
      );
    });

    return this.cart.createOrder(dto, site, dealerPartnerId, dealerPricelistId);
  }
}
