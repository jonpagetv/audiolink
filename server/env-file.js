const fs = require('node:fs');

// Rewrites a single KEY=VALUE line in a dotenv-style file in place,
// preserving every other line untouched. Used by the password-change
// endpoint (see server/index.js) so a changed password hash survives a
// restart, not just the running process's in-memory copy.
function setEnvValue(filePath, key, value) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = content && !content.endsWith('\n') ? `${content}\n${line}\n` : `${content}${line}\n`;
  }

  fs.writeFileSync(filePath, content);
}

module.exports = { setEnvValue };
