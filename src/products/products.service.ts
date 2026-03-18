import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OdooService } from '../odoo/odoo.service';
import {
  OdooProductTemplate,
  OdooProductVariant,
  OdooAttributeLine,
  OdooAttribute,
  OdooTemplateAttributeValue,
} from '../odoo/types/odoo.types';
import { SiteContext } from '../config/site-context';
import {
  ProductResponseDto,
  VariantDto,
  WheelOptionDto,
  AddOnDto,
  PriceDto,
} from './dto/product-response.dto';

// ─── Attribute names as they appear in Odoo ──────────────────────────────────
// Used to identify which attribute lines are no_variant options vs. variants.
const POSITION_ATTRIBUTE   = 'Wheelset Options';       // creates inventory variants
const RIM_SIZE_ATTRIBUTE   = 'Rim Size';               // creates inventory variants
const FREEHUB_ATTRIBUTE    = 'Freehub Type Option';    // no_variant — actual Odoo name
const BRAKE_ATTRIBUTE      = 'Brake Interface Option'; // no_variant — actual Odoo name

// Freehub is only relevant for rear-wheel builds.
// Values must match exactly what Odoo returns in the Wheelset Options attribute.
const FREEHUB_VISIBLE_FOR  = ['Rear Wheel', 'Complete Wheelset'];

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly odoo: OdooService) {}

  // ─── Get a single product template, fully shaped ───────────────────────────

  async getProduct(
    templateId: number,
    site: SiteContext,
  ): Promise<ProductResponseDto> {
    this.logger.log(`Fetching product ${templateId} for site ${site.siteId}`);

    // ── 1. Fetch the product template ────────────────────────────────────────
    const [template] = await this.odoo.searchRead<OdooProductTemplate>(
      'product.template',
      [['id', '=', templateId]],
      [
        'id', 'name', 'list_price', 'description_sale',
        'attribute_line_ids', 'product_variant_ids',
        'optional_product_ids', 'active',
      ],
    );

    if (!template) {
      throw new NotFoundException(`Product template ${templateId} not found`);
    }

    // ── 2. Fetch attribute lines ──────────────────────────────────────────────
    // Note: create_variant lives on product.attribute, not on the line itself
    const attrLines = await this.odoo.searchRead<OdooAttributeLine>(
      'product.template.attribute.line',
      [['id', 'in', template.attribute_line_ids]],
      ['id', 'attribute_id', 'value_ids', 'product_template_value_ids'],
    );

    // ── 2b. Fetch product.attribute to get create_variant for each line ───────
    const attributeIds = [...new Set(attrLines.map((l) => l.attribute_id[0]))];
    const attributes   = await this.odoo.searchRead<OdooAttribute>(
      'product.attribute',
      [['id', 'in', attributeIds]],
      ['id', 'name', 'create_variant'],
    );
    // Map: attribute ID → create_variant value
    const createVariantByAttrId = new Map(
      attributes.map((a) => [a.id, a.create_variant]),
    );

    // ── 3. Collect all PTAV IDs across all attribute lines ────────────────────
    const allPtavIds = attrLines.flatMap((l) => l.product_template_value_ids);

    const ptavs = await this.odoo.searchRead<OdooTemplateAttributeValue>(
      'product.template.attribute.value',
      [['id', 'in', allPtavIds]],
      ['id', 'name', 'attribute_id', 'attribute_line_id', 'price_extra', 'ptav_active'],
    );

    const ptavById = new Map(ptavs.map((p) => [p.id, p]));

    // ── 3b. Build reverse lookup: ptavId → lineId ─────────────────────────────
    // We derive this from the attribute lines' own product_template_value_ids
    // lists — NOT from the attribute_line_id field on the PTAV record.
    //
    // Why: attribute_line_id is a Many2one and Odoo's search_read returns it
    // as a [id, displayName] tuple, not a plain integer, so comparing it
    // directly against a lineId number always fails silently.
    const ptavToLineId = new Map<number, number>();
    for (const line of attrLines) {
      for (const ptavId of line.product_template_value_ids) {
        ptavToLineId.set(ptavId, line.id);
      }
    }

    // ── 3c. Build readable label lookup: lineId → attribute name ─────────────
    const lineIdToAttrName = new Map(
      attrLines.map((l) => [l.id, l.attribute_id[1]]),
    );

    // Find the line IDs for position and rim size on THIS template.
    const positionLineId = attrLines.find(
      (l) => l.attribute_id[1] === POSITION_ATTRIBUTE,
    )?.id;

    const rimSizeLineId = attrLines.find(
      (l) => l.attribute_id[1] === RIM_SIZE_ATTRIBUTE,
    )?.id;

    this.logger.debug(
      `Attribute lines — position: ${positionLineId ?? 'none'}, rimSize: ${rimSizeLineId ?? 'none'}`,
    );

    // ── 4. Fetch variants ─────────────────────────────────────────────────────
    const variants = await this.odoo.searchRead<OdooProductVariant>(
      'product.product',
      [['product_tmpl_id', '=', templateId]],
      [
        'id', 'default_code', 'product_template_attribute_value_ids',
        'price_extra', 'active', 'lst_price',
      ],
    );

    // ── 5. Get pricelist prices for all variants ──────────────────────────────
    this.logger.debug(
      `Variant price_extra values: ${variants.map(v => `${v.default_code}=${v.price_extra}`).join(', ')}`,
    );
    const variantIds      = variants.map((v) => v.id);
    const pricelistPrices = await this.odoo.getPricelistPrices(
      site.pricelistId,
      variantIds,
    );

    // ── 6. Shape variants ─────────────────────────────────────────────────────
    const shapedVariants: VariantDto[] = variants.map((v) => {
      const variantPtavs = v.product_template_attribute_value_ids
        .map((id) => ptavById.get(id))
        .filter((p): p is OdooTemplateAttributeValue => !!p);

      // For each PTAV on this variant, resolve its parent line ID via the
      // reverse lookup built from attrLines — avoids the Many2one tuple issue.
      const positionPtav = positionLineId !== undefined
        ? variantPtavs.find((p) => ptavToLineId.get(p.id) === positionLineId)
        : undefined;

      const rimSizePtav = rimSizeLineId !== undefined
        ? variantPtavs.find((p) => ptavToLineId.get(p.id) === rimSizeLineId)
        : undefined;

      // Full attribute map for the `attributes` field — useful for the frontend
      // and for debugging unexpected N/A values.
      const attributes: Record<string, string> = {};
      for (const ptav of variantPtavs) {
        const lineId   = ptavToLineId.get(ptav.id);
        const attrName = lineId !== undefined ? lineIdToAttrName.get(lineId) : undefined;
        if (attrName) attributes[attrName] = ptav.name;
      }

      const rawPrice = pricelistPrices[v.id] ?? v.lst_price;

      return {
        id:         v.id,
        sku:        v.default_code || `tmpl-${templateId}-var-${v.id}`,
        position:   positionPtav?.name ?? 'N/A',
        rimSize:    rimSizePtav?.name  ?? 'N/A',
        attributes,
        price:      this._formatPrice(rawPrice, site.currency),
        available:  v.active,
      };
    });

    // ── 7. Shape no_variant wheel options ─────────────────────────────────────
    const noVariantLines = attrLines.filter(
      (l) => createVariantByAttrId.get(l.attribute_id[0]) === 'no_variant',
    );

    const shapedOptions: WheelOptionDto[] = noVariantLines.map((line) => {
      const attrName    = line.attribute_id[1];
      const isFreehub   = attrName === FREEHUB_ATTRIBUTE;
      const isBrake     = attrName === BRAKE_ATTRIBUTE;

      const values = line.product_template_value_ids
        .map((id) => ptavById.get(id))
        .filter((p): p is OdooTemplateAttributeValue => !!p)
        .map((ptav) => ({ id: ptav.id, label: ptav.name }));

      return {
        type:       isFreehub ? 'freehub' : isBrake ? 'brakeInterface' : attrName.toLowerCase(),
        label:      attrName,
        required:   true,
        visibleFor: isFreehub ? FREEHUB_VISIBLE_FOR : [],
        values,
      };
    });

    // ── 8. Fetch add-on products ──────────────────────────────────────────────
    let shapedAddOns: AddOnDto[] = [];

    if (template.optional_product_ids?.length) {
      const addOnTemplates = await this.odoo.searchRead<OdooProductTemplate>(
        'product.template',
        [['id', 'in', template.optional_product_ids]],
        ['id', 'name', 'list_price', 'categ_id'],
      );

      // Fetch the default variant for each add-on to get its SKU
      const addOnVariants = await this.odoo.searchRead<OdooProductVariant>(
        'product.product',
        [['product_tmpl_id', 'in', template.optional_product_ids]],
        ['id', 'default_code', 'product_tmpl_id', 'active'],
      );

      const variantsByTemplate = new Map<number, OdooProductVariant[]>();
      for (const v of addOnVariants) {
        const tmplId = v.product_tmpl_id[0];
        if (!variantsByTemplate.has(tmplId)) variantsByTemplate.set(tmplId, []);
        variantsByTemplate.get(tmplId)!.push(v);
      }

      // Get pricelist prices for add-on variants
      const addOnVariantIds = addOnVariants.map((v) => v.id);
      const addOnPrices     = addOnVariantIds.length
        ? await this.odoo.getPricelistPrices(site.pricelistId, addOnVariantIds)
        : {};

      shapedAddOns = addOnTemplates.map((t) => {
        const defaultVariant = variantsByTemplate.get(t.id)?.[0];
        const price          = defaultVariant
          ? (addOnPrices[defaultVariant.id] ?? t.list_price)
          : t.list_price;

        return {
          id:         defaultVariant?.id ?? 0,
          templateId: t.id,
          name:       t.name,
          sku:        defaultVariant?.default_code || `addon-${t.id}`,
          price:      this._formatPrice(price, site.currency),
          category:   this._classifyAddOn(t.name),
        };
      });
    }

    // ── 9. Assemble final response ────────────────────────────────────────────
    return {
      id:          template.id,
      name:        template.name,
      brand:       'nobl',   // TODO: derive from product category or x_brand field
      description: template.description_sale || '',
      currency:    site.currency,
      variants:    shapedVariants,
      options:     shapedOptions,
      addOns:      shapedAddOns,
    };
  }

  // ─── Get all published products (catalog listing) ─────────────────────────

  async listProducts(site: SiteContext): Promise<Pick<ProductResponseDto, 'id' | 'name' | 'brand' | 'currency'>[]> {
    const templates = await this.odoo.searchRead<OdooProductTemplate>(
      'product.template',
      [['website_published', '=', true], ['active', '=', true]],
      ['id', 'name'],
    );

    return templates.map((t) => ({
      id:       t.id,
      name:     t.name,
      brand:    'nobl',
      currency: site.currency,
    }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private _formatPrice(amount: number, currency: 'CAD' | 'USD'): PriceDto {
    const locale     = currency === 'CAD' ? 'en-CA' : 'en-US';
    const isoCode    = currency;
    const formatted  = new Intl.NumberFormat(locale, {
      style:    'currency',
      currency: isoCode,
    }).format(amount) + ` ${isoCode}`;

    return { amount, currency, formatted };
  }

  private _classifyAddOn(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('valve'))  return 'Consumable';
    if (n.includes('torque')) return 'Upgrade';
    if (n.includes('berd'))   return 'Upgrade';
    return 'Accessory';
  }
}
