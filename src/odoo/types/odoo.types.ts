// ─────────────────────────────────────────────────────────────────────────────
// Raw Odoo JSON-RPC response shapes
// These represent what Odoo actually returns — before we transform anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface OdooJsonRpcResponse<T = any> {
  jsonrpc: string;
  id: number | null;
  result?: T;
  error?: OdooJsonRpcError;
}

export interface OdooJsonRpcError {
  code: number;
  message: string;
  data: {
    name: string;
    debug: string;
    message: string;
    arguments: string[];
    context: Record<string, any>;
  };
}

export interface OdooAuthResult {
  uid: number;
  session_id: string;
  db: string;
  name: string;
  username: string;
  partner_id: number;
  company_id: number;
}

// ─── Raw product.tag record ───────────────────────────────────────────────────
export interface OdooProductTag {
  id: number;
  name: string;
}

// ─── Raw product.template record ─────────────────────────────────────────────
export interface OdooProductTemplate {
  id: number;
  name: string;
  list_price: number;                          // CAD base (complete wheelset)
  description_ecommerce: string | false;
  categ_id: [number, string];
  attribute_line_ids: number[];
  product_variant_ids: number[];
  product_tag_ids: number[];                           // Many2many → product.tag IDs
  active: boolean;
  website_published: boolean;
  optional_product_ids: number[];
  x_brand?: string;                            // custom field if added
}

// ─── Raw product.product (variant) record ────────────────────────────────────
export interface OdooProductVariant {
  id: number;
  default_code: string | false;               // SKU
  product_tmpl_id: [number, string];
  product_template_attribute_value_ids: number[];
  lst_price: number;                           // pricelist-computed price
  price_extra: number;
  active: boolean;
  combination_indices: string;
}

// ─── Raw product.attribute ────────────────────────────────────────────────────
// create_variant lives on the attribute itself, not on the attribute line
export interface OdooAttribute {
  id: number;
  name: string;
  create_variant: 'always' | 'dynamic' | 'no_variant';
}

// ─── Raw product.template.attribute.line ─────────────────────────────────────
export interface OdooAttributeLine {
  id: number;
  attribute_id: [number, string];
  value_ids: number[];
  product_template_value_ids: number[];
  product_tmpl_id?: [number, string]; // present when fetched across multiple templates
  // create_variant is on product.attribute — fetched separately and joined by attribute_id
}

// ─── Raw product.attribute.value ─────────────────────────────────────────────
export interface OdooAttributeValue {
  id: number;
  name: string;
  attribute_id: [number, string];
  sequence: number;
  price_extra: number;
}

// ─── Raw product.template.attribute.value ────────────────────────────────────
export interface OdooTemplateAttributeValue {
  id: number;
  name: string;
  attribute_id: [number, string];
  attribute_line_id: number;
  product_attribute_value_id: [number, string];
  price_extra: number;
  ptav_active: boolean;
}

// ─── Raw product.pricelist ────────────────────────────────────────────────────
export interface OdooPricelist {
  id: number;
  name: string;
  currency_id: [number, string];
  active: boolean;
}

// ─── Raw sale.order ───────────────────────────────────────────────────────────
export interface OdooSaleOrder {
  id: number;
  name: string;                               // e.g. S00042
  state: 'draft' | 'sent' | 'sale' | 'done' | 'cancel';
  amount_total: number;
  currency_id: [number, string];
  note?: string | false;                      // terms & conditions (customer-facing, bottom of PDF)
  x_internal_note?: string | false;             // Custom internal build notes (Other Info tab, not customer-facing)
  order_line?: number[];                      // IDs of sale.order.line records
}

// ─── Odoo session state (in-memory) ──────────────────────────────────────────
export interface OdooSession {
  uid: number;
  sessionId: string;
  expiresAt: Date;
}
