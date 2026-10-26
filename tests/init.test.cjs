const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseInitArguments, safeInitSuggestion, formatInitArguments } = require('../out/initArguments');
const { loadWithMocks, createPanel } = require('./helpers.cjs');

test('Init preserves exact arguments without interpreting shell content', () => {
	const args = ['-backend-config=path=space and "quotes"', '-plugin-dir', '/tmp/a b', '$(touch /never)', '$TOKEN', '; echo bad', '/tmp/line\nbreak', '/tmp/carriage\rreturn'];
	assert.deepEqual(parseInitArguments(formatInitArguments(args)), args);
	assert.deepEqual(parseInitArguments(''), []);
	assert.deepEqual(parseInitArguments("-backend-config=\"dir/\"'file name'"), ['-backend-config=dir/file name']);
});

test('Init rejects malformed input and overrides without including values in errors', () => {
	for (const value of ["'SECRET", 'SECRET\\', '\u0000SECRET', '-input=true', '--no-color=false', '-chdir=/SECRET', '-force-copy', '--']) {
		assert.throws(() => parseInitArguments(value), (error) => !error.message.includes('SECRET'));
	}
	for (const flag of ['-json', '-help', '-version', '-h', '-input', '--input=false']) {
		assert.throws(() => parseInitArguments(flag));
	}
});

test('Only exact safe flag sets become suggestions; secret args never enter history', async () => {
	assert.equal(safeInitSuggestion('-upgrade'), '-upgrade');
	assert.equal(safeInitSuggestion('-backend-config=private-fixture'), undefined);
	assert.equal(safeInitSuggestion('-upgrade SECRET'), undefined);
	const ui = createPanel();
	try {
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-backend-config=private-fixture' });
		await ui.receive({ type: 'saveInitArguments', root: '/b', arguments: '-upgrade' });
		await ui.receive({ type: 'loadSettings', root: '/a' });
		const loaded = ui.messages.at(-1);
		assert.equal(loaded.initArguments, '-backend-config=private-fixture');
		assert.deepEqual(loaded.suggestions, ['-upgrade']);
		assert.equal(JSON.stringify([...ui.values]).includes('private-fixture'), false);
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
	const promise = runner.init('/a', '-backend-config=private-fixture');
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0][1], ['init', '-backend-config=private-fixture', '-input=false', '-no-color']);
	assert.equal(calls[0][2].shell, false);
	assert.equal(calls[0][2].stdio, 'ignore');
	assert.equal(calls[0][2].env.TF_INPUT, 'false');
	assert.equal(calls[0][2].env.TF_CLI_ARGS, undefined);
	assert.equal(calls[0][2].env.TF_LOG, undefined);
	await assert.rejects(runner.init('/b', ''), /already running/);
	await assert.rejects(runner.plan('/b', () => {}), /already running/);
	assert.throws(() => runner.apply('/b', [], () => {}), /already running/);
	runner.cancel();
	assert.equal(processes[0].killedWith, 'SIGTERM');
	await assert.rejects(runner.init('/b', ''), /already running/);
	processes[0].emit('close', null, 'SIGTERM');
	await assert.rejects(promise, /canceled/);
	const success = runner.init('/b', '');
	processes[1].emit('close', 0, null);
	await success;
	const failure = runner.init('/b', '');
	processes[2].emit('close', 1, null);
	await assert.rejects(failure, /failed/);
	const error = runner.init('/b', '');
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
		await ui.receive({ type: 'runInit', root: '/a', arguments: '' });
		ui.vscode.workspace.isTrusted = true;
		await ui.receive({ type: 'runInit', root: '/outside', arguments: '' });
		assert.equal(launches, 0);
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '' });
		await new Promise(setImmediate);
		await ui.receive({ type: 'runPlan', root: '/a', parallelism: 10 });
		assert.equal(launches, 1);
		assert.match(ui.messages.at(-1).error, /already running/);
		finish();
		await pending;
		assert.equal(ui.messages.at(-1).type, 'initComplete');
		ui.instance.runner.init = async () => { throw new Error('SECRET'); };
		await ui.receive({ type: 'runInit', root: '/a', arguments: '' });
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});

test('Actual webview DOM Init controls show a single-line argument string and recover status', () => {
	const ui = createPanel();
	const doc = ui.dom.window.document;
	try {
		ui.deliver({ type: 'terraformRoots', roots: ['/a', '/b'] });
		ui.deliver({ type: 'rootSettings', root: '/a', settings: { parallelism: 12 }, initArguments: '-upgrade', suggestions: ['-reconfigure'] });
		assert.equal(doc.getElementById('initArguments').type, 'text');
		assert.equal(doc.getElementById('initArguments').placeholder, '-reconfigure -backend-config=apply.tfvars');
		doc.getElementById('initBtn').click();
		assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: 'runInit', root: '/a', arguments: '-upgrade' });
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


test('SecretStorage failure is sanitized; unavailable reads never launch Init', async () => {
	const ui = createPanel();
	ui.secrets.store = async () => { throw new Error('SECRET'); };
	let launched = false;
	ui.instance.runner.init = async () => { launched = true; };
	try {
		await ui.receive({ type: 'runInit', root: '/a', arguments: '' });
		assert.equal(launched, true);
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
		ui.secrets.get = async () => { throw new Error('SECRET'); };
		await ui.receive({ type: 'loadSettings', root: '/a' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});

test('Cancellation during SecretStorage preflight does not launch or save arguments', async () => {
	const ui = createPanel();
	let saved;
	let launched = false;
	ui.secrets.get = () => new Promise((resolve) => { saved = resolve; });
	ui.instance.runner.init = async () => { launched = true; };
	try {
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '' });
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
		assert.deepEqual(ui.messages.at(-1).suggestions, ['-upgrade']);
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-upgrade' });
		assert.deepEqual(ui.values.get('terraformUI.initSuggestions'), ['["-upgrade"]']);
		for (let count = 1; count <= 12; count++) {
			await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: Array(count).fill('-upgrade').join(' ') });
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
	const failed = runner.init('/a', '');
	processes[0].emit('error', new Error('SECRET'));
	await assert.rejects(failed, /Could not start/);
	await assert.rejects(runner.init('/b', ''), /already running/);
	processes[0].emit('close', -2);
	const next = runner.init('/b', '');
	processes[1].emit('close', 0);
	await next;
});


test('Disposal during SecretStorage preflight cancels the pending operation before launch', async () => {
	const ui = createPanel();
	let saved;
	let launched = false;
	ui.secrets.get = () => new Promise((resolve) => { saved = resolve; });
	ui.instance.runner.init = async () => { launched = true; };
	try {
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '' });
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
	await first.save('/same/root', '');
	assert.equal(entries.size, 1);
	assert.equal(await new InitSettings(secrets, state, storage).load('/same/root'), '');
	await first.save('/same/root', '-upgrade');
	assert.equal(await new InitSettings(secrets, state, storage).load('/same/root'), '-upgrade');
	const remote = initStorageFixture(t, { remoteName: 'ssh-remote' });
	await assert.rejects(new remote.InitSettings(secrets, state, storage).load('/same/root'), /[Pp]rivate host storage/);
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
	assert.equal(await hostA.load(root), '');
	await hostA.save(root, '-backend-config=HOST-A-SECRET');
	assert.equal(await hostB.load(root), '');
	assert.equal(await local.load(root), '');
	await hostB.save(root, '-backend-config=HOST-B-SECRET');
	await local.save(root, '-upgrade');
	assert.equal(await new InitSettings(secrets, state, uri('remote-a')).load(root), '-backend-config=HOST-A-SECRET');
	assert.equal(await hostA.load('/different/root'), '');
	const namespaceFile = path.join(uri('remote-a').fsPath, 'init-secret-namespace');
	const token = fs.readFileSync(namespaceFile, 'utf8');
	assert.match(token, /^[a-f0-9]{64}$/);
	assert.equal(fs.statSync(namespaceFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(uri('remote-a').fsPath).mode & 0o777, 0o700);
	assert.equal(fs.readdirSync(uri('remote-a').fsPath).length, 1);
	fs.rmSync(uri('remote-a').fsPath, { recursive: true });
	assert.equal(await new InitSettings(secrets, state, uri('remote-a')).load(root), '');
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
		settings.save('/same/root', '').catch(() => { process.exitCode = 1; });
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
	t.after(() => loadWithMocks('../out/hostSecrets', { fs }));
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
		await assert.rejects(settings.load('/same/root'), { message: 'Private host storage is unavailable.' });
		await assert.rejects(settings.save('/same/root', ''), { message: 'Private host storage is unavailable.' });
	}
	for (const operation of ['readFileSync', 'writeFileSync']) {
		const storageUri = uri(operation);
		if (operation === 'readFileSync') {
			fs.mkdirSync(storageUri.fsPath);
			fs.writeFileSync(path.join(storageUri.fsPath, 'init-secret-namespace'), 'a'.repeat(64));
		}
		const mockedFs = { ...fs, [operation]: () => { throw new Error('SECRET filesystem details'); } };
		const { HostSecrets } = loadWithMocks('../out/hostSecrets', { fs: mockedFs });
		const { InitSettings: FailingSettings } = loadWithMocks('../out/initSettings', { './hostSecrets': { HostSecrets }, vscode: {} });
		const settings = new FailingSettings(secrets, state, storageUri);
		await assert.rejects(settings.load('/same/root'), { message: 'Private host storage is unavailable.' });
		await assert.rejects(settings.save('/same/root', ''), { message: 'Private host storage is unavailable.' });
	}
	assert.equal(secretCalls, 0);
});


test('Unavailable private host storage blocks panel Init before SecretStorage or process launch', async () => {
	const ui = createPanel();
	let secretCalls = 0;
	let launches = 0;
	ui.instance.initSettings.hostSecrets.storageUri = { scheme: 'unsupported', authority: 'SECRET', fsPath: '/SECRET' };
	ui.secrets.get = ui.secrets.store = async () => { secretCalls++; };
	ui.instance.runner.init = async () => { launches++; };
	try {
		await ui.receive({ type: 'loadSettings', root: '/a' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '' });
		assert.equal(ui.messages.at(-1).type, 'operationError');
		await ui.receive({ type: 'runInit', root: '/a', arguments: '' });
		assert.equal(ui.messages.at(-1).type, 'initError');
		assert.equal(secretCalls, 0);
		assert.equal(launches, 0);
		assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
	} finally { ui.dom.window.close(); }
});


test('Terminal-like Init lexer preserves quoted paths, empty args, literal expansion syntax and Windows escapes', () => {
	const input = String.raw`-reconfigure -backend-config=apply.tfvars -plugin-dir "/tmp/plugin files" '' "" 'C:\config files\apply.tfvars' "C:\config files\apply.tfvars" C:\\config\\apply.tfvars escaped\ space '$TOKEN' ${'${TOKEN}'} *.tf ; && | > # '~' '$(touch /never)' '\u1234'`;
	assert.deepEqual(parseInitArguments(input), [
		'-reconfigure', '-backend-config=apply.tfvars', '-plugin-dir', '/tmp/plugin files', '', '',
		String.raw`C:\config files\apply.tfvars`, String.raw`C:\config files\apply.tfvars`, String.raw`C:\config\apply.tfvars`,
		'escaped space', '$TOKEN', '${TOKEN}', '*.tf', ';', '&&', '|', '>', '#', '~', '$(touch /never)', String.raw`\u1234`,
	]);
	assert.deepEqual(parseInitArguments(String.raw`$'line\nend'`), ['line\nend']);
	for (const input of ["'unclosed", '"unclosed', 'trailing\\', String.raw`$'\0'`, '-upgrade\n-reconfigure', '-upgrade\r-reconfigure']) {
		assert.throws(() => parseInitArguments(input));
	}
});

test('Old private argv arrays reopen as readable single-line text and round-trip without migration loss', async t => {
	const { InitSettings, secrets, state, uri, entries } = initStorageFixture(t);
	const settings = new InitSettings(secrets, state, uri('legacy-host'));
	await settings.save('/same/root', '');
	const key = [...entries.keys()][0];
	const args = ['-reconfigure', '-backend-config=apply.tfvars', 'path with spaces', '', "can't", '"quote"', String.raw`C:\dir\file`, '$TOKEN', '${TOKEN}', '$(touch /never)', '*', 'a\nb\rc', '\t', '$', "'\n'", '\\n'];
	entries.set(key, JSON.stringify(args));
	const restored = await settings.load('/same/root');
	assert.equal(/[\r\n]/.test(restored), false);
	assert.match(restored, /-reconfigure -backend-config=apply.tfvars/);
	assert.deepEqual(parseInitArguments(restored), args);
	await settings.save('/same/root', restored);
	assert.deepEqual(JSON.parse(entries.get(key)), args);
	assert.equal(entries.size, 1);
	for (const corrupt of ['{', 'null', '[5]', '["-input=true"]', '["\\u0000"]']) {
		entries.set(key, corrupt);
		await assert.rejects(settings.load('/same/root'));
		assert.equal(entries.get(key), corrupt);
	}
});

test('Invalid input and canceled Init leave the previous saved argv and history untouched', async () => {
	const ui = createPanel();
	try {
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-upgrade' });
		const saved = [...ui.secretValues];
		const history = JSON.stringify([...ui.values]);
		let launches = 0;
		let finish;
		ui.instance.runner.init = () => { launches++; return new Promise(resolve => { finish = resolve; }); };
		for (const argumentsText of ["'unclosed", 'dangling\\', '-input=true']) {
			await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: argumentsText });
			assert.equal(ui.messages.at(-1).type, 'operationError');
			await ui.receive({ type: 'runInit', root: '/a', arguments: argumentsText });
			assert.equal(ui.messages.at(-1).type, 'initError');
		}
		assert.equal(launches, 0);
		const pending = ui.receive({ type: 'runInit', root: '/a', arguments: '-reconfigure' });
		await new Promise(setImmediate);
		await ui.receive({ type: 'cancelApply' });
		finish();
		await pending;
		assert.match(ui.messages.at(-1).error, /canceled/);
		assert.deepEqual([...ui.secretValues], saved);
		assert.equal(JSON.stringify([...ui.values]), history);
		assert.equal(await ui.instance.initSettings.load('/a'), '-upgrade');
		ui.instance.runner.init = async () => { throw new Error('failure'); };
		await ui.receive({ type: 'runInit', root: '/a', arguments: '-reconfigure' });
		assert.deepEqual([...ui.secretValues], saved);
	} finally { ui.dom.window.close(); }
});

test('Visible unsaved edits do not persist and old safe history contains no cross-root values', async () => {
	const ui = createPanel();
	try {
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-backend-config=private-file.tfvars' });
		ui.values.set('terraformUI.initSuggestions', ['["-upgrade","-reconfigure"]', '["-backend-config=private-file.tfvars"]', 'not JSON', '["--input=false"]']);
		await ui.receive({ type: 'loadSettings', root: '/b' });
		assert.deepEqual(ui.messages.at(-1).suggestions, ['-upgrade -reconfigure']);
		assert.equal(ui.messages.at(-1).initArguments, '');
		ui.deliver({ type: 'terraformRoots', roots: ['/a', '/b'] });
		ui.deliver({ type: 'rootSettings', root: '/a', settings: {}, initArguments: '-backend-config=private-file.tfvars', suggestions: ['-upgrade -reconfigure'] });
		const input = ui.dom.window.document.getElementById('initArguments');
		assert.equal(input.type, 'text');
		input.value = '-reconfigure UNSAVED';
		assert.equal(await ui.instance.initSettings.load('/a'), '-backend-config=private-file.tfvars');
		assert.equal(ui.sent.some(message => message.arguments?.includes('UNSAVED')), false);
		const select = ui.dom.window.document.getElementById('initSuggestions');
		select.value = '-upgrade -reconfigure';
		select.dispatchEvent(new ui.dom.window.Event('change'));
		assert.equal(input.value, '-upgrade -reconfigure');
		assert.equal([...ui.values].join().includes('private-file'), true); // Tampered fixture only, never new history.
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-upgrade' });
		assert.equal([...ui.values].join().includes('private-file'), false);
	} finally { ui.dom.window.close(); }
});


test('Init lexer scopes escapes to each adjacent quoted fragment, not earlier literal text', () => {
	const unc = String.raw`-backend-config=\\server\share\it's.tfvars`;
	const args = [unc, String.raw`literal\n` + '\n', String.raw`literal\r` + '\r\n', String.raw`\\` + "'\n\\n\r", "'", "''"];
	assert.deepEqual(parseInitArguments(formatInitArguments(args)), args);
	assert.deepEqual(parseInitArguments(String.raw`'\\server\share'"'s"`), [String.raw`\\server\share's`]);
	assert.deepEqual(parseInitArguments(String.raw`'literal\n'$'\n'`), [String.raw`literal\n` + '\n']);
	assert.deepEqual(parseInitArguments(String.raw`'literal\r'$'\r\n'`), [String.raw`literal\r` + '\r\n']);
	assert.deepEqual(parseInitArguments(String.raw`'\\'"""\\"'\n'$'\n'`), ['\\'.repeat(3) + String.raw`\n` + '\n']);
});

test('Bounded mixed quote/backslash/control combinations preserve exact Init argv', () => {
	const fragments = ['', "'", '"', '\\', '\\\\', '\\n', '\\r', '\n', '\r', '\r\n', 'a b', '$TOKEN', '$(literal)', '\\"'];
	let combinations = 0;
	for (const first of fragments) for (const second of fragments) for (const third of fragments) {
		const args = ['-backend-config=' + first + second + third];
		const formatted = formatInitArguments(args);
		assert.equal(/[\r\n]/.test(formatted), false);
		assert.deepEqual(parseInitArguments(formatted), args, JSON.stringify(args));
		combinations++;
	}
	assert.equal(combinations, 2744);
});

test('Unchanged legacy load to Save and load to rendered Init preserve UNC and mixed escapes', async () => {
	const ui = createPanel();
	const args = [String.raw`-backend-config=\\server\share\it's.tfvars`, String.raw`literal\n` + '\n', String.raw`literal\r` + '\r\n'];
	try {
		await ui.receive({ type: 'saveInitArguments', root: '/a', arguments: '-upgrade' });
		const key = [...ui.secretValues.keys()][0];
		ui.secretValues.set(key, JSON.stringify(args));
		await ui.receive({ type: 'loadSettings', root: '/a' });
		const loaded = ui.messages.at(-1);
		ui.deliver({ type: 'terraformRoots', roots: ['/a', '/b'] });
		ui.deliver(loaded);
		const doc = ui.dom.window.document;
		const input = doc.getElementById('initArguments');
		assert.equal(input.type, 'text');
		assert.deepEqual(parseInitArguments(input.value), args);
		doc.getElementById('saveInitBtn').click();
		await ui.receive(ui.sent.at(-1));
		assert.deepEqual(JSON.parse(ui.secretValues.get(key)), args);
		await ui.receive({ type: 'loadSettings', root: '/a' });
		ui.deliver(ui.messages.at(-1));
		const calls = [];
		const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {
			child_process: { spawn: (...spawnArgs) => {
				calls.push(spawnArgs);
				const proc = new EventEmitter();
				setImmediate(() => proc.emit('close', 0, null));
				return proc;
			} },
		});
		ui.instance.runner = new TerraformRunner();
		doc.getElementById('initBtn').click();
		await ui.receive(ui.sent.at(-1));
		assert.equal(ui.messages.at(-1).type, 'initComplete');
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0][1], ['init', ...args, '-input=false', '-no-color']);
		assert.equal(calls[0][2].shell, false);
		assert.deepEqual(JSON.parse(ui.secretValues.get(key)), args);
	} finally { ui.dom.window.close(); }
});
