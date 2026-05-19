const memory = require('../memory');

// recall("youtube_channels:imorr") → stored value or null
// recall("apps:obsidian")          → stored exe path or null
// recall("sites:sahibinden")       → stored URL or null
async function recall({ key }) {
  if (!key || typeof key !== 'string') return null;
  const colon = key.indexOf(':');
  if (colon === -1) return memory.search('facts', key);
  const namespace = key.slice(0, colon);
  const name      = key.slice(colon + 1);
  return memory.get(namespace, name) ?? memory.search(namespace, name) ?? null;
}

// learn("youtube_channels:imorr", "https://youtube.com/@Imorr") → saves and confirms
// Silently ignores empty/null values so failed upstream steps don't corrupt memory.
async function learn({ key, value }) {
  if (!key || !value || value === 'null') return null;
  const colon = key.indexOf(':');
  if (colon === -1) {
    memory.set('facts', key, value);
  } else {
    memory.set(key.slice(0, colon), key.slice(colon + 1), value);
  }
  return `Learned: ${key} = ${value}`;
}

module.exports = { recall, learn };
