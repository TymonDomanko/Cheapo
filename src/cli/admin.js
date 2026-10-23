#!/usr/bin/env node
// Make an existing account an admin (or remove admin with --remove).
//   npm run admin -- you@example.com
import { getDb } from '../db.js';

const email = process.argv.slice(2).find((a) => !a.startsWith('--'));
const remove = process.argv.includes('--remove');
if (!email) {
  console.error('Usage: npm run admin -- <email> [--remove]');
  process.exit(1);
}
const r = getDb().prepare('UPDATE users SET is_admin = ? WHERE email = ?').run(remove ? 0 : 1, email);
if (!r.changes) {
  console.error(`No account with email ${email}. Sign up on the site first.`);
  process.exit(1);
}
console.log(`${email} is ${remove ? 'no longer' : 'now'} an admin.`);
