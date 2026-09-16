#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const ZIP_PATH = path.join(DIST_DIR, 'plugin.zip');

// Settings → Plugins → Choose Plugin File expects manifest.json at the zip
// root alongside the other runtime files (see the app's plugin dev docs).
const FILES = ['manifest.json', 'plugin.js', 'index.html', 'icon.svg'];

const main = () => {
  const missing = FILES.filter((file) => !fs.existsSync(path.join(DIST_DIR, file)));
  if (missing.length) {
    throw new Error(
      `dist/ is missing required file(s): ${missing.join(', ')}. Run "npm run build" first.`,
    );
  }

  fs.rmSync(ZIP_PATH, { force: true });
  execFileSync('zip', ['-j', ZIP_PATH, ...FILES.map((file) => path.join(DIST_DIR, file))], {
    stdio: 'inherit',
  });

  const { size } = fs.statSync(ZIP_PATH);
  console.log(`Wrote ${path.relative(ROOT_DIR, ZIP_PATH)} (${(size / 1024).toFixed(1)} KB)`);
};

main();
