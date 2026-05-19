const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'walter_memory.json');
const DEFAULT     = { apps: {}, youtube_channels: {}, sites: {}, facts: {}, path_scans: {}, macros: {} };

function load() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return { ...DEFAULT }; }
}

function save(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function get(namespace, key) {
  const ns = (load()[namespace]) || {};
  return ns[key.toLowerCase()] ?? null;
}

function set(namespace, key, value) {
  const data = load();
  if (!data[namespace]) data[namespace] = {};
  data[namespace][key.toLowerCase()] = value;
  save(data);
}

// Fuzzy: finds the first key that contains `partial` or is contained by it.
function search(namespace, partial) {
  const ns   = (load()[namespace]) || {};
  const q    = partial.toLowerCase();
  const hit  = Object.keys(ns).find(k => k.includes(q) || q.includes(k));
  return hit ? ns[hit] : null;
}

function getAll(namespace) {
  return (load()[namespace]) || {};
}

module.exports = { get, set, search, getAll };
