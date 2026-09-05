#!/usr/bin/env node
// Generates a hash for STUDIO_PASSWORD_HASH / ADMIN_PASSWORD_HASH in
// server/.env. Usage: node hash-password.js '<password>'
const { hashPassword, passwordComplexityError } = require('./auth');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash-password.js <password>');
  process.exit(1);
}

// Same rule POST /api/admin/password enforces for later changes — a
// password set here at install time shouldn't be held to a lower bar
// just because it went through the CLI instead of the UI.
const complexityError = passwordComplexityError(password);
if (complexityError) {
  console.error(complexityError);
  process.exit(1);
}

console.log(hashPassword(password));
