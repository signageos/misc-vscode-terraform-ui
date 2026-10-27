const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const storageSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tfui-panel-storage-'));
after(() => fs.rmSync(storageSandbox, { recursive: true, force: true }));
const { JSDOM } = require('jsdom');

function loadWithMocks(file, mocks) {
	const original = Module._load;
	Module._load = function (name, ...rest) {
		return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, ...rest);
	};
	try {
		delete require.cache[require.resolve(file)];
		return require(file);
	} finally {
		Module._load = original;
	}
}

function createPanel(shared) {
	let receive;
	const messages = [];
	const values = shared?.values ?? new Map();
	const secretValues = shared?.secretValues ?? new Map();
	const storage = {
		get: (key) => values.get(key),
		update: async (key, value) => { values.set(key, value); },
	};
	const secrets = {
		get: async (key) => secretValues.get(key),
		store: async (key, value) => { secretValues.set(key, value); },
	};
	const disposable = { dispose() {} };
	const panel = {
		webview: {
			html: '',
			postMessage: (message) => messages.push(message),
			onDidReceiveMessage: (handler) => { receive = handler; return disposable; },
		},
		onDidDispose: () => disposable,
	};
	const vscode = shared?.vscode ?? {
		window: { createWebviewPanel: () => panel, showQuickPick: async items => items[0] },
		ViewColumn: { One: 1 },
		workspace: { isTrusted: true },
		env: {},
	};
	vscode.window.createWebviewPanel = () => panel;
	const { InitSettings } = loadWithMocks('../out/initSettings', { vscode });
	// Legacy safety tests use virtual /a and /b; real-root concurrency tests resolve the actual filesystem.
	const { TerraformUIPanel } = shared ? { TerraformUIPanel: shared.PanelClass } : loadWithMocks('../out/webviewPanel', { vscode, './initSettings': { InitSettings }, fs: { ...fs, realpathSync: root => ['/a', '/b'].includes(root) ? root : fs.realpathSync(root) } });
	const storageUri = shared?.storageUri ?? { scheme: 'file', authority: '', fsPath: fs.mkdtempSync(path.join(storageSandbox, 'host-')) };
	const instance = TerraformUIPanel.create({}, storage, secrets, ['/a', '/b'], '/a', storageUri);
	const sent = [];
	const pending = [];
	let connected = false;
	function send(message) {
		sent.push(message);
		if (connected) pending.push(receive(message));
	}
	const dom = new JSDOM(panel.webview.html, {
		runScripts: 'dangerously',
		beforeParse(window) {
			window.acquireVsCodeApi = () => ({ postMessage: send });
		},
	});
	function deliver(message) {
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
	}
	function connect() {
		if (connected) return;
		connected = true;
		panel.webview.postMessage = message => { messages.push(message); deliver(message); };
		for (const message of [...sent]) pending.push(receive(message));
	}
	return { instance, PanelClass: TerraformUIPanel, storageUri, vscode, messages, values, secretValues, secrets, storage, dom, sent, deliver, connect, pending, receive: (message) => receive(message) };
}

module.exports = { loadWithMocks, createPanel };
