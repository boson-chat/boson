#!/usr/bin/env node
// Syncs a new version string into every package.json in this repo (the
// client and packages/*). Called by semantic-release's @semantic-release/exec
// hook during the `prepare` step — the @semantic-release/git plugin then
// commits + pushes the changes alongside the tag.
//
// Usage: node scripts/sync-version.cjs <version>
//
// The backend (boson-chat/backend) and the website (boson-chat/website)
// have their own repos and release cadence.

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Usage: sync-version.cjs <version>');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const explicit = [
  'package.json',
  'client/package.json',
];

const targets = [...explicit];
const packagesDir = path.join(repoRoot, 'packages');
if (fs.existsSync(packagesDir)) {
  for (const entry of fs.readdirSync(packagesDir)) {
    const candidate = path.join('packages', entry, 'package.json');
    if (fs.existsSync(path.join(repoRoot, candidate))) {
      targets.push(candidate);
    }
  }
}

for (const target of targets) {
  const fullPath = path.join(repoRoot, target);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.version = version;
  // Preserve the file's trailing newline convention (most package.jsons
  // ship with one). JSON.stringify gives us two-space indent to match
  // npm's default formatter.
  fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`synced ${target} → ${version}`);
}
