import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { OdooModule } from "../odoo/odoo.module";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./guards/jwt.strategy";
import { OptionalJwtGuard } from "./guards/optional-jwt.guard";

@Module({
  imports: [
    OdooModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("jwt.secret"),
        signOptions: { expiresIn: config.get("jwt.expiresIn", "8h") },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, OptionalJwtGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
