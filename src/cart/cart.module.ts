import { Module } from "@nestjs/common";
import { OdooModule } from "../odoo/odoo.module";
import { CartService } from "./cart.service";
import { CartController } from "./cart.controller";

@Module({
  imports: [OdooModule],
  providers: [CartService],
  controllers: [CartController],
})
export class CartModule {}
