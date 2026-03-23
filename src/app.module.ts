import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { OdooModule } from "./odoo/odoo.module";
import { ProductsModule } from "./products/products.module";
import { CartModule } from "./cart/cart.module";
import { AuthModule } from "./auth/auth.module";
import { DebugModule } from "./debug/debug.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // no need to import ConfigModule in every feature module
      load: [configuration],
      envFilePath: ".env",
    }),
    OdooModule,
    ProductsModule,
    CartModule,
    AuthModule,
    DebugModule,
  ],
})
export class AppModule {}
