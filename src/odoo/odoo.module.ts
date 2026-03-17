import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { OdooService } from './odoo.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 15000,
      maxRedirects: 3,
    }),
  ],
  providers: [OdooService],
  exports:   [OdooService],   // ← every feature module imports OdooModule to get this
})
export class OdooModule {}
