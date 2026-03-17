// ─────────────────────────────────────────────────────────────────────────────
// Application configuration factory
// Loaded once at startup by @nestjs/config.
// All values are pulled from environment variables.
// ─────────────────────────────────────────────────────────────────────────────

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  odoo: {
    baseUrl:  process.env.ODOO_BASE_URL,
    db:       process.env.ODOO_DB,
    login:    process.env.ODOO_ADMIN_LOGIN,
    password: process.env.ODOO_ADMIN_PASSWORD,
  },

  jwt: {
    secret:    process.env.JWT_SECRET ?? 'change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },

  cors: {
    origins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim()),
  },
});
