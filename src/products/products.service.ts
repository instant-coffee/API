import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OdooService } from '../odoo/odoo.service';
import {
  OdooProductTemplate,
  OdooProductVariant,
  OdooAttributeLine,
  OdooAttribute,
  OdooTemplateAttributeValue,
  OdooProductTag,
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
const FREEHUB_ATTRIBUTE    = 'Freehub Type Option';    // no_variant
const BRAKE_ATTRIBUTE      = 'Brake Interface Option'; // no_variant
const FRONT_HUB_ATTRIBUTE  = 'Front Hub Spacing -- Mountain';  // no_variant — FW template
const REAR_HUB_ATTRIBUTE   = 'Rear Hub Spacing -- Mountain';   // no_variant — RW template
const TORQUE_CAP_ATTRIBUTE = 'Torque Cap Option';              // no_variant — FW template, only with 110 x 15

// Freehub is only relevant for rear-wheel builds.
// Values must match exactly what Odoo returns in the Wheelset Options attribute.
const FREEHUB_VISIBLE_FOR  = ['Rear Wheel', 'Complete Wheelset'];

// Options that are optional (required: false in the response).
// Everything else is required by default.
const OPTIONAL_OPTION_TYPES = new Set(['torqueCap']);

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
        'id', 'name', 'list_price', 'description_ecommerce',
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
      const attrName  = line.attribute_id[1];
      const isFreehub = attrName === FREEHUB_ATTRIBUTE;

      const values = line.product_template_value_ids
        .map((id) => ptavById.get(id))
        .filter((p): p is OdooTemplateAttributeValue => !!p)
        .map((ptav) => ({
          id:    ptav.id,
          label: ptav.name,
          ...(ptav.price_extra ? { priceExtra: this._formatPrice(ptav.price_extra, site.currency) } : {}),
        }));

      const typeKey = this._attrNameToTypeKey(attrName);
      return {
        type:       typeKey,
        label:      attrName,
        required:   !OPTIONAL_OPTION_TYPES.has(typeKey),
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
      description: template.description_ecommerce || '',
      currency:    site.currency,
      variants:    shapedVariants,
      options:     shapedOptions,
      addOns:      shapedAddOns,
    };
  }

  // ─── Get a product family grouped by tag ──────────────────────────────────
  //
  // For products structured as separate Odoo templates (Front Wheel / Rear Wheel /
  // Wheelset), this method stitches them into a single ProductResponseDto that
  // the WheelConfigurator can consume without any frontend changes.
  //
  // Variant position is derived from the product's name/role, not from a
  // "Wheelset Options" attribute (which only exists on single-template products
  // like the Ethos Enduro).

  async getProductFamily(
    familyTag: string,
    site: SiteContext,
  ): Promise<ProductResponseDto> {
    this.logger.log(`Fetching family "${familyTag}" for site ${site.siteId}`);

    // ── 1. Find all templates carrying this family tag ────────────────────────
    const templates = await this.odoo.searchRead<OdooProductTemplate>(
      'product.template',
      [['product_tag_ids.name', '=', familyTag], ['active', '=', true]],
      [
        'id', 'name', 'list_price', 'description_ecommerce',
        'attribute_line_ids', 'product_variant_ids', 'optional_product_ids',
      ],
    );

    if (!templates.length) {
      throw new NotFoundException(
        `No products found for family tag "${familyTag}"`,
      );
    }

    // ── 2. Assign role to each template ───────────────────────────────────────
    const roledTemplates = templates.map((t) => ({
      template: t,
      role: this._detectFamilyRole(t.name),
    }));

    // ── 3. Batch-fetch attribute lines for all templates ──────────────────────
    const allLineIds = roledTemplates.flatMap(
      ({ template }) => template.attribute_line_ids,
    );
    const allAttrLines = await this.odoo.searchRead<OdooAttributeLine>(
      'product.template.attribute.line',
      [['id', 'in', allLineIds]],
      ['id', 'attribute_id', 'value_ids', 'product_template_value_ids', 'product_tmpl_id'],
    );

    // ── 3b. Batch-fetch product.attribute for create_variant ──────────────────
    const uniqueAttrIds = [
      ...new Set(allAttrLines.map((l) => l.attribute_id[0])),
    ];
    const allAttributes = await this.odoo.searchRead<OdooAttribute>(
      'product.attribute',
      [['id', 'in', uniqueAttrIds]],
      ['id', 'name', 'create_variant'],
    );
    const createVariantByAttrId = new Map(
      allAttributes.map((a) => [a.id, a.create_variant]),
    );

    // ── 3c. Batch-fetch all PTAVs ─────────────────────────────────────────────
    const allPtavIds = allAttrLines.flatMap((l) => l.product_template_value_ids);
    const allPtavs   = await this.odoo.searchRead<OdooTemplateAttributeValue>(
      'product.template.attribute.value',
      [['id', 'in', allPtavIds]],
      ['id', 'name', 'attribute_id', 'price_extra', 'ptav_active'],
    );
    const ptavById = new Map(allPtavs.map((p) => [p.id, p]));

    // ptavId → lineId (built from each line's product_template_value_ids list)
    const ptavToLineId = new Map<number, number>();
    for (const line of allAttrLines) {
      for (const ptavId of line.product_template_value_ids) {
        ptavToLineId.set(ptavId, line.id);
      }
    }

    // ── 4. Batch-fetch all variants across all templates ──────────────────────
    const allTemplateIds = templates.map((t) => t.id);
    const allVariants    = await this.odoo.searchRead<OdooProductVariant>(
      'product.product',
      [['product_tmpl_id', 'in', allTemplateIds]],
      ['id', 'default_code', 'product_template_attribute_value_ids',
       'price_extra', 'active', 'lst_price', 'product_tmpl_id'],
    );

    // ── 5. Batch pricelist prices for all variants ────────────────────────────
    const allVariantIds   = allVariants.map((v) => v.id);
    const pricelistPrices = await this.odoo.getPricelistPrices(
      site.pricelistId,
      allVariantIds,
    );

    // ── 6. Shape unified variant list ─────────────────────────────────────────
    const shapedVariants: VariantDto[] = [];

    for (const { template, role } of roledTemplates) {
      const position = this._roleToPosition(role);

      // Attribute lines for this specific template
      const tmplLineIds = template.attribute_line_ids;
      const tmplLines   = allAttrLines.filter((l) => tmplLineIds.includes(l.id));

      // Find the Rim Size line for this template
      const rimSizeLineId = tmplLines.find(
        (l) => l.attribute_id[1] === RIM_SIZE_ATTRIBUTE,
      )?.id;

      const tmplVariants = allVariants.filter(
        (v) => (v.product_tmpl_id as unknown as [number, string])[0] === template.id,
      );

      for (const v of tmplVariants) {
        const variantPtavs = v.product_template_attribute_value_ids
          .map((id) => ptavById.get(id))
          .filter((p): p is OdooTemplateAttributeValue => !!p);

        const rimSizePtav = rimSizeLineId !== undefined
          ? variantPtavs.find((p) => ptavToLineId.get(p.id) === rimSizeLineId)
          : undefined;

        const attributes: Record<string, string> = {};
        for (const ptav of variantPtavs) {
          const lineId   = ptavToLineId.get(ptav.id);
          const attrName = lineId !== undefined
            ? allAttrLines.find((l) => l.id === lineId)?.attribute_id[1]
            : undefined;
          if (attrName) attributes[attrName] = ptav.name;
        }

        const rawPrice = pricelistPrices[v.id] ?? v.lst_price;

        shapedVariants.push({
          id:        v.id,
          sku:       v.default_code || `tmpl-${template.id}-var-${v.id}`,
          position,
          rimSize:   rimSizePtav?.name ?? 'N/A',
          attributes,
          price:     this._formatPrice(rawPrice, site.currency),
          available: v.active,
        });
      }
    }

    // ── 7. Merge no_variant options from all templates ────────────────────────
    //
    // Options are collected from each template. If the same option type appears
    // on multiple templates (e.g. Brake Interface on both FW and RW), we keep
    // the first instance and merge the visibleFor arrays.
    //
    // visibleFor is derived from the role of the template the option came from,
    // not from the stored FREEHUB_VISIBLE_FOR constant — allowing any product
    // combination to define which positions need a given option.

    const optionMap = new Map<string, WheelOptionDto>();

    for (const { template, role } of roledTemplates) {
      const position  = this._roleToPosition(role);
      const tmplLines = allAttrLines.filter(
        (l) => template.attribute_line_ids.includes(l.id),
      );
      const noVariantLines = tmplLines.filter(
        (l) => createVariantByAttrId.get(l.attribute_id[0]) === 'no_variant',
      );

      for (const line of noVariantLines) {
        const attrName  = line.attribute_id[1];
        const typeKey   = this._attrNameToTypeKey(attrName);

        const values = line.product_template_value_ids
          .map((id) => ptavById.get(id))
          .filter((p): p is OdooTemplateAttributeValue => !!p)
          .map((ptav) => ({
          id:    ptav.id,
          label: ptav.name,
          ...(ptav.price_extra ? { priceExtra: this._formatPrice(ptav.price_extra, site.currency) } : {}),
        }));

        if (optionMap.has(typeKey)) {
          // Option already registered — just extend visibleFor if not already present
          const existing = optionMap.get(typeKey)!;
          if (!existing.visibleFor.includes(position)) {
            existing.visibleFor.push(position);
          }
        } else {
          optionMap.set(typeKey, {
            type:       typeKey,
            label:      attrName,
            required:   !OPTIONAL_OPTION_TYPES.has(typeKey),
            visibleFor: [position],
            values,
          });
        }
      }
    }

    const shapedOptions = [...optionMap.values()];

    // ── 7b. Ensure Complete Wheelset inherits all options ─────────────────────
    //
    // The Wheelset template typically has no no_variant attribute lines of its
    // own — those live on the FW and RW templates. But a complete wheelset order
    // always includes both wheels, so every option that applies to any component
    // wheel must also be shown when position === "Complete Wheelset".
    //
    // We simply add "Complete Wheelset" to every option's visibleFor if this
    // family actually contains a complete-role template.
    const hasComplete = roledTemplates.some(({ role }) => role === 'complete');
    if (hasComplete) {
      for (const option of shapedOptions) {
        if (!option.visibleFor.includes('Complete Wheelset')) {
          option.visibleFor.push('Complete Wheelset');
        }
      }
    }

    // ── 8. Add-ons from Wheelset template (or first template with optional_products) ──
    let shapedAddOns: AddOnDto[] = [];
    const wheelsetTemplate = roledTemplates.find(
      ({ role }) => role === 'complete',
    )?.template;

    if (wheelsetTemplate?.optional_product_ids?.length) {
      const addOnTemplates = await this.odoo.searchRead<OdooProductTemplate>(
        'product.template',
        [['id', 'in', wheelsetTemplate.optional_product_ids]],
        ['id', 'name', 'list_price', 'categ_id'],
      );
      const addOnVariants = await this.odoo.searchRead<OdooProductVariant>(
        'product.product',
        [['product_tmpl_id', 'in', wheelsetTemplate.optional_product_ids]],
        ['id', 'default_code', 'product_tmpl_id', 'active'],
      );
      const variantsByTemplate = new Map<number, OdooProductVariant[]>();
      for (const v of addOnVariants) {
        const tmplId = (v.product_tmpl_id as unknown as [number, string])[0];
        if (!variantsByTemplate.has(tmplId)) variantsByTemplate.set(tmplId, []);
        variantsByTemplate.get(tmplId)!.push(v);
      }
      const addOnPrices = addOnVariants.length
        ? await this.odoo.getPricelistPrices(
            site.pricelistId,
            addOnVariants.map((v) => v.id),
          )
        : {};

      shapedAddOns = addOnTemplates.map((t) => {
        const defaultVariant = variantsByTemplate.get(t.id)?.[0];
        const price = defaultVariant
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

    // ── 9. Derive family display name ─────────────────────────────────────────
    // Use the Wheelset template name, stripping the role suffix.
    const baseName = (wheelsetTemplate ?? templates[0]).name
      .replace(/\s+(wheelset|front wheel|rear wheel)$/i, '')
      .trim();

    const description = (wheelsetTemplate ?? templates[0]).description_ecommerce || '';

    return {
      id:          wheelsetTemplate?.id ?? templates[0].id,
      name:        baseName,
      brand:       'nobl',
      description,
      currency:    site.currency,
      variants:    shapedVariants,
      options:     shapedOptions,
      addOns:      shapedAddOns,
    };
  }

  // ─── Get all published products (catalog listing) ─────────────────────────

  async listProducts(
    site: SiteContext,
  ): Promise<(Pick<ProductResponseDto, 'id' | 'name' | 'brand' | 'currency'> & { familyTag?: string })[]> {
    const templates = await this.odoo.searchRead<OdooProductTemplate>(
      'product.template',
      [['website_published', '=', true], ['active', '=', true]],
      ['id', 'name', 'product_tag_ids'],
    );

    // Resolve tag names so we can surface the family tag per product.
    // Only fetch if any template actually has tags.
    const allTagIds = [...new Set(templates.flatMap((t) => t.product_tag_ids ?? []))];
    const tagNameById = new Map<number, string>();

    if (allTagIds.length) {
      const tags = await this.odoo.searchRead<OdooProductTag>(
        'product.tag',
        [['id', 'in', allTagIds]],
        ['id', 'name'],
      );
      for (const tag of tags) tagNameById.set(tag.id, tag.name);
    }

    return templates.map((t) => {
      const familyTag = (t.product_tag_ids ?? [])
        .map((id) => tagNameById.get(id) ?? '')
        .find((name) => name.startsWith('family:'));

      return {
        id:        t.id,
        name:      t.name,
        brand:     'nobl',
        currency:  site.currency,
        ...(familyTag ? { familyTag } : {}),
      };
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // ─── Map Odoo attribute name → stable camelCase type key ──────────────────
  // Used in both getProduct and getProductFamily so the frontend always receives
  // consistent type keys regardless of how Odoo names the attribute.
  private _attrNameToTypeKey(attrName: string): string {
    switch (attrName) {
      case FREEHUB_ATTRIBUTE:    return 'freehub';
      case BRAKE_ATTRIBUTE:      return 'brakeInterface';
      case FRONT_HUB_ATTRIBUTE:  return 'frontHub';
      case REAR_HUB_ATTRIBUTE:   return 'rearHub';
      case TORQUE_CAP_ATTRIBUTE: return 'torqueCap';
      default:
        return attrName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    }
  }

  private _detectFamilyRole(name: string): 'front' | 'rear' | 'complete' {
    const n = name.toLowerCase();
    if (n.includes('front wheel')) return 'front';
    if (n.includes('rear wheel'))  return 'rear';
    return 'complete'; // Wheelset / complete set
  }

  private _roleToPosition(role: 'front' | 'rear' | 'complete'): string {
    return role === 'front'    ? 'Front Wheel'
         : role === 'rear'     ? 'Rear Wheel'
         : 'Complete Wheelset';
  }

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
