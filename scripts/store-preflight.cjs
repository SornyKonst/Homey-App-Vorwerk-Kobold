'use strict';

// Static release checks only. This script never authenticates, contacts Homey,
// sends robot commands, executes application code, or reads credential stores.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const excludedDirs = new Set(['.homeybuild', '.git', 'node_modules', '__pycache__']);
const checks = [];
const posix = value => value.split(path.sep).join('/');
const read = file => fs.readFileSync(path.join(appRoot, file), 'utf8').replace(/^\uFEFF/, '');
const json = file => JSON.parse(read(file));

function check(id, work) {
  const errors = [];
  const requireThat = (condition, message) => { if (!condition) errors.push(message); };
  let details;
  try { details = work(requireThat); }
  catch (error) { errors.push(error.code ? `Filesystem or parsing failure: ${error.code}` : 'Invalid or unreadable check input'); }
  checks.push({ id, ok: errors.length === 0, ...(details ? { details } : {}), ...(errors.length ? { errors } : {}) });
}

function walk(relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(appRoot, relative), { withFileTypes: true })) {
    const name = posix(path.join(relative, entry.name));
    if (entry.isDirectory() && !excludedDirs.has(entry.name)) files.push(...walk(name));
    else if (entry.isFile()) files.push(name);
    else if (entry.isSymbolicLink()) throw Object.assign(new Error('Symlinks require manual release review'), { code: 'SYMLINK' });
  }
  return files;
}

function leaves(value, prefix = '', result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) leaves(child, name, result);
    else result[name] = child;
  }
  return result;
}

// Extract balanced calls without evaluating JavaScript or interpolated keys.
function calls(source, pattern) {
  const result = [];
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) { result.push(source.slice(start, index)); break; }
    }
  }
  return result;
}

const stringLiterals = source => [...source.matchAll(/(['"])([^'"\r\n\\]*)\1/g)].map(match => match[2]);
let files = [];
let en = {};
let de = {};
let compose = {};
let packageInfo = {};

check('source_inventory', requireThat => {
  requireThat(fs.statSync(appRoot).isDirectory(), 'Application source directory is missing');
  files = walk();
  requireThat(files.length > 0, 'Application source directory is empty');
  return { files: files.length, ignoredDirectories: [...excludedDirs].sort() };
});

check('locale_leaf_parity', requireThat => {
  en = leaves(json('locales/en.json'));
  de = leaves(json('locales/de.json'));
  for (const key of new Set([...Object.keys(en), ...Object.keys(de)])) {
    requireThat(typeof en[key] === 'string' && en[key].trim().length > 0, `Missing or empty English key: ${key}`);
    requireThat(typeof de[key] === 'string' && de[key].trim().length > 0, `Missing or empty German key: ${key}`);
  }
  return { englishLeaves: Object.keys(en).length, germanLeaves: Object.keys(de).length };
});

check('translation_references', requireThat => {
  const references = new Set();
  const need = key => { references.add(key); requireThat(typeof en[key] === 'string' && typeof de[key] === 'string', `Missing referenced translation: ${key}`); };
  const sources = files.filter(file => !file.startsWith('test/') && /\.(?:js|html)$/.test(file));
  for (const file of sources) {
    for (const argument of calls(read(file), /\b(?:this\.homey|Homey|homey)\.__\s*\(/g)) {
      for (const key of stringLiterals(argument)) if (/^[a-z]+\.[a-z0-9_.]+$/i.test(key)) need(key);
    }
  }
  const settings = read('settings/index.html');
  for (const argument of calls(settings, /\btext\s*\(/g)) {
    // Feature names inside a nested supports(device, 'feature') predicate
    // are not translation keys; both branches of the text choice still are.
    const translatedArgument = argument.replace(/\bsupports\([^()]*\)/g, '');
    for (const key of stringLiterals(translatedArgument)) if (/^[a-z][a-z0-9_]*$/i.test(key) && !key.endsWith('_')) need(`settings.${key}`);
  }
  // Known dynamic settings mappings: field tables, date labels, status/mode
  // choices, weekday numbers, and privacy IDs transformed to locale keys.
  for (const key of stringLiterals(settings)) {
    if (/^(?:data|history|privacy)_[a-z0-9_]+$/.test(key) && !key.endsWith('_')) need(`settings.${key}`);
    if (/^privacy-(?:title|cloud|storage|remove)$/.test(key)) need(`settings.${key.replaceAll('-', '_')}`);
  }
  for (const key of ['eco', 'turbo', 'normal', 'extra_care', 'deep']) need(`settings.data_${key}`);
  for (let day = 0; day <= 6; day += 1) need(`settings.data_day_${day}`);
  const statuses = /var status\s*=\s*(\[[\s\S]*?\])\s*\.includes/.exec(settings);
  requireThat(Boolean(statuses), 'Dynamic history status mapping was not recognized');
  for (const status of [...stringLiterals(statuses?.[1] || ''), 'unknown']) need(`settings.history_status_${status}`);
  for (const file of ['drivers/vr300/pair/login.html', 'drivers/vr300/repair/login.html']) {
    const ids = /(\[[^\]]*\])\.forEach\(function\s*\(id\)/.exec(read(file));
    requireThat(Boolean(ids), `Dynamic pairing labels were not recognized: ${file}`);
    for (const id of stringLiterals(ids?.[1] || '')) need(`pair.${id.replaceAll('-', '_')}`);
  }
  const driverKeys = /const keys\s*=\s*\{([\s\S]*?)\};/.exec(read('drivers/vr300/driver.js'));
  requireThat(Boolean(driverKeys), 'Dynamic pairing error mapping was not recognized');
  for (const key of stringLiterals(driverKeys?.[1] || '')) need(`errors.${key}`);
  const warnings = /const knownWarnings\s*=\s*new Set\((\[[\s\S]*?\])\)/.exec(read('drivers/vr300/device.js'));
  requireThat(Boolean(warnings), 'Dynamic warning mapping was not recognized');
  for (const key of stringLiterals(warnings?.[1] || '')) need(`warnings.${key}`);
  for (const key of ['cleaning', 'paused', 'returning', 'docked', 'charging', 'idle', 'error', 'busy']) need(`status.${key}`);
  return { checkedReferences: references.size, sourceFiles: sources.length };
});

check('manifest_metadata', requireThat => {
  compose = json('.homeycompose/app.json');
  packageInfo = json('package.json');
  requireThat(compose.sdk === 3, 'Homey SDK must be 3');
  requireThat(compose.runtime === 'nodejs', 'Homey runtime must be nodejs');
  requireThat(Array.isArray(compose.permissions) && compose.permissions.length === 0, 'Unexpected Homey permissions');
  requireThat(compose.platforms?.includes('local'), 'Local Homey platform must be declared');
  requireThat(/^>=\d+\.\d+\.\d+$/.test(compose.compatibility || ''), 'Minimum Homey version is missing');
  requireThat(/^>=22(?:\.0\.0)?$/.test(packageInfo.engines?.node || ''), 'Node runtime compatibility must include Node 22');
  requireThat(compose.id === packageInfo.name && compose.version === packageInfo.version, 'Source manifest and package identity/version differ');
  requireThat(/^[a-z][a-z0-9.-]+$/.test(compose.id || '') && /^\d+\.\d+\.\d+$/.test(compose.version || ''), 'Invalid application identity or release version');
  requireThat(typeof compose.author?.name === 'string' && compose.author.name.trim().length > 0, 'Developer name is missing');
  requireThat(typeof compose.category === 'string' && /^#[0-9a-f]{6}$/i.test(compose.brandColor || ''), 'Store category or brand color is missing');
  for (const locale of ['en', 'de']) {
    for (const field of ['name', 'description']) requireThat(typeof compose[field]?.[locale] === 'string' && compose[field][locale].trim(), `Missing Store ${field}: ${locale}`);
    requireThat(Array.isArray(compose.tags?.[locale]) && compose.tags[locale].length > 0, `Missing Store tags: ${locale}`);
  }
  const generated = json('app.json');
  requireThat(generated.id === compose.id && generated.version === compose.version, 'Generated manifest is stale; run official Homey preprocessing');
  requireThat(generated.sdk === 3 && generated.runtime === 'nodejs' && generated.permissions?.length === 0, 'Generated manifest runtime or permissions differ');
  return { version: compose.version, sdk: compose.sdk, runtime: compose.runtime, permissions: compose.permissions };
});

check('flow_localization_and_arguments', requireThat => {
  const cards = [];
  const driver = json('drivers/vr300/driver.flow.compose.json');
  for (const type of ['actions', 'conditions', 'triggers']) for (const card of driver[type] || []) cards.push({ ...card, type });
  for (const file of files.filter(file => /^\.homeycompose\/flow\/(?:actions|conditions|triggers)\/[^/]+\.json$/.test(file))) {
    cards.push({ ...json(file), id: path.basename(file, '.json'), type: file.split('/')[2] });
  }
  const ids = new Set();
  function translations(value, label) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'en') || Object.hasOwn(value, 'de')) {
      for (const locale of ['en', 'de']) requireThat(typeof value[locale] === 'string' && value[locale].trim().length > 0, `Missing ${label}.${locale}`);
    } else for (const [key, child] of Object.entries(value)) {
      if (['title', 'titleFormatted', 'hint', 'label', 'placeholder'].includes(key)) {
        requireThat(child && typeof child === 'object' && !Array.isArray(child), `Expected localized text: ${label}.${key}`);
        for (const locale of ['en', 'de']) requireThat(typeof child?.[locale] === 'string' && child[locale].trim().length > 0, `Missing ${label}.${key}.${locale}`);
      }
      translations(child, `${label}.${key}`);
    }
  }
  for (const card of cards) {
    const label = `${card.type}.${card.id}`;
    requireThat(!ids.has(label), `Duplicate Flow card: ${label}`);
    ids.add(label);
    requireThat(Boolean(card.title), `Missing Flow title: ${label}`);
    translations(card, label);
    const expected = (card.args || []).filter(arg => arg.type !== 'device').map(arg => arg.name).sort();
    if (expected.length) requireThat(Boolean(card.titleFormatted), `Missing formatted Flow title: ${label}`);
    for (const locale of ['en', 'de']) {
      const actual = [...new Set([...(card.titleFormatted?.[locale] || '').matchAll(/\[\[([a-z0-9_]+)\]\]/gi)].map(match => match[1]))].sort();
      requireThat(JSON.stringify(actual) === JSON.stringify(expected), `Formatted Flow arguments differ: ${label}.${locale}`);
    }
  }
  return { cards: cards.length, formattedCards: cards.filter(card => card.titleFormatted).length };
});

check('svg_icons', requireThat => {
  const icons = ['assets/icon.svg', 'drivers/vr300/assets/icon.svg'];
  const hashes = icons.map(file => crypto.createHash('sha256').update(read(file)).digest('hex'));
  requireThat(hashes[0] !== hashes[1], 'App and device icons must be distinct');
  for (const file of files.filter(file => file.endsWith('.svg') && !file.startsWith('test/'))) {
    const svg = read(file);
    requireThat(!/<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed|image|animate\w*|set)\b|\bon[a-z]+\s*=|\burl\s*\(/i.test(svg), `Active or embedded SVG content: ${file}`);
    for (const reference of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(['"])(.*?)\1/gi)) requireThat(reference[2].startsWith('#'), `External SVG reference: ${file}`);
    if (icons.includes(file)) {
      requireThat(/\bwidth=['"]960(?:px)?['"]/.test(svg) && /\bheight=['"]960(?:px)?['"]/.test(svg), `Icon dimensions must be 960 × 960: ${file}`);
      requireThat(/\bviewBox=['"]0\s+0\s+960\s+960['"]/.test(svg), `Icon viewBox must be 960 × 960: ${file}`);
    }
  }
  return { distinctMainIcons: icons.length, svgFiles: files.filter(file => file.endsWith('.svg') && !file.startsWith('test/')).length };
});

check('store_image_dimensions', requireThat => {
  // HomeyLib lib/App/index.js IMAGE_SIZES distinguishes Store banners from
  // square device images; applying banner dimensions to drivers is incorrect.
  const sizes = [
    { small: [250, 175], large: [500, 350], xlarge: [1000, 700] },
    { small: [75, 75], large: [500, 500], xlarge: [1000, 1000] },
  ];
  const images = [];
  for (const [index, owner] of [compose, json('drivers/vr300/driver.compose.json')].entries()) {
    const expected = sizes[index];
    for (const [size, [width, height]] of Object.entries(expected)) {
      const relative = owner.images?.[size];
      requireThat(typeof relative === 'string' && relative.startsWith('/'), `Missing ${size} image path`);
      if (typeof relative !== 'string') continue;
      const file = relative.replace(/^\//, '');
      const bytes = fs.readFileSync(path.join(appRoot, file));
      requireThat(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR', `Invalid PNG image: ${file}`);
      if (bytes.length >= 24) requireThat(bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height, `Wrong ${size} image dimensions: ${file}`);
      images.push({ file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    }
  }
  requireThat(images.length === 6 && new Set(images.map(image => image.file)).size === 6, 'Six distinct Store PNG files are required');
  return { images };
});

check('store_readme_plain_text', requireThat => {
  for (const file of ['README.txt', 'README.de.txt']) {
    const text = read(file).trim();
    requireThat(text.split(/\r?\n\s*\r?\n/).length === 2, `Store README must contain two paragraphs: ${file}`);
    requireThat(!/https?:\/\/|www\.|!\[|\[[^\]]+\]\(|`|\*\*|(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s)/i.test(text), `Store README must be plain text without URLs: ${file}`);
  }
  return { readmes: 2 };
});

check('public_source_privacy', requireThat => {
  // General patterns only: no private installation identifiers belong in this
  // public checker. Synthetic fixture data is scanned too. This is a technical
  // check for obvious private data, not a guarantee that prose contains no PII.
  const patterns = [
    ['literal_private_ipv4', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
    ['personal_workstation_path', /(?<![\w:/}])(?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/i],
    ['private_key_material', /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/],
    ['literal_account_jwt', /['"]eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}['"]/],
  ];
  const scanned = files.filter(file => /\.(?:js|cjs|mjs|json|html|md|txt|svg|ya?ml|ps1|py)$/i.test(file));
  for (const file of scanned) for (const [label, pattern] of patterns) requireThat(!pattern.test(read(file)), `${label}: ${file}`);
  return { scannedFiles: scanned.length, includesTestsAndWorkflows: true };
});

check('credential_and_build_exclusion', requireThat => {
  const forbidden = /(?:^|\/)(?:work|homey-state|homey-tools|\.env(?:\.[^/]*)?|env\.json|\.aws|\.ssh)(?:\/|$)|(?:^|\/)(?:credentials|tokens?|secrets?)\.(?:json|pem|key)$|\.(?:pem|key|p12|pfx)$/i;
  for (const file of files) requireThat(!forbidden.test(file), `Private working or credential file in app source: ${file}`);
  const ignore = read('.homeyignore').split(/\r?\n/).map(line => line.trim());
  for (const entry of ['test/', 'scripts/', '.github/', '.git/', '*.zip']) requireThat(ignore.includes(entry), `Homey package exclusion missing: ${entry}`);
  const gitignore = read('.gitignore').split(/\r?\n/).map(line => line.trim());
  for (const entry of ['.homeybuild/', 'node_modules/', '.env', 'env.json', '*.key', '*.pem']) requireThat(gitignore.includes(entry), `Private or build file Git exclusion missing: ${entry}`);
  const build = path.join(appRoot, '.homeybuild');
  let buildFiles = null;
  if (fs.existsSync(build)) {
    buildFiles = 0;
    const runtimeDirs = new Set(['assets', 'drivers', 'lib', 'locales', 'settings']);
    const runtimeFiles = new Set(['api.js', 'app.js', 'app.json', 'package.json', 'README.txt', 'README.de.txt', 'LICENSE', 'PRIVACY.md', 'CHANGELOG.md']);
    function inspect(directory, relative = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = posix(path.join(relative, entry.name));
        requireThat(!entry.isSymbolicLink(), `Unexpected package symlink: ${name}`);
        requireThat(!forbidden.test(name), `Private file in Homey package: ${name}`);
        const top = name.split('/')[0];
        const sdkStub = name === 'node_modules' || name === 'node_modules/homey' || name.startsWith('node_modules/homey/');
        requireThat(runtimeDirs.has(top) || runtimeFiles.has(name) || sdkStub, `Unexpected Homey package path: ${name}`);
        if (entry.isDirectory()) inspect(path.join(directory, entry.name), name);
        else if (entry.isFile()) {
          buildFiles += 1;
          if (!sdkStub) {
            const original = path.join(appRoot, name);
            requireThat(fs.existsSync(original), `Packaged file has no source: ${name}`);
            if (fs.existsSync(original)) requireThat(fs.readFileSync(original).equals(fs.readFileSync(path.join(build, name))), `Source/build mismatch: ${name}`);
          }
        }
      }
    }
    inspect(build);
    for (const file of ['app.js', 'api.js', 'app.json', 'package.json', 'drivers/vr300/device.js', 'drivers/vr300/driver.js', 'drivers/vr300/pair/login.html', 'drivers/vr300/repair/login.html', 'settings/index.html']) requireThat(fs.existsSync(path.join(build, file)), `Required runtime file missing from package: ${file}`);
  }
  return { sourceCredentialFiles: 0, homeyBuild: buildFiles === null ? 'not_present' : 'checked', buildFiles };
});

const failed = checks.filter(entry => !entry.ok);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, version: compose.version || null,
  checks: checks.length, passed: checks.length - failed.length, results: checks }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
