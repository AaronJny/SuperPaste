import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Linux installers declare xdotool and AppImage instructions identify the runtime prerequisite', () => {
  const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
  assert.ok(config.bundle.linux.deb.depends.includes('xdotool'));
  assert.ok(config.bundle.linux.rpm.depends.includes('xdotool'));
  for (const name of ['README.md', 'README.zh-CN.md']) assert.match(read(`../${name}`), /AppImage[\s\S]*xdotool/);
});

test('tooling uses the patched Node line consistently', () => {
  const pkg = JSON.parse(read('../package.json'));
  const lock = JSON.parse(read('../package-lock.json'));
  assert.equal(read('../.nvmrc').trim(), '24.22.1');
  assert.equal(pkg.engines.node, '>=24.22.1 <25');
  assert.deepEqual(pkg.engines, lock.packages[''].engines);
  assert.match(read('../.github/workflows/release.yml'), /node-version: '24\.22\.1'/);
  assert.match(read('../.github/workflows/release.yml'), /run: npm test/);
});

test('Rust package and lockfile identify the same application version', () => {
  const version = read('../src-tauri/Cargo.toml').match(/\[package\][\s\S]*?version = "([^"]+)"/)[1];
  const lockVersion = read('../src-tauri/Cargo.lock').match(/name = "super-paste"\nversion = "([^"]+)"/)[1];
  assert.equal(version, lockVersion);
});


test('pull-request CI covers three desktop platforms without publishing', () => {
  const workflow = read('../.github/workflows/ci.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /ubuntu-22\.04, windows-latest, macos-latest/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /run: npm run test:rust/);
  assert.match(workflow, /cargo build --locked/);
  assert.doesNotMatch(workflow, /action-gh-release|upload-artifact|git push|contents: write/);
});
