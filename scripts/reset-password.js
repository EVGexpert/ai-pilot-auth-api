// Usage: node --experimental-sqlite scripts/reset-password.js <email> <new-password>
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const email = process.argv[2];
const newPassword = process.argv[3];

if (!email || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <email> <password>');
  process.exit(1);
}

const DB_PATH = process.env.DATABASE_PATH || '/app/data/aipilot.db';
const db = new DatabaseSync(DB_PATH);

const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`User "${email}" not found!`);
  console.log('Available users:');
  const users = db.prepare('SELECT email FROM users').all();
  for (const u of users) console.log(`  - ${u.email}`);
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);
console.log(`✅ Password reset for ${email}: ${result.changes} row(s) updated`);
db.close();
