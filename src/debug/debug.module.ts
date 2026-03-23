import { Module } from "@nestjs/common";
import { OdooModule } from "../odoo/odoo.module";
import { DebugController } from "./debug.controller";

@Module({
  imports: [OdooModule],
  controllers: [DebugController],
})
export class DebugModule {}
