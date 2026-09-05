const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_FILE = path.join(__dirname, 'data', 'links.json');

// No functional reason a name needs to be longer than this — bounds the
// registry file and keeps a hostile/careless name from blowing out table
// layout in the Studio/Admin UI (both just render it as plain text).
const MAX_NAME_LENGTH = 100;

// A Link's id doubles as its unguessable token (crypto.randomUUID() — ~122
// bits, not brute-forceable at any rate the existing per-IP rate limiter
// would let through). Hard-deleted, not soft: once removed it behaves
// identically to "never existed" for lookup purposes, per the requirement
// that a deleted/bad token fails the same safe way either way. A separate
// audit log (Stage 5) is the place for delete history, not this registry.
function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function saveLinks(links) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
}

function publicView(link) {
  return { id: link.id, name: link.name, createdAt: link.createdAt };
}

function createLinkRegistry() {
  let links = loadLinks();

  function list() {
    return links.map(publicView);
  }

  function get(id) {
    return links.find((link) => link.id === id) || null;
  }

  function create(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      return { error: 'name is required' };
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return { error: `name must be ${MAX_NAME_LENGTH} characters or fewer` };
    }
    if (links.some((link) => link.name.toLowerCase() === trimmed.toLowerCase())) {
      return { error: 'name already in use' };
    }

    const link = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now() };
    links.push(link);
    saveLinks(links);
    return { link: publicView(link) };
  }

  function remove(id) {
    const before = links.length;
    links = links.filter((link) => link.id !== id);
    if (links.length === before) return false;
    saveLinks(links);
    return true;
  }

  return { list, get, create, remove };
}

module.exports = { createLinkRegistry };
