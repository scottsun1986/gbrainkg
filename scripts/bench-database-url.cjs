#!/usr/bin/env node
/**
 * Print the application database URL with ?schema=<arg> applied, so benchmark
 * tooling can point at an isolated schema without hardcoding credentials.
 *
 *   node scripts/bench-database-url.cjs scale_bench
 */
const fs = require('node:fs');
const path = require('node:path');

const schema = process.argv[2];
if (!schema || !/^[a-z_][a-z0-9_]*$/i.test(schema) || schema === 'public') {
  console.error('Refusing to build a URL for a non-dedicated schema.');
  process.exit(2);
}

let url = process.env.DATABASE_URL || '';
if (!url) {
  for (const file of ['.env', 'apps/api/.env']) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      const match = content.match(/^DATABASE_URL=(.+)$/m);
      if (match) {
        url = match[1].trim().replace(/^["']|["']$/g, '');
        break;
      }
    } catch {
      // keep looking
    }
  }
}
if (!url) {
  console.error('DATABASE_URL is not set and no .env file provided one.');
  process.exit(2);
}
const parsed = new URL(url);
parsed.searchParams.set('schema', schema);
process.stdout.write(parsed.toString());
