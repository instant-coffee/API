import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OdooService } from '../odoo/odoo.service';
import { LoginDto } from './dto/login.dto';

// ─────────────────────────────────────────────────────────────────────────────
// AuthService — dealer B2B authentication
//
// Flow:
//   1. POST /auth/login with dealer email + password
//   2. We authenticate against Odoo using THOSE credentials (not the admin account)
//      so Odoo's own access controls validate the dealer
//   3. We look up the res.partner to get their assigned pricelist
//   4. We issue a short-lived JWT containing odooPartnerId + pricelistId
//   5. All subsequent requests include the JWT → cart uses dealer pricelist
//
// NOTE: In this stub, step 2 re-authenticates via Odoo's session/authenticate
// endpoint using the dealer's own Odoo user credentials. This requires each
// dealer to have an Odoo Portal user account. Evaluate whether this is the
// right approach vs. a separate credentials table.
// ─────────────────────────────────────────────────────────────────────────────

export interface DealerJwtPayload {
  sub:             number;    // res.partner ID
  email:           string;
  odooPartnerId:   number;
  pricelistId:     number;
  iat?:            number;
  exp?:            number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly odoo: OdooService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string; dealer: Partial<DealerJwtPayload> }> {
    // ── Authenticate dealer against Odoo ──────────────────────────────────────
    // This uses Odoo's own /web/session/authenticate endpoint with the dealer's
    // credentials. The admin OdooService session is NOT used here — we make a
    // direct call to validate the dealer's own Odoo account.
    let odooUid: number;

    try {
      const authResult = await this.odoo.callKw<any>(
        'res.users',
        'authenticate',
        [dto.email, dto.password, {}],
      );
      odooUid = authResult;
    } catch {
      throw new UnauthorizedException('Invalid dealer credentials');
    }

    if (!odooUid) {
      throw new UnauthorizedException('Invalid dealer credentials');
    }

    // ── Fetch the res.partner linked to this user ─────────────────────────────
    const [user] = await this.odoo.searchRead<{ id: number; partner_id: [number, string]; property_product_pricelist: [number, string] }>(
      'res.users',
      [['id', '=', odooUid]],
      ['id', 'partner_id', 'property_product_pricelist'],
    );

    const partnerId   = user.partner_id[0];
    const pricelistId = user.property_product_pricelist?.[0] ?? 1;

    this.logger.log(`Dealer login: partner_id=${partnerId}, pricelist_id=${pricelistId}`);

    // ── Issue JWT ─────────────────────────────────────────────────────────────
    const payload: DealerJwtPayload = {
      sub:           partnerId,
      email:         dto.email,
      odooPartnerId: partnerId,
      pricelistId,
    };

    const accessToken = this.jwt.sign(payload);

    return {
      accessToken,
      dealer: {
        odooPartnerId: partnerId,
        pricelistId,
        email: dto.email,
      },
    };
  }

  async validateJwt(payload: DealerJwtPayload): Promise<DealerJwtPayload> {
    // Passport calls this after verifying the JWT signature.
    // Add any additional checks here (e.g. dealer still active in Odoo).
    return payload;
  }
}
