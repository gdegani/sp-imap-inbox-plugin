#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORKER_DIST = path.join(ROOT, 'dist-worker');
const WORKER_SCRIPT = path.join(WORKER_DIST, 'host-script.js');
const MANIFEST = path.join(ROOT, 'src', 'manifest.json');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const fail = (message) => {
  console.error(`release-check failed: ${message}`);
  process.exit(1);
};

const ensureFile = (file, label) => {
  if (!fs.existsSync(file)) {
    fail(`${label} is missing: ${path.relative(ROOT, file)}`);
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Could not parse ${path.relative(ROOT, file)}: ${error.message}`);
  }
};

try {
  ensureFile(MANIFEST, 'manifest');
  ensureFile(PACKAGE_JSON, 'package.json');

  const manifest = readJson(MANIFEST);
  const pkg = readJson(PACKAGE_JSON);

  if (!manifest.homepage || !manifest.homepage.includes('github.com/')) {
    fail('manifest.homepage must point to the plugin GitHub repository');
  }

  if (!manifest.author || manifest.author.trim() === 'Super Productivity') {
    fail('manifest.author should identify the plugin maintainer/repo owner, not the app project');
  }

  if (pkg.name !== 'imap-inbox-plugin') {
    fail('package.json name should match the published plugin repository identity');
  }

  const script = fs.readFileSync(WORKER_SCRIPT, 'utf8');
  if (!script.includes('require("tls")')) {
    fail('host-script.js must keep the literal require("tls") for host spawn routing');
  }

  const hostPattern = /require\s*\(\s*['"`](?!fs|path|os)[^'"]+['"`]\s*\)|child_process|exec|spawn|eval|Function|process\.exit/;
  if (!hostPattern.test(script)) {
    fail('host-script.js must still match the host spawn-path guard');
  }

  if (script.length >= 100_000) {
    fail(`host-script.js is too large for the host: ${script.length} bytes >= 100,000`);
  }

  ensureFile(path.join(DIST, 'plugin.js'), 'dist/plugin.js');
  ensureFile(path.join(DIST, 'manifest.json'), 'dist/manifest.json');
  ensureFile(path.join(DIST, 'index.html'), 'dist/index.html');
  ensureFile(path.join(DIST, 'icon.svg'), 'dist/icon.svg');

  console.log('release-check passed');
  console.log(`  manifest homepage: ${manifest.homepage}`);
  console.log(`  worker script size: ${script.length} bytes`);
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
