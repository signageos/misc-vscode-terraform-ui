const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseInitArguments, safeInitSuggestion } = require('../out/initArguments');
const { loadWithMocks, createPanel } = require('./helpers.cjs');

test('Init preserves exact arguments without interpreting shell content', () => {
	const args = ['-backend-config=path=space and "quotes"', '-plugin-dir', '/tmp/a b', '$(touch /never)', '$TOKEN', '; echo bad', '/tmp/line\nbreak', '/tmp/carriage\rreturn'];
	assert.deepEqual(parseInitArguments(JSON.stringify(args)), args);
	assert.deepEqual(parseInitArguments(''), []);
});

test('Init rejects malformed input and overrides without including values in errors', () => {
	for (const value of ['SECRET', '{}', '[5]', '["a\\u0000SECRET"]', '["-input=true"]', '["--no-color=false"]', '["-chdir=/SECRET"]', '["-force-copy"]', '["--"]']) {
		assert.throws(() => parseInitArguments(value), (error) => !error.message.includes('SECRET'));
	}
	for (const flag of ['-json', '-help', '-version', '-h', '-input', '--input=false']) {
		assert.throws(() => parseInitArguments(JSON.stringify([flag])));
	}
});

test('Only exact safe flag sets become suggestions; secret args never enter history', async () => {
	assert.equal(safeInitSuggestion('["-upgrade"]'), '["-upgrade"]');
	assert.equal(safeInitSuggestion('["-backend-config=password=SECRET"]'), undefined);
	assert.equal(safeInitSuggestion('["-upgrade", "SECRET"]'), undefined);
	const ui = createPanel();
	try {
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '["-backend-config=password=SECRET"]' });
		await ui.receive({ type: 'saveInitArguments', root: '/b', arguments: '["-upgrade"]' });
		await ui.receive({ type: 'loadSettings', root: '/a' });
		const loaded = ui.messages.at(-1);
		assert.equal(loaded.initArguments, '["-backend-config=password=SECRET"]');
		assert.deepEqual(loaded.suggestions, ['["-upgrade"]']);
		assert.equal(JSON.stringify([...ui.values]).includes('SECRET'), false);
		assert.equal(ui.secretValues.size, 2);
		await ui.receive({ type: 'saveSettings', root: '/a', settings: { parallelism: 12, arguments: 'SECRET' } });
		assert.deepEqual(ui.values.get('terraformUI.rootSettings./a'), { parallelism: 12 });
	} finally { ui.dom.window.close(); }
});

test('Init runner protects output/env, waits for close on cancel, rejects competing work', async () => {
	const calls = [];
	const processes = [];
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {
		child_process: { spawn: (...args) => {
			calls.push(args);
			const proc = new EventEmitter();
			proc.kill = (signal) => { proc.killedWith = signal; };
			processes.push(proc);
			return proc;
		} },
	});
	const runner = new TerraformRunner();
	const promise = runner.init('/a', '["-backend-config=password=SECRET"]');
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0][1], ['init', '-backend-config=password=SECRET', '-input=false', '-no-color']);
	assert.equal(calls[0][2].shell, false);
	assert.equal(calls[0][2].stdio, 'ignore');
	assert.equal(calls[0][2].env.TF_INPUT, 'false');
	assert.equal(calls[0][2].env.TF_CLI_ARGS, undefined);
	assert.equal(calls[0][2].env.TF_LOG, undefined);
	await assert.rejects(runner.init('/b', '[]'), /already running/);
	await assert.rejects(runner.plan('/b', () => {}), /already running/);
	assert.throws(() => runner.apply('/b', [], () => {}), /already running/);
	runner.cancel();
	assert.equal(processes[0].killedWith, 'SIGTERM');
	await assert.rejects(runner.init('/b', '[]'), /already running/);
	processes[0].emit('close', null, 'SIGTERM');
	await assert.rejects(promise, /canceled/);
	const success = runner.init('/b', '[]');
	processes[1].emit('close', 0, null);
	await success;
	const failure = runner.init('/b', '[]');
	processes[2].emit('close', 1, null);
	await assert.rejects(failure, /failed/);
	const error = runner.init('/b', '[]');
	processes[3].emit('error', new Error('SECRET'));
	await assert.rejects(error, (err) => !err.message.includes('SECRET'));
});

test('Panel Init trust/root gate, concurrency and lifecycle use runner mocks only', async () => {
	const ui = createPanel();
	let finish;
	let launches = 0;
	ui.instance.runner.init = () => { launches++; return new Promise((resolve) => { finish = resolve; }); };
	try {
		ui.vscode.workspace.isTrusted = false;
		await ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		ui.vscode.workspace.isTrusted = true;
		await ui.receive({ type: 'runInit', root: '/outside', arguments: '[]' });
		assert.equal(launches, 0);
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		await new Promise(setImmediate);
		await ui.receive({ type: 'runPlan', root: '/a', parallelism: 10 });
		assert.equal(launches, 1);
		assert.match(ui.messages.at(-1).error, /already running/);
		finish();
		await pending;
		assert.equal(ui.messages.at(-1).type, 'initComplete');
		ui.instance.runner.init = async () => { throw new Error('SECRET'); };
		await ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});

test('Actual webview DOM Init controls send explicit args, hide secrets and recover status', () => {
	const ui = createPanel();
	const doc = ui.dom.window.document;
	try {
		ui.deliver({ type: 'terraformRoots', roots: ['/a', '/b'] });
		ui.deliver({ type: 'rootSettings', root: '/a', settings: { parallelism: 12 }, initArguments: '["-upgrade"]', suggestions: ['["-reconfigure"]'] });
		assert.equal(doc.getElementById('initArguments').type, 'password');
		doc.getElementById('initBtn').click();
		assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: 'runInit', root: '/a', arguments: '["-upgrade"]' });
		assert.equal(doc.getElementById('planBtn').disabled, true);
		assert.equal(doc.getElementById('rootSearchInput').disabled, true);
		doc.getElementById('cancelOperationBtn').click();
		assert.equal(ui.sent.at(-1).type, 'cancelApply');
		ui.deliver({ type: 'initError', error: 'Canceled' });
		assert.equal(doc.getElementById('planBtn').disabled, false);
		assert.equal(doc.getElementById('statusText').textContent, 'Canceled');
		ui.deliver({ type: 'initComplete' });
		assert.equal(doc.getElementById('statusText').textContent, 'Init complete');
	} finally { ui.dom.window.close(); }
});


test('SecretStorage failure is sanitized and never launches Init', async () => {
	const ui = createPanel();
	ui.secrets.store = async () => { throw new Error('SECRET'); };
	let launched = false;
	ui.instance.runner.init = async () => { launched = true; };
	try {
		await ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		assert.equal(launched, false);
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
		ui.secrets.get = async () => { throw new Error('SECRET'); };
		await ui.receive({ type: 'loadSettings', root: '/a' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});

test('Cancellation during SecretStorage save does not launch a process', async () => {
	const ui = createPanel();
	let saved;
	let launched = false;
	ui.secrets.store = () => new Promise((resolve) => { saved = resolve; });
	ui.instance.runner.init = async () => { launched = true; };
	try {
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		await ui.receive({ type: 'cancelApply' });
		saved();
		await pending;
		assert.equal(launched, false);
		assert.equal(ui.messages.at(-1).error, 'Init canceled.');
	} finally { ui.dom.window.close(); }
});

test('Suggestion history filters tampering and is bounded and deduplicated', async () => {
	const ui = createPanel();
	try {
		ui.values.set('terraformUI.initSuggestions', ['["-backend-config=SECRET"]', 5, '{', '["-upgrade"]']);
		await ui.receive({ type: 'loadSettings', root: '/a' });
		assert.deepEqual(ui.messages.at(-1).suggestions, ['["-upgrade"]']);
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '["-upgrade"]' });
		assert.deepEqual(ui.values.get('terraformUI.initSuggestions'), ['["-upgrade"]']);
		for (let count = 1; count <= 12; count++) {
			await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: JSON.stringify(Array(count).fill('-upgrade')) });
		}
		assert.equal(ui.values.get('terraformUI.initSuggestions').length, 10);
	} finally { ui.dom.window.close(); }
});

test('Process launch errors keep runner reserved through close and recover', async () => {
	const processes = [];
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {
		child_process: { spawn: () => { const proc = new EventEmitter(); processes.push(proc); return proc; } },
	});
	const runner = new TerraformRunner();
	const failed = runner.init('/a', '[]');
	processes[0].emit('error', new Error('SECRET'));
	await assert.rejects(failed, /Could not start/);
	await assert.rejects(runner.init('/b', '[]'), /already running/);
	processes[0].emit('close', -2);
	const next = runner.init('/b', '[]');
	processes[1].emit('close', 0);
	await next;
});


test('Disposal during SecretStorage save cancels the pending operation before launch', async () => {
	const ui = createPanel();
	let saved;
	let launched = false;
	ui.secrets.store = () => new Promise((resolve) => { saved = resolve; });
	ui.instance.runner.init = async () => { launched = true; };
	try {
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		ui.instance.dispose();
		saved();
		await pending;
		assert.equal(launched, false);
		assert.equal(ui.messages.at(-1).error, 'Init canceled.');
	} finally { ui.dom.window.close(); }
});

test('actual desktop vscode-userdata Init storage persists across instances without borrowing remote secrets', async t => {
	const { InitSettings, secrets, state, uri, entries } = initStorageFixture(t);
	const storage = { ...uri('desktop profile with spaces'), scheme: 'vscode-userdata', query: '', fragment: '' };
	const first = new InitSettings(secrets, state, storage);
	await first.save('/same/root', '[]');
	assert.equal(entries.size, 1);
	assert.equal(await new InitSettings(secrets, state, storage).load('/same/root'), '[]');
	await first.save('/same/root', '["-upgrade"]');
	assert.equal(await new InitSettings(secrets, state, storage).load('/same/root'), '["-upgrade"]');
	const remote = initStorageFixture(t, { remoteName: 'ssh-remote' });
	await assert.rejects(new remote.InitSettings(secrets, state, storage).load('/same/root'), /private host storage/);
});

function initStorageFixture(t, options = {}) {
	const fs = require('node:fs');
	const path = require('node:path');
	const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tfui-init-'));
	t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
	const { InitSettings } = loadWithMocks('../out/initSettings', {
		vscode: { env: { uiKind: 1, remoteName: options.remoteName }, UIKind: { Desktop: 1 }, workspace: { workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: '/same/root' } }] } },
	});
	const entries = new Map();
	const state = { get: () => undefined, update: async () => {} };
	const secrets = { get: async (key) => entries.get(key), store: async (key, value) => { entries.set(key, value); } };
	const uri = (host) => ({ scheme: 'file', authority: '', fsPath: path.join(sandbox, host) });
	return { fs, path, sandbox, InitSettings, entries, state, secrets, uri };
}

test('Init isolates transformed remote/local file roots by physical host storage, not shared client state', async (t) => {
	const { fs, path, InitSettings, entries, state, secrets, uri } = initStorageFixture(t);
	// The extension host receives file:///same/root with no remote authority on
	// every host. Both client-backed SecretStorage and globalState are shared.
	const root = '/same/root';
	const hostA = new InitSettings(secrets, state, uri('remote-a'));
	const hostB = new InitSettings(secrets, state, uri('remote-b'));
	const local = new InitSettings(secrets, state, uri('local'));
	entries.set(`terraformUI.initArguments.file.local.${root}`, '["LEGACY-SECRET"]');
	assert.equal(await hostA.load(root), '[]');
	await hostA.save(root, '["-backend-config=HOST-A-SECRET"]');
	assert.equal(await hostB.load(root), '[]');
	assert.equal(await local.load(root), '[]');
	await hostB.save(root, '["-backend-config=HOST-B-SECRET"]');
	await local.save(root, '["-upgrade"]');
	assert.equal(await new InitSettings(secrets, state, uri('remote-a')).load(root), '["-backend-config=HOST-A-SECRET"]');
	assert.equal(await hostA.load('/different/root'), '[]');
	const namespaceFile = path.join(uri('remote-a').fsPath, 'init-secret-namespace');
	const token = fs.readFileSync(namespaceFile, 'utf8');
	assert.match(token, /^[a-f0-9]{64}$/);
	assert.equal(fs.statSync(namespaceFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(uri('remote-a').fsPath).mode & 0o777, 0o700);
	assert.equal(fs.readdirSync(uri('remote-a').fsPath).length, 1);
	fs.rmSync(uri('remote-a').fsPath, { recursive: true });
	assert.equal(await new InitSettings(secrets, state, uri('remote-a')).load(root), '[]');
	assert.notEqual(fs.readFileSync(namespaceFile, 'utf8'), token);
});

test('Init concurrent host windows atomically publish and reuse one complete namespace', async (t) => {
	const { fs, path, uri } = initStorageFixture(t);
	const { promisify } = require('node:util');
	const execFile = promisify(require('node:child_process').execFile);
	const moduleFile = require.resolve('../out/initSettings');
	const script = `
		const Module = require('node:module');
		const original = Module._load;
		Module._load = function(name, ...rest) { return name === 'vscode' ? {} : original.call(this, name, ...rest); };
		const { InitSettings } = require(process.argv[1]);
		const settings = new InitSettings({ store: async (key) => process.stdout.write(key) },
			{ get: () => undefined }, { scheme: 'file', authority: '', fsPath: process.argv[2] });
		settings.save('/same/root', '[]').catch(() => { process.exitCode = 1; });
	`;
	const results = await Promise.all(Array.from({ length: 8 }, () => execFile(process.execPath, ['-e', script, moduleFile, uri('shared').fsPath])));
	const keys = results.map((result) => result.stdout);
	assert.equal(new Set(keys).size, 1);
	const token = fs.readFileSync(path.join(uri('shared').fsPath, 'init-secret-namespace'), 'utf8');
	assert.equal(keys[0], `terraformUI.initArguments.v2.${token}./same/root`);
	assert.deepEqual(fs.readdirSync(uri('shared').fsPath), ['init-secret-namespace']);
});

test('Init namespace read/write errors, invalid files and unsupported storage fail closed without raw errors', async (t) => {
	const { fs, path, InitSettings, state, uri } = initStorageFixture(t);
	let secretCalls = 0;
	const secrets = { get: async () => { secretCalls++; }, store: async () => { secretCalls++; } };
	const invalidUris = [
		{ scheme: 'vscode-remote', authority: 'SECRET', fsPath: '/SECRET' },
		{ scheme: 'file', authority: 'SECRET', fsPath: '/SECRET' },
		uri('SECRET-file-not-directory'), uri('corrupt'), uri('symlink'),
	];
	fs.writeFileSync(invalidUris[2].fsPath, 'not a directory');
	fs.mkdirSync(uri('corrupt').fsPath);
	fs.writeFileSync(path.join(uri('corrupt').fsPath, 'init-secret-namespace'), 'SECRET');
	fs.mkdirSync(uri('target').fsPath);
	fs.symlinkSync(uri('target').fsPath, uri('symlink').fsPath);
	for (const storageUri of invalidUris) {
		const settings = new InitSettings(secrets, state, storageUri);
		await assert.rejects(settings.load('/same/root'), { message: 'Init private host storage is unavailable.' });
		await assert.rejects(settings.save('/same/root', '[]'), { message: 'Init private host storage is unavailable.' });
	}
	for (const operation of ['readFileSync', 'writeFileSync']) {
		const storageUri = uri(operation);
		if (operation === 'readFileSync') {
			fs.mkdirSync(storageUri.fsPath);
			fs.writeFileSync(path.join(storageUri.fsPath, 'init-secret-namespace'), 'a'.repeat(64));
		}
		const mockedFs = { ...fs, [operation]: () => { throw new Error('SECRET filesystem details'); } };
		const { InitSettings: FailingSettings } = loadWithMocks('../out/initSettings', { fs: mockedFs, vscode: {} });
		const settings = new FailingSettings(secrets, state, storageUri);
		await assert.rejects(settings.load('/same/root'), { message: 'Init private host storage is unavailable.' });
		await assert.rejects(settings.save('/same/root', '[]'), { message: 'Init private host storage is unavailable.' });
	}
	assert.equal(secretCalls, 0);
});


test('Unavailable private host storage blocks panel Init before SecretStorage or process launch', async () => {
	const ui = createPanel();
	let secretCalls = 0;
	let launches = 0;
	ui.instance.initSettings.storageUri = { scheme: 'unsupported', authority: 'SECRET', fsPath: '/SECRET' };
	ui.secrets.get = ui.secrets.store = async () => { secretCalls++; };
	ui.instance.runner.init = async () => { launches++; };
	try {
		await ui.receive({ type: 'loadSettings', root: '/a' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '[]' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		await ui.receive({ type: 'runInit', root: '/a', arguments: '[]' });
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(secretCalls, 0);
		assert.equal(launches, 0);
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});
