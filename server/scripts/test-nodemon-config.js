import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const ignore = packageJson.nodemonConfig?.ignore;

assert.ok(Array.isArray(ignore), 'nodemonConfig.ignore must be an array');
assert.ok(ignore.includes('data/**'), 'runtime data directory must be ignored');
assert.ok(ignore.includes('**/*.sqlite'), 'SQLite database files must be ignored');
assert.ok(ignore.includes('**/*.db-*'), 'SQLite database sidecars must be ignored');
assert.equal(packageJson.scripts.dev, 'nodemon index.js');
assert.equal(packageJson.scripts.start, 'node index.js');

console.log('nodemon config tests passed');
