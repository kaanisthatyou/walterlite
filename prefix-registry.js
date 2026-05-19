const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'prefixes.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Strip the comment key
    const { _comment, ...prefixes } = data;
    return prefixes;
  } catch { return {}; }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function get(name) {
  if (!name) return null;
  return load()[name.toUpperCase()] || null;
}

function list() {
  return Object.keys(load());
}

function set(name, config) {
  const data = load();
  data[name.toUpperCase()] = config;
  save(data);
}

function remove(name) {
  const data = load();
  delete data[name.toUpperCase()];
  save(data);
}

// Add or replace a macro within a prefix.
function setMacro(prefixName, macro) {
  const data = load();
  const key  = prefixName.toUpperCase();
  if (!data[key]) data[key] = { label: key, macros: [] };
  const idx = data[key].macros.findIndex(m => m.id === macro.id);
  if (idx >= 0) data[key].macros[idx] = macro;
  else data[key].macros.push(macro);
  save(data);
}

module.exports = { get, list, set, remove, setMacro };
