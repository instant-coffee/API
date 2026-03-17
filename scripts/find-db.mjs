/**
 * find-db.mjs — probe an Odoo instance to discover the correct database name.
 *
 * Usage:
 *   node scripts/find-db.mjs
 *
 * Reads ODOO_BASE_URL from .env (or environment).
 * Tries three approaches in order and prints whatever it finds.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (no external deps needed) ─────────────────────────────
const envPath = resolve(__dirname, '../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {
  console.error('Could not read .env — make sure it exists');
  process.exit(1);
}

const BASE_URL = process.env.ODOO_BASE_URL?.replace(/\/$/, '');

if (!BASE_URL) {
  console.error('ODOO_BASE_URL is not set in .env');
  process.exit(1);
}

console.log(`\nProbing Odoo instance at: ${BASE_URL}\n`);

// ── Helper ────────────────────────────────────────────────────────────────────
async function rpc(endpoint, params) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params }),
  });
  return res.json();
}

// ── Approach 1: /web/database/list ────────────────────────────────────────────
console.log('── Approach 1: /web/database/list');
try {
  const result = await rpc('/web/database/list', {});
  if (result.result?.length) {
    console.log('✅  Databases found:', result.result);
    console.log('\n→  Set ODOO_DB to one of the above in your .env\n');
  } else if (result.error) {
    console.log('   Blocked (expected on SaaS/SH):', result.error.data?.message ?? result.error.message);
  } else {
    console.log('   Returned empty list — database listing is disabled on this instance.');
  }
} catch (e) {
  console.log('   Request failed:', e.message);
}

// ── Approach 2: try the subdomain as DB name ──────────────────────────────────
const subdomainGuess = new URL(BASE_URL).hostname.split('.')[0];
console.log(`\n── Approach 2: try subdomain as DB name ("${subdomainGuess}")`);
try {
  const result = await rpc('/web/session/authenticate', {
    db:       subdomainGuess,
    login:    process.env.ODOO_ADMIN_LOGIN,
    password: process.env.ODOO_ADMIN_PASSWORD,
  });

  if (result.result?.uid) {
    console.log(`✅  SUCCESS — DB name is: "${subdomainGuess}"`);
    console.log(`   uid: ${result.result.uid}, user: ${result.result.name}`);
    console.log(`\n→  Set ODOO_DB=${subdomainGuess} in your .env\n`);
  } else {
    console.log('   Auth failed:', result.error?.data?.message ?? JSON.stringify(result.error ?? result.result));
  }
} catch (e) {
  console.log('   Request failed:', e.message);
}

// ── Approach 3: try with empty db (some Odoo SH configs allow this) ───────────
console.log('\n── Approach 3: try empty db string');
try {
  const result = await rpc('/web/session/authenticate', {
    db:       '',
    login:    process.env.ODOO_ADMIN_LOGIN,
    password: process.env.ODOO_ADMIN_PASSWORD,
  });

  if (result.result?.uid) {
    console.log('✅  SUCCESS with empty db string');
    console.log(`   Session db: ${result.result.db}`);
    console.log(`\n→  Set ODOO_DB=${result.result.db} in your .env\n`);
  } else {
    const msg = result.error?.data?.message ?? JSON.stringify(result.result);
    // Sometimes the error message contains the actual db name
    console.log('   Response:', msg);
  }
} catch (e) {
  console.log('   Request failed:', e.message);
}

console.log('\n── Done. If all three failed, use the DevTools method:');
console.log(`   1. Open ${BASE_URL} in Chrome`);
console.log('   2. DevTools → Network → log in → find POST /web/session/authenticate');
console.log('   3. Check the Payload tab for the "db" field\n');
