// Apply the static upstream lexer correction, never a replacement argument parser.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { applyPatch } = require('diff');

const version = JSON.parse(fs.readFileSync(require.resolve('shlex/package.json'), 'utf8')).version;
if (version !== '2.1.2') throw new Error('Review the Init lexer patch before changing shlex versions.');
const filename = require.resolve('shlex');
const source = fs.readFileSync(filename, 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const originalHash = 'feb7b57108ffb5cf04ca4f667eec24585c783f827887394a2f8c9bc4bca779c3';
const patchedHash = 'cdde5f5e8976d9c2354b1154ecf5646c5f301a8ba5b7b0e26f9244abe21c3fed';

if (sha256(source) !== patchedHash) {
	if (sha256(source) !== originalHash) throw new Error('Unexpected shlex source; refusing to apply Init lexer patch.');
	const patch = fs.readFileSync(path.join(__dirname, '..', 'patches', 'shlex+2.1.2.patch'), 'utf8');
	const result = applyPatch(source, patch);
	if (typeof result !== 'string' || sha256(result) !== patchedHash) {
		throw new Error('Init lexer patch integrity check failed.');
	}
	fs.writeFileSync(filename, result);
}
console.log('Verified shlex 2.1.2 quoted-fragment escape patch.');
