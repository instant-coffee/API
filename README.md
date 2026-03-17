# NOBL API — NestJS Odoo Proxy Layer

The NestJS API layer that sits between the Nuxt storefronts and Odoo. All Odoo JSON-RPC communication is contained here — the frontend never talks to Odoo directly.

## Architecture

```
Nuxt Frontend  →  NestJS API (this repo)  →  Odoo JSON-RPC
                  ┌─────────────────────┐
                  │  /api/v1/products   │  Product catalog + pricing
                  │  /api/v1/cart       │  Order creation
                  │  /api/v1/auth       │  Dealer JWT login
                  └─────────────────────┘
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Odoo staging credentials

# 3. Start dev server (watch mode)
npm run start:dev
```

API will be available at `http://localhost:3000/api/v1`

## Environment Variables

| Variable | Description |
|---|---|
| `ODOO_BASE_URL` | Odoo instance URL e.g. `https://nobl-wheels-test-29277408.dev.odoo.com` |
| `ODOO_DB` | Odoo database name |
| `ODOO_ADMIN_LOGIN` | Admin user email |
| `ODOO_ADMIN_PASSWORD` | Admin user password |
| `JWT_SECRET` | Secret for signing dealer JWTs |
| `PORT` | API server port (default `3000`) |
| `CORS_ORIGINS` | Comma-separated list of allowed frontend origins |

## Endpoints

### Products

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/products` | List all published products |
| `GET` | `/api/v1/products/:id` | Full product detail with variants, options, add-ons |

**Headers:** `x-site-context: nobl_ca | nobl_us | wb_ca | wb_us`

### Cart

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/cart` | Create a sale.order in Odoo |

Guest checkout requires no auth header. Dealer orders include `Authorization: Bearer <jwt>`.

**Key field:** `noVariantValueIds` on each line item — this is the Freehub/Brake selection that flows to `product_no_variant_attribute_value_ids` on `sale.order.line`.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/auth/login` | Dealer login — returns JWT |

## POC Validation Checklist

When testing against staging Odoo, verify:

- [ ] `GET /products/:id` returns Ethos Enduro with 7 variants (2 archived Mullet variants excluded)
- [ ] `options` array contains `freehub` with `visibleFor: ["Complete Wheelset", "Rear Only"]`
- [ ] `options` array contains `brakeInterface` with `visibleFor: []` (always visible)
- [ ] Prices differ between `x-site-context: nobl_ca` (CAD) and `nobl_us` (USD)
- [ ] `POST /cart` creates a `sale.order` in Odoo with correct `sale.order.line` records
- [ ] Order lines for rear/complete wheelsets have `product_no_variant_attribute_value_ids` populated
- [ ] Manufacturing view in Odoo shows the Freehub + Brake Interface selections on the order

## Module Structure

```
src/
├── main.ts                    # Bootstrap, CORS, global prefix
├── app.module.ts              # Root module
├── config/
│   ├── configuration.ts       # Env var factory
│   └── site-context.ts        # Domain → pricelist/currency mapping
├── odoo/
│   ├── odoo.module.ts
│   ├── odoo.service.ts        # JSON-RPC client (authenticate, searchRead, callKw)
│   └── types/odoo.types.ts    # Raw Odoo record shapes
├── products/
│   ├── products.module.ts
│   ├── products.controller.ts
│   ├── products.service.ts    # Template → shaped ProductResponseDto
│   └── dto/product-response.dto.ts
├── cart/
│   ├── cart.module.ts
│   ├── cart.controller.ts
│   ├── cart.service.ts        # sale.order creation with no_variant attr values
│   └── dto/create-cart.dto.ts
└── auth/
    ├── auth.module.ts
    ├── auth.controller.ts
    ├── auth.service.ts        # Dealer JWT login via Odoo res.users
    ├── guards/
    │   ├── jwt.strategy.ts
    │   └── optional-jwt.guard.ts
    └── dto/login.dto.ts
```

## Site Context

All requests must include an `x-site-context` header:

| Value | Brand | Currency | Domain |
|---|---|---|---|
| `nobl_ca` | NOBL | CAD | shop.noblwheels.ca |
| `nobl_us` | NOBL | USD | shop.noblwheels.com |
| `wb_ca` | Western Bike | CAD | shop.westernbike.ca |
| `wb_us` | Western Bike | USD | shop.westernbike.com |

Pricelist IDs in `src/config/site-context.ts` are **placeholders** — confirm the correct IDs against your Odoo instance under Settings → Sales → Pricelists (requires developer mode).
