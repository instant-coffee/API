import {
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
  IsEmail,
  Min,
  IsNumber,
} from "class-validator";
import { Type } from "class-transformer";

// ─── Individual line item ─────────────────────────────────────────────────────

export class CartLineDto {
  @IsInt()
  variantId: number; // product.product ID

  @IsInt()
  @Min(1)
  quantity: number;

  /**
   * no_variant attribute value IDs selected by the customer.
   * Maps to product_no_variant_attribute_value_ids on sale.order.line.
   * e.g. the PTAV IDs for chosen Freehub Type + Brake Interface.
   */
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  noVariantValueIds?: number[];

  /**
   * Pre-computed unit price including all no_variant price_extra surcharges.
   * Sent by the frontend so Odoo sets the correct price_unit without needing
   * an ORM onchange round-trip (programmatic line creation skips onchange).
   * When absent, Odoo resolves the price from the active pricelist.
   */
  @IsNumber()
  @IsOptional()
  unitPrice?: number;
}

// ─── Customer info ────────────────────────────────────────────────────────────

export class CustomerDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsOptional()
  phone?: string;
}

// ─── Bike details (optional build notes) ─────────────────────────────────────

export class BikeDetailsDto {
  @IsString()
  @IsOptional()
  make?: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  year?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ─── Full cart / order request ────────────────────────────────────────────────

export class CreateCartDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines: CartLineDto[];

  @ValidateNested()
  @Type(() => CustomerDto)
  @IsOptional()
  customer?: CustomerDto; // omitted for guest checkout; present for dealer orders

  /**
   * Site context from the frontend — determines pricelist and currency.
   * The controller resolves this from the x-site-context header,
   * but can also be passed in the body for explicitness.
   */
  @IsString()
  @IsOptional()
  siteId?: string;

  /**
   * Optional bike build details captured by the configurator UI.
   * Formatted and written to sale.order note field in Odoo so the build
   * team can see what bike the wheels are intended for.
   */
  @ValidateNested()
  @Type(() => BikeDetailsDto)
  @IsOptional()
  bikeDetails?: BikeDetailsDto;
}
