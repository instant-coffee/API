import { Controller, Get, Param, ParseIntPipe, Headers, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { resolveSiteContext } from '../config/site-context';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * GET /products
   * List all published products for the given site context.
   *
   * Headers:
   *   x-site-context: nobl_ca | nobl_us | wb_ca | wb_us
   */
  @Get()
  listProducts(
    @Headers('x-site-context') siteHeader?: string,
  ) {
    const site = resolveSiteContext(siteHeader);
    return this.products.listProducts(site);
  }

  /**
   * GET /products/:id
   * Full product detail — variants, no_variant options, add-ons, pricelist pricing.
   *
   * Headers:
   *   x-site-context: nobl_ca | nobl_us | wb_ca | wb_us
   *
   * Example:
   *   GET /products/42
   *   x-site-context: nobl_ca
   */
  @Get(':id')
  getProduct(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-site-context') siteHeader?: string,
  ) {
    const site = resolveSiteContext(siteHeader);
    return this.products.getProduct(id, site);
  }
}
