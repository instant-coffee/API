import { Module } from '@nestjs/common';
import { OdooModule } from '../odoo/odoo.module';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  imports:     [OdooModule],
  providers:   [ProductsService],
  controllers: [ProductsController],
  exports:     [ProductsService],
})
export class ProductsModule {}
