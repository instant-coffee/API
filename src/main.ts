import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app    = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // ── Global validation pipe ────────────────────────────────────────────────
  // Validates all incoming request bodies against their DTO class-validator rules.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:        true,   // strip unknown properties
      forbidNonWhitelisted: false,
      transform:        true,   // auto-transform payloads to DTO instances
    }),
  );

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Nuxt dev server runs on a different port — open CORS in development.
  // In production, restrict to your actual frontend domains.
  app.enableCors({
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim())
      : true,
    credentials: true,
  });

  // ── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`NOBL API running on http://localhost:${port}/api/v1`);
}

bootstrap();
