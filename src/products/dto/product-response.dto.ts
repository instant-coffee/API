// ─────────────────────────────────────────────────────────────────────────────
// Product response shapes
// These are what the Nuxt frontend receives — clean, Odoo-agnostic JSON.
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceDto {
  amount: number;
  currency: 'CAD' | 'USD';
  formatted: string;   // e.g. "$3,069 CAD"
}

export interface VariantDto {
  id:          number;
  sku:         string;
  position:    string;              // "Complete Wheelset" | "Front Only" | "Rear Only" | "N/A"
  rimSize:     string;              // "29" | "27.5" | "Mullet" | "N/A"
  attributes:  Record<string, string>; // full map of all attribute name → value for this variant
  price:       PriceDto;
  available:   boolean;             // false = archived (e.g. Mullet FW/RW)
}

export interface AttributeValueDto {
  id:          number;
  label:       string;
  priceExtra?: PriceDto;   // only present when price_extra > 0 in Odoo
}

export interface WheelOptionDto {
  type:        string;          // "freehub" | "brakeInterface"
  label:       string;          // Display label
  required:    boolean;
  visibleFor:  string[];        // which position values show this option
                                // e.g. ["Complete Wheelset", "Rear Only"]
                                // empty array = always visible
  values:      AttributeValueDto[];
}

export interface AddOnDto {
  id:         number;           // product.product ID
  templateId: number;           // product.template ID
  name:       string;
  sku:        string;
  price:      PriceDto;
  category:   string;           // "Upgrade" | "Accessory" | "Consumable"
}

export interface ProductResponseDto {
  id:          number;          // product.template ID
  name:        string;
  brand:       string;          // "nobl" | "westernbike"
  description: string;
  currency:    'CAD' | 'USD';
  variants:    VariantDto[];
  options:     WheelOptionDto[];
  addOns:      AddOnDto[];
}
