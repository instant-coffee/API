import { Injectable, ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * Optional JWT guard — attaches req.user if a valid token is present,
 * but does NOT block the request if no token is provided.
 *
 * Used on the cart endpoint so guest and dealer checkouts share one route.
 */
@Injectable()
export class OptionalJwtGuard extends AuthGuard("jwt") {
  handleRequest(err: any, user: any) {
    // Return user if authenticated, null if not — never throw
    return user ?? null;
  }

  canActivate(context: ExecutionContext) {
    // Always allow; super.canActivate just attaches the user if token is valid
    return super.canActivate(context);
  }
}
