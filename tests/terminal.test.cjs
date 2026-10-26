const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { uri: makeUri } = require('./fixtures/terminal-uri.cjs');
const { openExternalUri, handlerUri } = require('./fixtures/remote-cli-transform.cjs');

function fixture(options = {}) {
	const cwd = {
		scheme: 'file', authority: '', path: '/second/team "quoted"/it\'s $HOME; stuff',
		fsPath: '/second/team "quoted"/it\'s $HOME; stuff', query: '', fragment: '',
		...options.cwd,
	};
	const folders = (options.roots || ['/first', '/second']).map((fsPath) => ({
		uri: makeUri({ scheme: options.rootScheme || cwd.scheme, authority: options.rootAuthority || cwd.authority, path: fsPath }),
	}));
	const commands = new Map();
	const warnings = [];
	const errors = [];
	const opened = [];
	const patterns = [];
	const executed = [];
	let handler;
	let onClose;
	const state = { trusted: true, ...options };
	const vscode = {
		env: { uriScheme: options.uriScheme || 'vscode', remoteName: options.remoteName,
			asExternalUri: async target => {
				if (options.resolve) return options.resolve(target, vscode, state);
				return target.with({ query: target.query + '&windowId=14' });
			},
		},
		Uri: { from: makeUri, joinPath: (base, ...parts) => makeUri({ ...base, path: path.join(base.path, ...parts) }) },
		Disposable: class { constructor(dispose) { this.dispose = dispose; } },
		FileType: { Directory: 2, File: 1 },
		RelativePattern: class {
			constructor(base, pattern) {
				this.base = base;
				this.pattern = pattern;
				patterns.push(this);
			}
		},
		commands: {
			registerCommand(name, callback) {
				commands.set(name, callback);
				return { dispose() { commands.delete(name); } };
			},
		},
		window: {
			activeTerminal: { shellIntegration: { cwd, executeCommand: (text) => {
				if (options.executeError) throw new Error('private details');
				executed.push(text);
			} } },
			registerUriHandler: (value) => { handler = value; return { dispose() { handler = undefined; } }; },
			onDidCloseTerminal: (callback) => { onClose = callback; return { dispose() { onClose = undefined; } }; },
			showQuickPick: async () => options.shell === undefined ? 'bash/zsh' : options.shell,
			showWarningMessage: async (text, modal) => {
				warnings.push(text);
				if (modal) {
					if (options.beforeConsent) options.beforeConsent(vscode, state);
					return options.cancel ? undefined : 'Enable tfui';
				}
			},
			showErrorMessage: async (text) => errors.push(text),
			showInformationMessage: async () => {},
		},
		workspace: {
			get isTrusted() { return state.trusted; },
			workspaceFolders: folders,
			getWorkspaceFolder: options.getWorkspaceFolder || (() => options.outside ? undefined : { uri: {
				scheme: options.folderScheme || cwd.scheme,
				authority: options.folderAuthority || cwd.authority,
			} }),
			fs: { stat: async () => {
				if (options.statError) throw new Error('private details');
				return { type: options.file ? 1 : 2 };
			} },
			findFiles: async (pattern) => {
				if (options.searchError) throw new Error('private details');
				if (options.revokeTrust) state.trusted = false;
				if (options.noTerraform) return [];
				if (pattern.pattern === '*.tf') return [{ fsPath: path.join(cwd.fsPath, 'main.tf') }];
				return [
					{ fsPath: '/second/main.tf' },
					{ fsPath: path.join(cwd.fsPath, 'main.tf') },
				];
			},
		},
	};
	vscode.window.terminals = [vscode.window.activeTerminal];
	if (options.noTerminal) vscode.window.activeTerminal = undefined;
	if (options.noIntegration) vscode.window.activeTerminal.shellIntegration = undefined;
	if (options.noCwd) vscode.window.activeTerminal.shellIntegration.cwd = undefined;
	const originalLoad = Module._load;
	const terminalPath = require.resolve('../out/terminal');
	const extensionPath = require.resolve('../out/extension');
	delete require.cache[terminalPath];
	delete require.cache[extensionPath];
	Module._load = function (name, parent, isMain) {
		if (name === 'vscode') return vscode;
		if (name === 'node:fs/promises') return { ...originalLoad.call(this, name, parent, isMain), realpath: options.realpath || (async value => value) };
		if (name === './webviewPanel') return { TerraformUIPanel: { create: (...args) => opened.push(args) } };
		return originalLoad.call(this, name, parent, isMain);
	};
	try {
		const { registerTerminalCommand, registerTerminalShortcut } = require(terminalPath);
		const extension = require(extensionPath);
		return { cwd, commands, warnings, errors, opened, patterns, vscode,
			registerTerminalCommand, registerTerminalShortcut, extension, state, executed,
			handle: (uri) => handler.handleUri(uri),
			close: (terminal) => { vscode.window.terminals = vscode.window.terminals.filter(t => t !== terminal); onClose(terminal); },
			get handler() { return handler; },
		};
	} finally {
		Module._load = originalLoad;
	}
}

test('terminal command passes the literal current folder without shell quoting or execution', async () => {
	const f = fixture();
	const calls = [];
	const disposable = f.registerTerminalCommand(async (uri) => calls.push(uri));
	await f.commands.get('terraformUI.openFromTerminal')();
	assert.deepEqual(calls, [f.cwd]);
	assert.equal(f.patterns[0].base, f.cwd);
	assert.equal(f.patterns[0].pattern, '*.tf');
	assert.deepEqual(f.warnings, []);
	disposable.dispose();
	assert.equal(f.commands.has('terraformUI.openFromTerminal'), false);
});

for (const [name, options, message] of [
	['untrusted workspace', { trusted: false }, /Trust/],
	['no terminal', { noTerminal: true }, /integrated terminal/],
	['missing shell integration', { noIntegration: true }, /shell integration/],
	['unknown current directory', { noCwd: true }, /shell integration/],
	['outside all workspace folders', { outside: true }, /workspace first/],
	['foreign URI scheme', { cwd: { scheme: 'https' } }, /different host/],
	['foreign host authority', { folderAuthority: 'other-host' }, /different host/],
	['foreign host scheme', { folderScheme: 'vscode-remote' }, /different host/],
	['URI query', { cwd: { query: 'x=1' } }, /workspace first/],
	['URI fragment', { cwd: { fragment: 'x' } }, /workspace first/],
	['file instead of directory', { file: true }, /not a directory/],
	['no Terraform in current directory', { noTerraform: true }, /terminal folder/],
	['trust revoked while discovering files', { revokeTrust: true }, /Trust/],
]) {
	test(`terminal command rejects ${name} without opening another root`, async () => {
		const f = fixture(options);
		let opened = false;
		f.registerTerminalCommand(async () => { opened = true; });
		await f.commands.get('terraformUI.openFromTerminal')();
		assert.equal(opened, false);
		assert.match(f.warnings[0], message);
	});
}

for (const options of [{ statError: true }, { searchError: true }, {}]) {
	test(`terminal command reports inaccessible folders and opening failures: ${JSON.stringify(options)}`, async () => {
		const f = fixture(options);
		f.registerTerminalCommand(async () => { throw new Error('private details'); });
		await f.commands.get('terraformUI.openFromTerminal')();
		assert.equal(f.errors.length, 1);
		assert.match(f.errors[0], /accessible/);
		assert.doesNotMatch(f.errors[0], /private details/);
	});
}

test('remote workspace uses the original remote URI and authority', async () => {
	const f = fixture({ cwd: { scheme: 'vscode-remote', authority: 'ssh-remote+dev' } });
	const calls = [];
	f.registerTerminalCommand(async (uri) => calls.push(uri));
	await f.commands.get('terraformUI.openFromTerminal')();
	assert.deepEqual(calls, [f.cwd]);
});

test('activation registers both commands and selects the exact terminal root in multi-root workspaces', async () => {
	const f = fixture();
	const context = { environmentVariableCollection: { clear() {} }, extension: { id: 'signageos.terraform-ui' }, extensionUri: {}, globalState: {}, secrets: {}, subscriptions: [] };
	f.extension.activate(context);
	await f.commands.get('terraformUI.openFromTerminal')();
	assert.equal(f.opened.length, 1);
	assert.equal(f.opened[0][0], context.extensionUri);
	assert.equal(f.opened[0][1], context.globalState);
	assert.equal(f.opened[0][2], context.secrets);
	assert.equal(f.opened[0][4], f.cwd.fsPath);
	assert.ok(f.opened[0][3].includes('/second'));
	assert.equal(context.subscriptions.length, 4);
	for (const subscription of context.subscriptions) subscription.dispose();
	assert.equal(f.commands.size, 0);
	f.extension.deactivate();
});

test('ordinary open command also requires workspace trust', async () => {
	const f = fixture({ trusted: false });
	f.extension.activate({ environmentVariableCollection: { clear() {} }, extension: { id: 'signageos.terraform-ui' }, subscriptions: [] });
	await f.commands.get('terraformUI.open')();
	assert.equal(f.opened.length, 0);
	assert.match(f.warnings[0], /Trust/);
});

function shortcut(f, id = 'signageos.terraform-ui') {
	const opened = [];
	const disposable = f.registerTerminalShortcut(id, async uri => opened.push(uri), undefined, makeUri({ path: f.state.extensionPath || '/extension it\'s $safe' }));
	return { opened, disposable, enable: () => f.commands.get('terraformUI.enableTerminalShortcut')() };
}

function callbackUri(f) {
	const match = f.executed.at(-1).match(/'(vscode(?:-insiders)?:[^']+)'/);
	const url = new URL(match[1]);
	if (f.executed.at(-1).includes('TFUI_URL=')) url.search += '&cwd=' + Buffer.from(f.cwd.path).toString('base64url');
	return { scheme: url.protocol.slice(0, -1), authority: url.host, path: url.pathname, query: decodeURIComponent(url.search.slice(1)), fragment: '' };
}

for (const shell of ['bash/zsh', 'PowerShell (pwsh)']) {
	test(`session function for ${shell} contains only a fixed CLI and token URL`, async () => {
		const f = fixture({ shell });
		const s = shortcut(f);
		await s.enable();
		assert.equal(f.executed.length, 1);
		const uri = callbackUri(f);
		assert.match(uri.query, /^token=[a-f0-9]{64}&windowId=14$/);
		const call = `'code' --open-url 'vscode://signageos.terraform-ui/terminal?${encodeURIComponent(uri.query)}'`;
		assert.equal(f.executed[0], shell === 'bash/zsh' ? `function tfui() { ${call}; }` : `function tfui { & ${call} }`);
		assert.doesNotMatch(f.executed[0], /HOME|second|cwd|\$args|\$@/);
		assert.match(f.warnings[0], /clean, idle/);
		assert.match(f.warnings[0], /PATH/);
		await f.handle(uri);
		assert.deepEqual(s.opened, [f.cwd]);
		s.disposable.dispose();
		assert.equal(f.handler, undefined);
		assert.equal(f.commands.size, 0);
	});
}

test('Insiders uses its official scheme and CLI', async () => {
	const f = fixture({ uriScheme: 'vscode-insiders' });
	await shortcut(f).enable();
	assert.match(f.executed[0], /'code-insiders' --open-url 'vscode-insiders:/);
});

for (const options of [
	{ trusted: false }, { noTerminal: true }, { noIntegration: true }, { noCwd: true },
	{ shell: null }, { shell: 'fish' }, { cancel: true }, { uriScheme: "vscode';evil" },
	{ beforeConsent: (_, state) => { state.trusted = false; } },
	{ beforeConsent: v => { v.window.activeTerminal.shellIntegration = undefined; } },
	{ beforeConsent: v => { v.window.activeTerminal.shellIntegration.cwd = undefined; } },
	{ beforeConsent: v => { v.window.terminals = []; } },
]) {
	test(`shortcut does not execute without supported shell, consent, live integration and trust: ${JSON.stringify(options)}`, async () => {
		const f = fixture(options);
		await shortcut(f).enable();
		assert.deepEqual(f.executed, []);
	});
}

test('extension metadata cannot introduce shell text', async () => {
	const f = fixture();
	await shortcut(f, "bad.id'; echo evil").enable();
	assert.deepEqual(f.executed, []);
});

test('execution failures do not issue a token', async () => {
	const f = fixture({ executeError: true });
	await shortcut(f).enable();
	assert.deepEqual(f.executed, []);
	assert.match(f.errors[0], /Could not define/);
	assert.doesNotMatch(f.errors[0], /private details/);
});

test('URI resolves the original terminal current cwd, never the active terminal or URI cwd', async () => {
	const f = fixture();
	const s = shortcut(f);
	const original = f.vscode.window.activeTerminal;
	await s.enable();
	const uri = callbackUri(f);
	const changed = { ...f.cwd, path: '/second/new', fsPath: '/second/new' };
	original.shellIntegration.cwd = changed;
	f.vscode.window.activeTerminal = { shellIntegration: { cwd: { ...f.cwd, fsPath: '/wrong' } } };
	await f.handle({ ...uri, query: uri.query + '&cwd=/wrong' });
	assert.deepEqual(s.opened, []);
	await f.handle(uri);
	assert.deepEqual(s.opened, [changed]);
});

test('URI rejects malformed, unknown, and retired tokens', async () => {
	const f = fixture();
	const s = shortcut(f);
	await s.enable();
	const uri = callbackUri(f);
	for (const change of [
		{ scheme: 'https' }, { authority: 'other.extension' }, { path: '/other' },
		{ fragment: 'cwd' }, { query: 'token=' + '0'.repeat(64) }, { query: uri.query + '&token=other' },
		{ query: '' }, { query: uri.query.toUpperCase() },
	]) await f.handle({ ...uri, ...change });
	assert.deepEqual(s.opened, []);
	await s.enable();
	const replacement = callbackUri(f);
	assert.notEqual(replacement.query, uri.query);
	await f.handle(uri);
	assert.deepEqual(s.opened, []);
	f.close(f.vscode.window.activeTerminal);
	await f.handle(replacement);
	assert.deepEqual(s.opened, []);
});

for (const options of [
	{ outside: true }, { folderAuthority: 'other' }, { folderScheme: 'vscode-remote' },
	{ cwd: { scheme: 'https' } }, { cwd: { query: 'x' } }, { cwd: { fragment: 'x' } },
	{ file: true }, { noTerraform: true }, { statError: true }, { searchError: true }, { revokeTrust: true },
]) {
	test(`URI uses existing current-folder validation: ${JSON.stringify(options)}`, async () => {
		const f = fixture(options);
		const s = shortcut(f);
		await s.enable();
		await f.handle(callbackUri(f));
		assert.deepEqual(s.opened, []);
		assert.ok(f.warnings.length > 1 || f.errors.length);
	});
}

for (const mutation of [
	f => { f.state.trusted = false; },
	f => { f.vscode.window.activeTerminal.shellIntegration.cwd = undefined; },
	f => { f.vscode.window.activeTerminal.shellIntegration = undefined; },
	f => { f.vscode.window.terminals = []; },
]) {
	test('URI refuses trust loss or stale terminal state', async () => {
		const f = fixture();
		const s = shortcut(f);
		await s.enable();
		const uri = callbackUri(f);
		mutation(f);
		await f.handle(uri);
		assert.deepEqual(s.opened, []);
	});
}

test('real extension ID reports stale function after host restart and recovers only by explicit enable', async () => {
	const f = fixture();
	const opened = [];
	const id = require('../package.json').publisher + '.' + require('../package.json').name;
	const first = f.registerTerminalShortcut(id, async cwd => opened.push(cwd));
	await f.commands.get('terraformUI.enableTerminalShortcut')();
	const stale = callbackUri(f);
	first.dispose();
	const next = f.registerTerminalShortcut(id, async cwd => opened.push(cwd));
	const warningCount = f.warnings.length;
	await f.handle(stale);
	assert.deepEqual(opened, []);
	assert.equal(f.warnings.length, warningCount + 1);
	assert.match(f.warnings.at(-1), /another window.*earlier extension session/);
	assert.match(f.warnings.at(-1), /Enable tfui in This Terminal/);
	assert.doesNotMatch(f.warnings.at(-1), /token=|vscode:\/\//);
	assert.ok(!f.warnings.at(-1).includes(stale.query.slice(6)));
	await f.commands.get('terraformUI.enableTerminalShortcut')();
	await f.handle(callbackUri(f));
	assert.deepEqual(opened, [f.cwd]);
	next.dispose();
});

test('tokens bind independently to multiple terminals', async () => {
	const f = fixture();
	const s = shortcut(f);
	const first = f.vscode.window.activeTerminal;
	await s.enable();
	const uri1 = callbackUri(f);
	const cwd2 = { ...f.cwd, fsPath: '/second/two' };
	const second = { shellIntegration: { cwd: cwd2, executeCommand: text => f.executed.push(text) } };
	f.vscode.window.activeTerminal = second;
	f.vscode.window.terminals.push(second);
	await s.enable();
	const uri2 = callbackUri(f);
	await f.handle(uri1);
	await f.handle(uri2);
	assert.deepEqual(s.opened, [f.cwd, cwd2]);
	f.close(first);
	await f.handle(uri1);
	await f.handle(uri2);
	assert.deepEqual(s.opened, [f.cwd, cwd2, cwd2]);
});


test('single registered URI handler delegates the new launcher route and preserves fallback routing', async () => {
	const f = fixture();
	const received = [];
	f.registerTerminalShortcut('signageos.terraform-ui', async () => {}, { handleUri: async uri => received.push(uri) });
	const uri = { path: '/launch', scheme: 'vscode', authority: 'signageos.terraform-ui' };
	await f.handle(uri);
	assert.deepEqual(received, [uri]);
	await f.handle({ ...uri, path: '/other' });
	assert.equal(received.length, 1);
});

for (const shell of ['bash/zsh', 'PowerShell (pwsh)']) {
	for (const uriScheme of ['vscode', 'vscode-insiders']) {
		test(`remote ${shell} ${uriScheme} fallback survives the minimum CLI URL transformation`, async () => {
			const f = fixture({ remoteName: 'ssh-remote', shell, uriScheme });
			const s = shortcut(f);
			await s.enable();
			const cli = uriScheme === 'vscode' ? 'code' : 'code-insiders';
			if (shell === 'bash/zsh') assert.ok(f.executed[0].includes(`TFUI_CLI='${cli}' TFUI_OPEN_ARG='--openExternal'`));
			else assert.ok(f.executed[0].includes(`'${cli}' --openExternal '${uriScheme}://`));
			assert.doesNotMatch(f.executed[0], /--open-url/);
			const callback = callbackUri(f);
			const location = `${uriScheme}://${callback.authority}${callback.path}?${callback.query}`;
			for (const version of ['1.93.0', '1.95.3']) {
				const broken = openExternalUri(version, location, '/project');
				assert.ok(broken.startsWith(`file:///project/${uriScheme}:/`));
				await f.handle(handlerUri(broken));
				assert.deepEqual(s.opened, []);
			}
			const delivered = openExternalUri('1.96.0', location, '/project');
			assert.equal(delivered, location);
			await f.handle(handlerUri(delivered));
			assert.equal(s.opened.length, 1);
			assert.equal(s.opened[0].path, f.cwd.path);
			s.disposable.dispose();
		});
	}
}


test('remote function accepts only its owning window routing metadata and exact token', async () => {
	const f = fixture({ remoteName: 'ssh-remote' });
	const s = shortcut(f);
	await s.enable();
	const original = callbackUri(f);
	for (const query of [original.query.replace('&windowId=14', ''), original.query.replace('windowId=14', 'windowId=15'), original.query + '&windowId=14', original.query + '&unknown=1', original.query + '&' + original.query.split('&')[0]]) {
		await f.handle({ ...original, query });
		assert.deepEqual(s.opened, []);
		assert.doesNotMatch(f.warnings.at(-1), /token=|windowId=|vscode:\/\//);
	}
	await f.handle({ ...original, query: original.query.split('&').reverse().join('&') });
	assert.equal(s.opened.length, 1);
	assert.equal(s.opened[0].path, f.cwd.path);
});

for (const reason of ['failure', 'trust', 'terminal', 'disposal', 'foreign-route']) {
	test(`function externalization is fail-closed after awaited ${reason}`, async () => {
		let s;
		const f = fixture({ resolve: async (target, vscode, state) => {
			await Promise.resolve();
			if (reason === 'failure') throw new Error('private callback');
			if (reason === 'trust') state.trusted = false;
			if (reason === 'terminal') vscode.window.terminals = [];
			if (reason === 'disposal') s.disposable.dispose();
			return target.with(reason === 'foreign-route' ? { authority: 'other.extension' } : { query: target.query + '&windowId=14' });
		} });
		s = shortcut(f);
		await s.enable();
		assert.deepEqual(f.executed, []);
		assert.doesNotMatch([...f.errors, ...f.warnings].join(' '), /private callback|token=|windowId=/);
	});
}

// VS Code 1.96 exposes remote shell-integration cwd as vscode-local. Never relabel it.
test('remote bash uses process cwd and host-local roots, not ambiguous shell-integration URI', async () => {
	const f = fixture({ remoteName: 'ssh-remote', cwd: { scheme: 'vscode-local' }, rootScheme: 'file', folderScheme: 'file' });
	const s = shortcut(f);
	await s.enable();
	assert.match(f.executed[0], /TFUI_URL=/);
	assert.match(f.executed[0], /ELECTRON_RUN_AS_NODE=1/);
	await f.handle(callbackUri(f));
	assert.equal(s.opened.length, 1);
	assert.equal(s.opened[0].scheme, 'file');
	assert.equal(s.opened[0].path, f.cwd.path);
	assert.equal(f.cwd.scheme, 'vscode-local');
});

for (const reason of ['foreign-root', 'ui-side-root', 'outside', 'missing-cwd', 'duplicate-cwd', 'closed', 'untrusted']) {
	test(`remote process-cwd function rejects ${reason}`, async () => {
		const f = fixture({ remoteName: 'ssh-remote', ...(reason === 'foreign-root' ? { rootAuthority: 'foreign' } : {}), ...(reason === 'ui-side-root' ? { rootScheme: 'vscode-local' } : {}) });
		const s = shortcut(f);
		await s.enable();
		const callback = callbackUri(f);
		if (reason === 'outside') callback.query = callback.query.replace(/cwd=[^&]+/, 'cwd=' + Buffer.from('/other').toString('base64url'));
		if (reason === 'missing-cwd') callback.query = callback.query.replace(/&cwd=[^&]+/, '');
		if (reason === 'duplicate-cwd') callback.query += '&cwd=Zm9v';
		if (reason === 'closed') f.close(f.vscode.window.activeTerminal);
		if (reason === 'untrusted') f.state.trusted = false;
		await f.handle(callback);
		assert.deepEqual(s.opened, []);
		assert.ok(f.warnings.length > 1);
		assert.doesNotMatch(f.warnings.at(-1), /token=|windowId=|vscode:\/\//);
	});
}

test('actual remote bash function preserves cwd, serialized minted metadata and quoted extension/runtime arguments', async t => {
	const fs = require('node:fs/promises');
	const { spawnSync } = require('node:child_process');
	const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'tfui-function-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const cwd = path.join(root, "cwd space it's $HOME; $(no) & %?#é");
	const extensionPath = path.join(root, "extension it's $HOME; $(no)");
	const bin = path.join(root, 'bin');
	await fs.mkdir(cwd);
	await fs.mkdir(path.join(extensionPath, 'out'), { recursive: true });
	await fs.mkdir(bin);
	for (const name of ['terminalLauncherProcess.js', 'terminalUri.js']) await fs.copyFile(path.resolve(__dirname, '../out', name), path.join(extensionPath, 'out', name));
	const capture = path.join(root, 'argv.json');
	await fs.writeFile(path.join(bin, 'code'), '#!' + process.execPath + "\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));", { mode: 0o700 });
	const f = fixture({ remoteName: 'ssh-remote', roots: [root], extensionPath, cwd: { path: cwd, fsPath: cwd, scheme: 'vscode-local' }, rootScheme: 'file', folderScheme: 'file',
		resolve: async target => target.with({ query: target.query + '&windowId=14&nonce=quoted%27%26%3D%25' }) });
	const s = shortcut(f);
	await s.enable();
	assert.equal(f.executed.length, 1);
	const result = spawnSync('bash', ['--noprofile', '--norc', '-c', f.executed[0] + '; tfui'], { cwd, env: { ...process.env, PATH: bin + ':' + process.env.PATH, CAPTURE: capture }, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const argv = JSON.parse(await fs.readFile(capture, 'utf8'));
	assert.equal(argv.length, 2);
	assert.equal(argv[0], '--openExternal');
	const callback = handlerUri(openExternalUri('1.96.0', argv[1], cwd));
	assert.match(callback.query, /&windowId=14&nonce=quoted%27%26%3D%25&cwd=/);
	await f.handle(callback);
	assert.equal(s.opened.length, 1);
	assert.equal(s.opened[0].path, cwd);
	assert.equal(s.opened[0].scheme, 'file');
	assert.equal(f.cwd.scheme, 'vscode-local');
});

for (const scenario of ['symlink-root', 'physical-root', 'outside', 'escaping-link', 'foreign-authority', 'foreign-scheme', 'missing', 'trust-changed', 'workspace-changed']) {
	test(`remote process cwd canonical containment: ${scenario}`, async t => {
		const fs = require('node:fs/promises');
		const base = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'tfui-canonical-'));
		t.after(() => fs.rm(base, { recursive: true, force: true }));
		const physical = path.join(base, 'physical root');
		const alias = path.join(base, 'logical root');
		const outside = path.join(base, 'outside');
		await fs.mkdir(path.join(physical, 'child with spaces'), { recursive: true });
		await fs.mkdir(outside);
		await fs.symlink(physical, alias);
		await fs.symlink(outside, path.join(physical, 'escape'));
		const root = scenario === 'physical-root' ? physical : alias;
		const cwd = scenario === 'outside' ? outside : scenario === 'escaping-link' ? path.join(alias, 'escape') : scenario === 'missing' ? path.join(base, 'missing') : path.join(physical, 'child with spaces');
		const rootUri = makeUri({ scheme: 'file', authority: '', path: root });
		let f;
		let eligibleResolutions = 0;
		f = fixture({ remoteName: 'ssh-remote', roots: [root], cwd: { scheme: 'vscode-local', path: cwd, fsPath: cwd }, rootScheme: scenario === 'foreign-scheme' ? 'vscode-remote' : 'file', rootAuthority: scenario === 'foreign-authority' ? 'foreign' : '',
			getWorkspaceFolder: uri => scenario === 'workspace-changed' || !uri.path.startsWith(root + '/') ? undefined : { uri: rootUri },
			realpath: async value => {
				if (value === root) eligibleResolutions++;
				const resolved = await fs.realpath(value);
				if (scenario === 'trust-changed') f.state.trusted = false;
				return resolved;
			},
		});
		const s = shortcut(f);
		await s.enable();
		await f.handle(callbackUri(f));
		if (scenario === 'symlink-root' || scenario === 'physical-root') {
			assert.equal(s.opened.length, 1);
			assert.equal(s.opened[0].path, path.join(root, 'child with spaces'));
			assert.equal(s.opened[0].scheme, 'file');
			assert.equal(await fs.realpath(s.opened[0].fsPath), await fs.realpath(cwd));
		} else {
			assert.deepEqual(s.opened, []);
			assert.ok(f.warnings.length > 1);
			assert.doesNotMatch(f.warnings.at(-1), /token=|windowId=|vscode:\/\/|tfui-canonical-/);
		}
		if (scenario.startsWith('foreign-')) assert.equal(eligibleResolutions, 0);
		s.disposable.dispose();
	});
}
