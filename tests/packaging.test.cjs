const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { applyPatch, reversePatch, parsePatch } = require('diff');
const yauzl = require('yauzl'); // Archive reader already supplied by VSCE.

function readArchiveFile(filename, wanted) {
	return new Promise((resolve, reject) => {
		yauzl.open(filename, { lazyEntries: true }, (error, archive) => {
			if (error) return reject(error);
			archive.on('error', reject);
			archive.on('end', () => reject(new Error('Packaged lexer missing')));
			archive.on('entry', (entry) => {
				if (entry.fileName !== wanted) return archive.readEntry();
				archive.openReadStream(entry, (streamError, stream) => {
					if (streamError) { archive.close(); return reject(streamError); }
					const chunks = [];
					stream.on('error', reject);
					stream.on('data', (chunk) => chunks.push(chunk));
					stream.on('end', () => { archive.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
				});
			});
			archive.readEntry();
		});
	});
}

test('Compile and real VSIX packaging repair an install with lifecycle scripts bypassed', { timeout: 120000 }, async () => {
	const root = path.resolve(__dirname, '..');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfui-package-'));
	const sha256 = (value) => createHash('sha256').update(value).digest('hex');
	try {
		for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', '.vscodeignore', 'README.md', 'CHANGELOG.md', 'src', 'tools', 'patches', 'assets', 'changelog']) {
			fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
		}
		const modules = path.join(dir, 'node_modules');
		// Private copies avoid shared dependency writes and preserve npm/VSCE's real dependency tree.
		fs.cpSync(path.join(root, 'node_modules'), modules, {
			recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
		});
		const lexer = path.join(modules, 'shlex', 'shlex.js');
		const patched = fs.readFileSync(lexer, 'utf8');
		const original = applyPatch(patched, reversePatch(parsePatch(fs.readFileSync(path.join(dir, 'patches/shlex+2.1.2.patch'), 'utf8'))[0]));
		assert.equal(typeof original, 'string');
		assert.equal(sha256(original), 'feb7b57108ffb5cf04ca4f667eec24585c783f827887394a2f8c9bc4bca779c3');
		const env = { ...process.env, npm_config_ignore_scripts: 'true' };
		fs.writeFileSync(lexer, original);
		execFileSync('npm', ['run', 'compile'], { cwd: dir, env, stdio: 'pipe' });
		assert.equal(sha256(fs.readFileSync(lexer)), 'cdde5f5e8976d9c2354b1154ecf5646c5f301a8ba5b7b0e26f9244abe21c3fed');
		// Bypass installation again: actual VSCE packaging must invoke the guarded compile itself.
		fs.writeFileSync(lexer, original);
		const vsix = path.join(dir, 'regression.vsix');
		execFileSync('npm', ['run', 'vscode:package', '--', '--out', vsix], { cwd: dir, env, stdio: 'pipe' });
		const packaged = await readArchiveFile(vsix, 'extension/node_modules/shlex/shlex.js');
		assert.equal(sha256(packaged), 'cdde5f5e8976d9c2354b1154ecf5646c5f301a8ba5b7b0e26f9244abe21c3fed');
		fs.writeFileSync(lexer, packaged);
		fs.writeFileSync(path.join(dir, 'out/initArguments.js'), await readArchiveFile(vsix, 'extension/out/initArguments.js'));
		const { parseInitArguments, formatInitArguments } = require(path.join(dir, 'out', 'initArguments'));
		const args = [String.raw`-backend-config=\\server\share\it's.tfvars`, String.raw`literal\n` + '\n', String.raw`literal\r` + '\r\n'];
		assert.deepEqual(parseInitArguments(formatInitArguments(args)), args);
		const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts;
		assert.equal(scripts['vscode:prepublish'], 'npm run compile');
		for (const name of ['vsce:publish', 'ovsx:publish']) assert.match(scripts[name], /^npm run compile && /);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
