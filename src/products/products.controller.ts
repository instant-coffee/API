import { Controller, Get, Param, ParseIntPipe, Headers } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { resolveSiteContext } from "../config/site-context";

@Controller("products")
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
  listProducts(@Headers("x-site-context") siteHeader?: string) {
    const site = resolveSiteContext(siteHeader);
    return this.products.listProducts(site);
  }

  /**
   * GET /products/family/:tag
   * Returns a unified WheelConfigurator-compatible response assembled from all
   * product templates sharing the given family tag.
   *
   * Used for wheel families structured as separate Odoo templates (Front Wheel /
   * Rear Wheel / Wheelset) rather than a single template with a "Wheelset Options"
   * variant attribute.
   *
   * NOTE: declared before /:id so NestJS does not treat "family" as an integer ID.
   *
   * Headers:
   *   x-site-context: nobl_ca | nobl_us | wb_ca | wb_us
   *
   * Example:
   *   GET /products/family/family:sr38-hope-pro5
   *   x-site-context: nobl_us
   */
  @Get("family/:tag")
  getFamily(
    @Param("tag") tag: string,
    @Headers("x-site-context") siteHeader?: string,
  ) {
    const site = resolveSiteContext(siteHeader);
    return this.products.getProductFamily(tag, site);
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
  @Get(":id")
  getProduct(
    @Param("id", ParseIntPipe) id: number,
    @Headers("x-site-context") siteHeader?: string,
  ) {
    const site = resolveSiteContext(siteHeader);
    return this.products.getProduct(id, site);
  }
}
