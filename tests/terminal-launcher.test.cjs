const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadWithMocks } = require('./helpers.cjs');
const { openExternalUri, handlerUri } = require('./fixtures/remote-cli-transform.cjs');

function uri(parts) {
	return { scheme: 'file', authority: '', path: '', query: '', fragment: '', ...parts,
		get fsPath() { return this.path; }, with(change) { return uri({ ...this, ...change }); } };
}

function fixture(directory, options = {}) {
	const commands = new Map();
	const mutations = new Map();
	const messages = [];
	const opened = [];
	const state = { trusted: true, ...options };
	const folders = (options.roots || ['/first', '/second']).map(root => ({ uri: uri({ path: root,
		scheme: options.workspaceScheme || 'file', authority: options.authority || '' }) }));
	const collection = {
		clear() { mutations.clear(); },
		replace(name, value, config) { mutations.set(name, { value, config, kind: 'replace' }); },
		prepend(name, value, config) { mutations.set(name, { value, config, kind: 'prepend' }); },
	};
	const vscode = {
		UIKind: { Desktop: 1 },
		env: { uiKind: options.web ? 2 : 1, uriScheme: options.uriScheme || 'vscode', remoteName: options.remote ? 'ssh-remote' : undefined },
		Uri: { joinPath: (base, ...parts) => uri({ ...base, path: path.join(base.path, ...parts) }) },
		FileType: { Directory: 2 },
		RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; } },
		window: {
			showWarningMessage: async (message, modal) => {
				messages.push(message);
				if (modal && options.revokeOnConsent) state.trusted = false;
				return modal && !options.cancel ? 'Enable launchers' : undefined;
			},
			showInformationMessage: async message => messages.push(message),
			showErrorMessage: async message => messages.push(message),
		},
		workspace: {
			get isTrusted() { return state.trusted; }, workspaceFolders: folders,
			getWorkspaceFolder(target) {
				if (state.foreignHost) return { uri: uri({ ...target, authority: 'ssh-remote+foreign' }) };
				return folders.find(f => target.scheme === f.uri.scheme && target.authority === f.uri.authority &&
					(target.path === f.uri.path || target.path.startsWith(f.uri.path + '/')));
			},
			fs: { stat: async () => {
				if (state.statError) throw new Error('private details');
				return { type: state.file ? 1 : 2 };
			} },
			findFiles: async pattern => {
				assert.equal(pattern.pattern, '*.tf');
				if (state.revokeOnSearch) state.trusted = false;
				if (state.searchError) throw new Error('private details');
				return state.noTerraform ? [] : [uri({ path: pattern.base.path + '/main.tf' })];
			},
		},
	};
	const terminal = loadWithMocks('../out/terminal', { vscode });
	const { registerTerminalLauncher, installTerminalLaunchers } = loadWithMocks('../out/terminalLauncher', { vscode, './terminal': terminal });
	const context = {
		extension: { id: options.extensionId || 'signageos.terraform-ui' },
		globalStorageUri: uri({ path: directory, scheme: options.storageScheme || 'file' }),
		extensionUri: uri({ path: path.resolve(__dirname, '..') }), environmentVariableCollection: collection,
	};
	const launcher = registerTerminalLauncher(context, async target => opened.push(target));
	return { launcher, installTerminalLaunchers, state, context, collection, mutations, messages, opened, vscode,
		enable: () => commands.get('terraformUI.enableTerminalLauncher')(),
		request(cwd = '/second/nested') {
			const base = new URL(mutations.get('TFUI_URL').value);
			return uri({ scheme: base.protocol.slice(0, -1), authority: base.host, path: base.pathname,
				query: base.search.slice(1) + '&cwd=' + Buffer.from(cwd).toString('base64url') });
		},
	};
}

async function temporary(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tfui-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

function environment(f) {
	const env = { ...process.env };
	for (const [name, entry] of f.mutations) env[name] = entry.kind === 'prepend' ? entry.value + (env[name] || '') : entry.value;
	return env;
}

test('real POSIX helpers preserve literal cwd and argv through desktop CLI and remote URL transformation', async t => {
	const root = await temporary(t);
	const storage = path.join(root, 'storage "quotes" \' $HOME; `no`');
	const cwd = path.join(root, 'cwd space " \' $HOME; $(no) & %?#é\nsecond line');
	await fs.mkdir(cwd);
	const stubBin = path.join(root, 'cli');
	await fs.mkdir(stubBin);
	const record = path.join(root, 'record.json');
	const extension = path.join(root, 'extension \' \" $HOME; $(no)');
	await fs.mkdir(path.join(extension, 'out'), { recursive: true });
	await fs.copyFile(path.resolve(__dirname, '../out/terminalLauncherProcess.js'), path.join(extension, 'out/terminalLauncherProcess.js'));
	const runtime = path.join(root, 'runtime \' \" $HOME; $(no)');
	await fs.symlink(process.execPath, runtime);
	const stub = '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.RECORD, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), electron: process.env.ELECTRON_RUN_AS_NODE })); process.exit(Number(process.env.CLI_EXIT || 0));\n';
	for (const name of ['code', 'code-insiders']) await fs.writeFile(path.join(stubBin, name), stub, { mode: 0o700 });
	for (const uriScheme of ['vscode', 'vscode-insiders']) {
	for (const remote of [undefined, 'ssh-remote+dev']) {
		const f = fixture(storage, { uriScheme, roots: [root], remote });
		f.context.extensionUri = uri({ path: extension });
		assert.equal(f.mutations.size, 0);
		assert.equal(f.collection.persistent, false);
		await f.enable();
		for (const entry of f.mutations.values()) assert.deepEqual(entry.config, { applyAtProcessCreation: true, applyAtShellIntegration: false });
		const env = environment(f);
		env.PATH = f.mutations.get('PATH').value + stubBin + path.delimiter + process.env.PATH;
		env.RECORD = record;
		env.TFUI_RUNTIME = runtime;
		for (const name of ['tfui', 'terraform-ui']) {
			const execution = spawnSync('/bin/sh', ['-c', name + ' ignored-user-argument'], { cwd, env, encoding: 'utf8' });
			assert.equal(execution.status, 0, execution.stderr);
			const result = JSON.parse(await fs.readFile(record, 'utf8'));
			assert.equal(result.cwd, cwd);
			assert.equal(result.electron, undefined);
			assert.deepEqual(result.args, [remote ? '--openExternal' : '--open-url', f.mutations.get('TFUI_URL').value + '&cwd=' + Buffer.from(cwd).toString('base64url')]);
			const location = result.args[1];
			if (remote) {
				for (const version of ['1.93.0', '1.95.3']) {
					const broken = openExternalUri(version, location, cwd);
					assert.match(broken, /^file:\/\//);
					assert.ok(new URL(broken).pathname.includes(`/${uriScheme}:/`));
					const count = f.opened.length;
					await f.launcher.handleUri(handlerUri(broken));
					assert.equal(f.opened.length, count);
				}
				assert.equal(openExternalUri('1.96.0', location, cwd), location);
			}
			const delivered = remote ? openExternalUri('1.96.0', location, cwd) : location;
			const count = f.opened.length;
			await f.launcher.handleUri(handlerUri(delivered));
			assert.equal(f.opened.length, count + 1);
			assert.equal(f.opened.at(-1).fsPath, cwd);
			assert.equal((await fs.stat(path.join(storage, 'terminal-bin', name))).mode & 0o777, 0o700);
		}
		env.CLI_EXIT = '17';
		assert.equal(spawnSync('/bin/sh', ['-c', 'tfui'], { cwd, env }).status, 17);
		delete env.CLI_EXIT;
		env.PATH = f.mutations.get('PATH').value;
		const missing = spawnSync('/bin/sh', ['-c', 'tfui'], { cwd, env, encoding: 'utf8' });
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /Ensure its code\/code-insiders CLI/);
		env.TFUI_OPEN_ARG = '--exec';
		assert.match(spawnSync('/bin/sh', ['-c', 'tfui'], { cwd, env, encoding: 'utf8' }).stderr, /Enable it again/);
		env.TFUI_OPEN_ARG = remote ? '--openExternal' : '--open-url';
		env.TFUI_URL = 'invalid';
		assert.match(spawnSync('/bin/sh', ['-c', 'tfui'], { cwd, env, encoding: 'utf8' }).stderr, /Enable it again/);
		f.launcher.dispose();
		assert.equal(f.mutations.size, 0);
	}
	}
});

test('actual desktop vscode-userdata storage enables both typed launchers only on a local native host', async t => {
	const directory = path.join(await temporary(t), 'profile with spaces', 'User', 'globalStorage', 'signageos.terraform-ui');
	const local = fixture(directory, { storageScheme: 'vscode-userdata' });
	await local.enable();
	assert.equal(local.messages.some(message => message.includes('NEW integrated terminal')), true);
	for (const name of ['tfui', 'terraform-ui']) assert.equal((await fs.stat(path.join(directory, 'terminal-bin', name))).mode & 0o777, 0o700);
	assert.equal(local.mutations.get('PATH').value, path.join(directory, 'terminal-bin') + path.delimiter);
	for (const options of [{ remote: true }, { web: true }]) {
		const f = fixture(path.join(await temporary(t), 'absent'), { storageScheme: 'vscode-userdata', ...options });
		await f.enable();
		assert.equal(f.mutations.size, 0);
		await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath));
	}
});

test('URI route selects current cwd in the second root without shell integration or active terminal', async t => {
	const f = fixture(await temporary(t));
	await f.enable();
	await f.launcher.handleUri(f.request('/second/nested "quoted"/$HOME; stuff'));
	assert.equal(f.opened[0].path, '/second/nested "quoted"/$HOME; stuff');
	assert.equal(f.opened[0].scheme, 'file');
	assert.equal(f.opened[0].authority, '');
});

test('remote workspace host uses transformed file URIs, not UI-side vscode-remote URIs', async t => {
	const f = fixture(await temporary(t), { remote: 'ssh-remote+dev' });
	await f.enable();
	await f.launcher.handleUri(f.request());
	assert.equal(f.opened[0].scheme, 'file');
	assert.equal(f.opened[0].authority, '');
	assert.equal(f.opened[0].path, '/second/nested');
	const uiHost = fixture(await temporary(t), { remote: 'ssh-remote+dev', workspaceScheme: 'vscode-remote', authority: 'ssh-remote+dev' });
	await uiHost.enable();
	await uiHost.launcher.handleUri(uiHost.request());
	assert.deepEqual(uiHost.opened, []);
});

test('URI route rejects malformed routes, token/cwd encoding, foreign origins and non-workspace paths', async t => {
	const f = fixture(await temporary(t));
	await f.enable();
	const valid = f.request();
	for (const change of [
		{ scheme: 'https' }, { authority: 'other.extension' }, { path: '/terminal' }, { fragment: 'x' },
		{ query: valid.query.replace(/token=[^&]+/, 'token=' + '0'.repeat(64)) },
		{ query: valid.query + '&cwd=duplicate' }, { query: valid.query + '&authority=evil' },
		{ query: valid.query.replace('cwd=', 'cwd=%2F') }, { query: valid.query + 'A'.repeat(65536) }, { query: valid.query + '=' },
		{ query: valid.query.replace(/cwd=.*/, 'cwd=_w') },
		{ query: valid.query.replace(/cwd=.*/, 'cwd=L3NlY29uZB') },
	]) await f.launcher.handleUri({ ...valid, ...change });
	for (const cwd of ['', 'relative', '/second/../first', '/second/./nested', '/second//nested', '/second\0', '/second-foreign', '/outside', '//second']) await f.launcher.handleUri(f.request(cwd));
	assert.deepEqual(f.opened, []);
	const old = valid;
	f.launcher.dispose();
	await f.launcher.handleUri(old);
	assert.deepEqual(f.opened, []);
	const next = fixture(await temporary(t));
	await next.enable();
	await next.launcher.handleUri(old);
	assert.deepEqual(next.opened, []);
});

for (const option of ['foreignHost', 'file', 'noTerraform', 'statError', 'searchError', 'revokeOnSearch']) {
	test(`URI route retains folder and trust validation: ${option}`, async t => {
		const f = fixture(await temporary(t));
		await f.enable();
		f.state[option] = true;
		await f.launcher.handleUri(f.request());
		assert.deepEqual(f.opened, []);
		assert.doesNotMatch(f.messages.join('\n'), /private details/);
	});
}

for (const options of [{ trusted: false }, { cancel: true }, { revokeOnConsent: true }, { storageScheme: 'https' }, { uriScheme: 'browser' }, { extensionId: "bad';evil" }]) {
	test(`enable requires trust, consent and supported host: ${JSON.stringify(options)}`, async t => {
		const directory = await temporary(t);
		const f = fixture(path.join(directory, 'absent'), options);
		await f.enable();
		assert.equal(f.mutations.size, 0);
		await assert.rejects(fs.stat(path.join(directory, 'absent')));
	});
}

test('trust loss blocks a previously enabled URI and storage failure never mutates terminal environment', async t => {
	const directory = await temporary(t);
	const f = fixture(directory);
	await f.enable();
	f.state.trusted = false;
	await f.launcher.handleUri(f.request());
	assert.deepEqual(f.opened, []);
	const file = path.join(directory, 'not-directory');
	await fs.writeFile(file, 'x');
	const broken = fixture(file);
	await broken.enable();
	assert.equal(broken.mutations.size, 0);
	assert.match(broken.messages.at(-1), /Could not enable/);
	const colon = fixture(path.join(directory, 'colon:path'));
	await colon.enable();
	assert.equal(colon.mutations.size, 0);
});


test('foreign schemes and authorities cannot reinterpret an extension-host cwd as another machine', async t => {
	for (const mutation of [{ authority: 'foreign' }, { query: 'x' }, { fragment: 'x' }, { scheme: 'https' }, { scheme: 'vscode-remote', authority: 'ssh-remote+other' }, { scheme: 'vscode-local' }]) {
		const local = fixture(await temporary(t));
		await local.enable();
		Object.assign(local.vscode.workspace.workspaceFolders[1].uri, mutation);
		await local.launcher.handleUri(local.request());
		assert.deepEqual(local.opened, []);
	}
});

test('native Windows host rejects PATH launcher without writing helpers', async t => {
	const f = fixture(path.join(await temporary(t), 'absent'));
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
	try {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		await f.enable();
	} finally {
		Object.defineProperty(process, 'platform', descriptor);
	}
	assert.equal(f.mutations.size, 0);
	assert.match(f.messages.at(-1), /POSIX/);
	await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath));
});

test('re-enabling does not retire tokens still used by new terminal processes', async t => {
	const f = fixture(await temporary(t));
	await f.enable();
	const request = f.request();
	await f.enable();
	await f.launcher.handleUri(request);
	assert.equal(f.opened.length, 1);
});

test('extension engine minimum includes the first remote CLI arbitrary-scheme fix', () => {
	const manifest = require('../package.json');
	const lock = require('../package-lock.json');
	assert.equal(manifest.engines.vscode, '^1.96.0');
	assert.deepEqual(lock.packages[''].engines, manifest.engines);
});
