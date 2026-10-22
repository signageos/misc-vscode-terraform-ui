const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { parseEnvironment, validateExecutable, executionSnapshot, maskPlanForDisplay, executionIdentity } = require('../out/execution');
const { ExecutionSettings } = require('../out/executionSettings');
const { HostSecrets } = require('../out/hostSecrets');
const { loadWithMocks, createPanel } = require('./helpers.cjs');

const configured = { executable: '/private/bin with spaces/terraform-wrapper', environment: { HTTPS_PROXY: 'http://mock-secret.invalid', GOOGLE_APPLICATION_CREDENTIALS: '/private/mock account.json', TFUI_REMOVE: null } };

function processMock() {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = { write: (input) => { proc.input = input; } };
	proc.kill = (signal) => { proc.signal = signal; };
	return proc;
}
function runnerFixture() {
	const calls = [];
	const processes = [];
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', { child_process: { spawn: (...args) => {
		calls.push(args);
		const proc = processMock();
		processes.push(proc);
		return proc;
	} } });
	return { runner: new TerraformRunner(), calls, processes };
}

function safe(messages) {
	const serialized = JSON.stringify(messages);
	for (const value of Object.values(configured.environment).filter(Boolean)) assert.equal(serialized.includes(value), false);
	assert.equal(serialized.includes(configured.executable), false);
}

test('Execution input is literal, portable JSON with no reserved safety controls or raw validation errors', () => {
	assert.equal(validateExecutable('terraform'), 'terraform');
	assert.equal(validateExecutable(configured.executable), configured.executable);
	assert.deepEqual(parseEnvironment('{"A":"$(touch never); $TOKEN", "B":null,"C":""}'), { A: '$(touch never); $TOKEN', B: null, C: '' });
	for (const value of ['', 'terraform -chdir=SECRET', './relative/SECRET', '-SECRET', '/path/SECRET\0']) assert.throws(() => validateExecutable(value), (err) => !err.message.includes('SECRET'));
	for (const input of ['SECRET', '[]', 'null', '{"A":2}', '{"A":"SECRET\\u0000"}', '{"bad-name":"SECRET"}', '{"A":"SECRET","a":"x"}', '{"TF_CLI_ARGS_show":"SECRET"}', '{"TF_LOG":"SECRET"}', '{"TF_INPUT":"SECRET"}', '{"tf_in_automation":"SECRET"}', ' '.repeat(65537)]) {
		assert.throws(() => parseEnvironment(input), (err) => !err.message.includes('SECRET'));
	}
	assert.throws(() => parseEnvironment(JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['V' + i, 'x'])))), /Too many/);
});

test('Snapshots inherit extension host, apply exact overrides/unsets and remove unsafe inherited Terraform controls', () => {
	const saved = { ...process.env };
	try {
		process.env.TFUI_REMOVE = 'inherited';
		process.env.TFUI_KEEP = 'inherited';
		process.env.TF_CLI_ARGS_show = '-SECRET';
		process.env.TF_LOG_PATH = '/SECRET';
		process.env.TF_INPUT = '0';
		const snapshot = executionSnapshot(configured);
		assert.equal(snapshot.env.TFUI_REMOVE, undefined);
		assert.equal(snapshot.env.TFUI_KEEP, 'inherited');
		assert.equal(snapshot.env.HTTPS_PROXY, configured.environment.HTTPS_PROXY);
		assert.equal(snapshot.env.GOOGLE_APPLICATION_CREDENTIALS, configured.environment.GOOGLE_APPLICATION_CREDENTIALS);
		assert.equal(snapshot.env.TF_CLI_ARGS_show, undefined);
		assert.equal(snapshot.env.TF_LOG_PATH, undefined);
		assert.equal(snapshot.env.TF_INPUT, undefined);
		assert.equal(snapshot.env.TF_IN_AUTOMATION, '1');
		assert.equal(snapshot.withholdOutput, true);
		assert.equal(executionSnapshot().withholdOutput, false);
		assert.equal(process.env.TFUI_REMOVE, 'inherited');
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
		Object.assign(process.env, saved);
	}
});

test('SecretStorage execution settings reuse physical host namespace, isolate roots/hosts and survive restart', async (t) => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tfui-execution-'));
	t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
	const values = new Map();
	const secrets = { get: async (key) => values.get(key), store: async (key, value) => values.set(key, value) };
	const uri = (name, scheme = 'file') => ({ scheme, authority: '', fsPath: path.join(sandbox, name) });
	const hostUri = uri('native', 'vscode-userdata');
	const settings = new ExecutionSettings(new HostSecrets(secrets, hostUri, true));
	await settings.save('/same/root', configured.executable, JSON.stringify(configured.environment));
	assert.deepEqual(await new ExecutionSettings(new HostSecrets(secrets, hostUri, true)).load('/same/root'), configured);
	assert.deepEqual(await settings.load('/different/root'), { executable: 'terraform', environment: {} });
	assert.deepEqual(await new ExecutionSettings(new HostSecrets(secrets, uri('remote'), false)).load('/same/root'), { executable: 'terraform', environment: {} });
	await assert.rejects(new ExecutionSettings(new HostSecrets(secrets, hostUri, false)).load('/same/root'), /Private host storage/);
	assert.equal(values.size, 1);
	assert.match([...values.keys()][0], /^terraformUI\.execution\.v1\.[a-f0-9]{64}\.\/same\/root$/);
	await settings.save('/same/root', 'terraform', '{}');
	assert.deepEqual(await settings.load('/same/root'), { executable: 'terraform', environment: {} });
	const key = [...values.keys()][0];
	values.set(key, '{"executable":"terraform","environment":{"TF_LOG":"SECRET"}}');
	await assert.rejects(settings.load('/same/root'), (error) => !error.message.includes('SECRET'));
});

function rawPlan(addresses = ['mock.a']) {
 return {rawOutput:'',resourceChanges:addresses.map(address=>({address,mode:'managed',type:'mock',name:'item',actions:['update'],before:{token:'prod'},after:{token:'updated'},afterUnknown:null}))};
}

test('Display projection masks text/attributes but preserves actions and mode without mutating operational model', () => {
 const value = 'secret"\\\n';
 const plan = rawPlan(['resource.'+value]);
 plan.resourceChanges[0].before = {[value]:[value,123,null]};
 plan.resourceChanges[0].actions=['update','create'];
 const result=maskPlanForDisplay(plan,executionSnapshot({executable:'terraform',environment:{TOKEN:value,ACTION:'update',MODE:'managed'}}));
 assert.equal(result.resourceChanges[0].address,'resource.[REDACTED]');
 assert.deepEqual(result.resourceChanges[0].before,{'[REDACTED]':['[REDACTED]',123,null]});
 assert.deepEqual(result.resourceChanges[0].actions,['update','create']);
 assert.equal(result.resourceChanges[0].mode,'managed');
 assert.equal(plan.resourceChanges[0].address,'resource.'+value);
});

test('Plan and Show use identical executable/env snapshot and withhold split raw diagnostics', async () => {
	const { runner, calls, processes } = runnerFixture();
	const output = [];
	const settings = structuredClone(configured);
	const promise = runner.plan('/root with spaces', (data) => output.push(data), 7, settings);
	assert.equal(calls[0][0], configured.executable);
	assert.equal(calls[0][2].shell, false);
	assert.equal(calls[0][2].cwd, '/root with spaces');
	const secret = configured.environment.HTTPS_PROXY;
	processes[0].stdout.emit('data', Buffer.from(secret.slice(0, 7)));
	processes[0].stderr.emit('data', Buffer.from(secret.slice(7)));
	settings.environment.HTTPS_PROXY = 'changed after Plan';
	processes[0].emit('close', 0, null);
	await new Promise(setImmediate);
	assert.equal(calls.length, 2);
	assert.equal(calls[1][1][0], 'show');
	assert.equal(calls[1][0], calls[0][0]);
	assert.equal(calls[1][2].env, calls[0][2].env);
	assert.equal(calls[1][2].env.HTTPS_PROXY, secret);
	assert.equal(calls[1][2].shell, false);
	processes[1].stderr.emit('data', Buffer.from(secret));
	processes[1].stdout.emit('data', Buffer.from(JSON.stringify({ resource_changes: [{ address: 'mock.a', mode: 'managed', type: 'mock', name: 'a', change: { actions: ['update'], before: { token: secret }, after: { token: 'updated' } } }] })));
	processes[1].emit('close', 0, null);
	const plan = await promise;
	assert.equal(plan.resourceChanges[0].before.token, secret); // host-only raw plan
	const display = maskPlanForDisplay(plan, executionSnapshot(configured));
	assert.equal(plan.rawOutput, '');
	safe(output);
	assert.equal(JSON.stringify(display).includes(secret), false);
});

test('Init and Apply share executable/env policy, retain Init noninteractive safety and masked Apply confirmation', async () => {
	const { runner, calls, processes } = runnerFixture();
	const init = runner.init('/a', '', configured);
	assert.equal(calls[0][0], configured.executable);
	assert.equal(calls[0][2].env.HTTPS_PROXY, configured.environment.HTTPS_PROXY);
	assert.equal(calls[0][2].env.TF_INPUT, 'false');
	assert.equal(calls[0][2].stdio, 'ignore');
	processes[0].emit('close', 0, null);
	await init;
	const output = [];
	const handle = runner.apply('/a', ['mock.a'], (data) => output.push(data), 9, configured);
	assert.equal(calls[1][0], configured.executable);
	assert.equal(calls[1][2].env.GOOGLE_APPLICATION_CREDENTIALS, configured.environment.GOOGLE_APPLICATION_CREDENTIALS);
	assert.equal(calls[1][2].shell, false);
	processes[1].stdout.emit('data', Buffer.from(configured.environment.HTTPS_PROXY + '\nEnter a va'));
	processes[1].stdout.emit('data', Buffer.from('lue:'));
	assert.equal(output.at(-1), 'Enter a value:');
	handle.writeInput('yes\n');
	assert.equal(processes[1].input, 'yes\n');
	runner.cancel();
	assert.equal(processes[1].signal, 'SIGTERM');
	processes[1].emit('close', 0, null);
	safe(output);
});

test('Plan stage errors/cancellation never expose raw spawn/provider/JSON messages or launch Show after cancellation', async () => {
	for (const stage of ['plan-error', 'plan-exit', 'show-error', 'show-json', 'cancel']) {
		const { runner, calls, processes } = runnerFixture();
		const promise = runner.plan('/a', () => {}, undefined, configured);
		const rejected = assert.rejects(promise, (error) => !error.message.includes('SECRET'));
		if (stage === 'plan-error') { processes[0].emit('error', new Error('SECRET')); processes[0].emit('close', -2, null); }
		else if (stage === 'plan-exit') processes[0].emit('close', 1, null);
		else if (stage === 'cancel') { processes[0].emit('close', 0, null); runner.cancel(); }
		else {
			processes[0].emit('close', 0, null);
			await new Promise(setImmediate);
			if (stage === 'show-error') { processes[1].emit('error', new Error('SECRET')); processes[1].emit('close', -2, null); }
			else { processes[1].stdout.emit('data', Buffer.from('SECRET invalid JSON')); processes[1].emit('close', 0, null); }
		}
		await rejected;
		if (stage === 'cancel') assert.equal(calls.length, 1);
	}
});

test('All operations mask synchronous spawn failures', async () => {
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', { child_process: { spawn: () => { throw new Error('SECRET'); } } });
	const runner = new TerraformRunner();
	await assert.rejects(runner.init('/a', '', configured), (error) => !error.message.includes('SECRET'));
	await assert.rejects(runner.plan('/a', () => {}, 1, configured), (error) => !error.message.includes('SECRET'));
	assert.throws(() => runner.apply('/a', [], () => {}, 1, configured), (error) => !error.message.includes('SECRET'));
});

test('Native execution settings dialogs are masked, trust-gated, host/root-scoped, and never sent to webview/Memento', async () => {
	const ui = createPanel();
	const prompts = [];
	ui.vscode.window.showInputBox = async (options) => { prompts.push(options); return prompts.length === 1 ? configured.executable : JSON.stringify(configured.environment); };
	try {
		ui.vscode.workspace.isTrusted = false;
		await ui.receive({ type: 'configureExecution', root: '/a' });
		ui.vscode.workspace.isTrusted = true;
		await ui.receive({ type: 'configureExecution', root: '/outside' });
		assert.equal(prompts.length, 0);
		await ui.receive({ type: 'configureExecution', root: '/a' });
		assert.equal(prompts.length, 2);
		assert.equal(prompts.every((prompt) => prompt.password && prompt.ignoreFocusOut), true);
		assert.equal(prompts[0].validateInput('terraform -SECRET').includes('SECRET'), false);
		assert.equal(prompts[1].validateInput('SECRET').includes('SECRET'), false);
		assert.equal(ui.values.size, 0);
		safe(ui.messages);
		assert.deepEqual(await ui.instance.executionSettings.load('/a'), configured);
		assert.deepEqual(await ui.instance.executionSettings.load('/b'), { executable: 'terraform', environment: {} });
		assert.equal(ui.messages.at(-1).type, 'executionSettingsFinished');
	} finally { ui.dom.window.close(); }
});

test('Cancel or trust revocation during dialogs never persists executable/environment', async () => {
	for (const mode of ['escape', 'trust', 'cancel']) {
		const ui = createPanel();
		let count = 0;
		ui.vscode.window.showInputBox = async () => {
			count++;
			if (mode === 'escape') return undefined;
			if (mode === 'trust') ui.vscode.workspace.isTrusted = false;
			if (mode === 'cancel') await ui.receive({ type: 'cancelApply' });
			return configured.executable;
		};
		try {
			await ui.receive({ type: 'configureExecution', root: '/a' });
			assert.equal(ui.secretValues.size, 0);
			assert.equal(count, 1);
		} finally { ui.dom.window.close(); }
	}
});

test('Settings snapshot loads before every panel operation and cancellation during SecretStorage load blocks spawn', async () => {
	for (const type of ['runPlan', 'runInit', 'applyTargets']) {
		const ui = createPanel();
		const launches = [];
		ui.instance.runner.plan = async (...args) => { launches.push(args.at(-1)); return { resourceChanges: [], rawOutput: '' }; };
		ui.instance.runner.init = async (...args) => { launches.push(args.at(-1)); };
		ui.instance.runner.apply = (...args) => { launches.push(args.at(-1)); return { process: processMock(), writeInput() {} }; };
		try {
			await ui.instance.executionSettings.save('/a', configured.executable, JSON.stringify(configured.environment));
			let targets=[];
			if(type==='applyTargets') { ui.instance.runner.plan=async()=>rawPlan(); await ui.receive({type:'runPlan',root:'/a',parallelism:3}); targets=[ui.messages.find(m=>m.type==='planComplete').plan.resourceChanges[0].selectionId]; }
			const message = { type, root: '/a', arguments: '[]', targets, parallelism: 3 };
			await ui.receive(message);
			assert.deepEqual(launches, [configured]);
			if (type === 'applyTargets') ui.instance.applyHandle.process.emit('close', 0);
			let complete;
			ui.instance.executionSettings.load = () => new Promise((resolve) => { complete = resolve; });
			const pending = ui.receive(message);
			await new Promise(setImmediate);
			await ui.receive({ type: 'cancelApply' });
			complete(configured);
			await pending;
			assert.equal(launches.length, 1);
			safe(ui.messages);
		} finally { ui.dom.window.close(); }
	}
});

test('Unavailable execution SecretStorage fails closed for Plan/Init/Apply without raw errors', async () => {
	for (const type of ['runPlan', 'runInit', 'applyTargets']) {
		const ui = createPanel();
		let launches = 0;
		ui.instance.runner.init = ui.instance.runner.plan = ui.instance.runner.apply = () => { launches++; throw new Error('SECRET'); };
		ui.secrets.get = async () => { throw new Error('SECRET'); };
		try {
			await ui.receive({ type, root: '/a', arguments: '[]', targets: [], parallelism: 1 });
			assert.equal(launches, 0);
			assert.equal(JSON.stringify(ui.messages).includes('SECRET'), false);
		} finally { ui.dom.window.close(); }
	}
});

test('Actual webview execution button sends only selected root; editing clears stale plan and blocks other controls', () => {
	const ui = createPanel();
	const doc = ui.dom.window.document;
	try {
		ui.deliver({ type: 'terraformRoots', roots: ['/a', '/b'] });
		ui.deliver({ type: 'rootSettings', root: '/a', settings: { parallelism: 10 } });
		doc.getElementById('executionSettingsBtn').click();
		assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: 'configureExecution', root: '/a' });
		ui.deliver({ type: 'executionSettingsStarted' });
		assert.equal(doc.getElementById('planBtn').disabled, true);
		assert.equal(doc.getElementById('executionSettingsBtn').disabled, true);
		assert.match(doc.getElementById('diffContent').textContent, /fresh plan/);
		ui.deliver({ type: 'executionSettingsSaved', root: '/a' });
		ui.deliver({ type: 'executionSettingsFinished' });
		assert.equal(doc.getElementById('planBtn').disabled, false);
		assert.match(doc.getElementById('statusText').textContent, /saved/);
	} finally { ui.dom.window.close(); }
});

test('Real inert executable with spaces receives exact mock GCP/proxy environment for Init/Plan/Show/Apply without a shell', async (t) => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tfui-exec with spaces-'));
	t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
	const executable = path.join(sandbox, 'mock terraform');
	const ledger = path.join(sandbox, 'calls.jsonl');
	const token = 'synthetic-only-token-$(no shell)';
	fs.writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst command = process.argv[2];\nif (!['plan','show','init','apply'].includes(command)) process.exit(91);\nfs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({command, cwd:process.cwd(), credential: process.env.GOOGLE_APPLICATION_CREDENTIALS === ${JSON.stringify(token)}, proxy: process.env.HTTPS_PROXY === 'http://inert.invalid', removed: process.env.TFUI_REMOVE === undefined})+'\\n');\nif(command==='show') process.stdout.write(JSON.stringify({resource_changes:[{address:'mock.a',mode:'managed',type:'mock',name:'a',change:{actions:['create'],before:null,after:{token:process.env.GOOGLE_APPLICATION_CREDENTIALS}}}]}));\nelse if(command==='apply') { process.stdout.write(process.env.GOOGLE_APPLICATION_CREDENTIALS+' Enter a value:'); process.stdin.once('data',()=>process.exit(0)); }\nelse process.stdout.write(process.env.GOOGLE_APPLICATION_CREDENTIALS);\n`, { mode: 0o700 });
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {});
	const runner = new TerraformRunner();
	const settings = { executable, environment: { GOOGLE_APPLICATION_CREDENTIALS: token, HTTPS_PROXY: 'http://inert.invalid', TFUI_REMOVE: null } };
	const output = [];
	await runner.init(sandbox, '', settings);
	const plan = await runner.plan(sandbox, (text) => output.push(text), 1, settings);
	assert.equal(maskPlanForDisplay(plan, executionSnapshot(settings)).resourceChanges[0].after.token, '[REDACTED]');
	const handle = runner.apply(sandbox, ['mock.a'], (text) => { output.push(text); if (text === 'Enter a value:') handle.writeInput('yes\n'); }, 1, settings);
	await once(handle.process, 'close');
	const entries = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
	assert.deepEqual(entries.map((entry) => entry.command), ['init', 'plan', 'show', 'apply']);
	assert.equal(entries.every((entry) => entry.cwd === sandbox && entry.credential && entry.proxy && entry.removed), true);
	assert.equal(JSON.stringify(output).includes(token), false);
});


test('Portable special environment keys are own literal properties, never prototype setters', () => {
 const environment = parseEnvironment('{"__proto__":"literal","constructor":"also literal"}');
 const result = executionSnapshot({ executable: 'terraform', environment });
 assert.equal(Object.hasOwn(result.env, '__proto__'), true);
 assert.equal(result.env.__proto__, 'literal');
 assert.equal(result.env.constructor, 'also literal');
 assert.equal(Object.getPrototypeOf(result.env), Object.prototype);
});

test('Numeric secret attributes are masked without changing ordinary numeric plan values', () => {
 const plan=rawPlan();
 plan.resourceChanges[0].after={secret:123456,ordinary:42};
 const result=maskPlanForDisplay(plan,executionSnapshot({executable:'terraform',environment:{TOKEN:'123456'}}));
 assert.deepEqual(result.resourceChanges[0].after,{secret:'[REDACTED]',ordinary:42});
});

test('Default Apply retains live output and an active Plan blocks concurrent operations through Show', async () => {
 const {runner,processes,calls}=runnerFixture();
 const output=[];
 runner.apply('/a',[],text=>output.push(text));
 processes[0].stdout.emit('data',Buffer.from('normal output'));
 assert.equal(output.at(-1),'normal output');
 processes[0].emit('close',0,null);
 const pending=runner.plan('/a',()=>{});
 await assert.rejects(runner.init('/a',''),/already running/);
 processes[1].emit('close',0,null);
 await new Promise(setImmediate);
 assert.equal(calls.at(-1)[1][0],'show');
 assert.throws(()=>runner.apply('/a',[],()=>{}),/already running/);
 processes[2].stdout.emit('data',Buffer.from('{}'));
 processes[2].emit('close',0,null);
 await pending;
});

test('Execution dialogs hold the shared operation lock and release it on cancellation', async () => {
 const first=createPanel();
 let finish;
 first.vscode.window.showInputBox=()=>new Promise(resolve=>{finish=resolve;});
 try {
  const pending=first.receive({type:'configureExecution',root:'/a'});
  await new Promise(setImmediate);
  await first.receive({type:'runPlan',root:'/b',parallelism:1});
  assert.match(first.messages.at(-1).error,/already running/);
  finish(undefined);
  await pending;
  assert.equal(first.messages.at(-1).type,'executionSettingsFinished');
 } finally {first.dom.window.close();}
});


async function completePanelPlan(ui, fixture, addresses) {
 const start=fixture.processes.length;
 const pending=ui.receive({type:'runPlan',root:'/a',parallelism:3});
 ui.deliver({type:'planStarted'});
 await new Promise(setImmediate);
 fixture.processes[start].emit('close',0,null);
 await new Promise(setImmediate);
 fixture.processes[start+1].stdout.emit('data',Buffer.from(JSON.stringify({resource_changes:addresses.map(address=>({address,mode:'managed',type:'mock',name:'item',change:{actions:['update'],before:{token:'prod'},after:{token:'changed'}}}))})));
 fixture.processes[start+1].emit('close',0,null);
 await pending;
 const display=ui.messages.filter(m=>m.type==='planComplete').at(-1);
 assert.ok(display);
 ui.deliver(display);
 return display;
}

test('Plan -> rendered collision rows -> Apply argv resolves opaque IDs to original addresses including literal [REDACTED]',async()=>{
 const ui=createPanel();
 const fixture=runnerFixture();
 ui.instance.runner=fixture.runner;
 const addresses=['mock.item["prod"]','mock.item["prod-west"]','mock.item["[REDACTED]"]'];
 try {
  await ui.instance.executionSettings.save('/a','terraform',JSON.stringify({TF_WORKSPACE:'prod',TOKEN:'update',MODE:'managed'}));
  ui.deliver({type:'terraformRoots',roots:['/a','/b']});
  for(const selection of [[0],[1],[2],[0,2]]) {
   const display=await completePanelPlan(ui,fixture,addresses);
   const rows=display.plan.resourceChanges;
   assert.equal(rows[0].address,rows[2].address);
   assert.equal(new Set(rows.map(r=>r.selectionId)).size,3);
   assert.equal(JSON.stringify(display).includes('prod'),false);
   assert.deepEqual(rows.map(r=>r.actions),[['update'],['update'],['update']]);
   assert.equal(rows.every(r=>r.mode==='managed'),true);
   const boxes=ui.dom.window.document.querySelectorAll('.resource-item input[type=checkbox]');
   for(const i of selection) boxes[i].click();
   ui.dom.window.document.getElementById('applyBtn').click();
   const request=ui.sent.at(-1);
   assert.deepEqual(Array.from(request.targets),selection.map(i=>rows[i].selectionId));
   await ui.receive(request);
   assert.deepEqual(fixture.calls.at(-1)[1].filter(a=>a.startsWith('-target=')),selection.map(i=>'-target='+addresses[i]));
   fixture.processes.at(-1).emit('close',0,null);
  }
 } finally {ui.dom.window.close();}
});

test('Masking never changes managed/data/no-op or replacement semantics even when settings overlap keywords',()=>{
 const {parsePlanJson}=require('../out/planParser');
 const source={resource_changes:[
  {address:'mock.noop',mode:'managed',type:'mock',name:'noop',change:{actions:['no-op'],before:null,after:null}},
  {address:'data.mock.read',mode:'data',type:'mock',name:'read',change:{actions:['no-op'],before:null,after:{a:'create'}}},
  {address:'mock.replace',mode:'managed',type:'mock',name:'replace',change:{actions:['delete','create'],before:null,after:null}},
 ]};
 const plan=parsePlanJson(JSON.stringify(source));
 const display=maskPlanForDisplay(plan,executionSnapshot({executable:'terraform',environment:{A:'managed',B:'data',C:'create',D:'delete',E:'no-op',F:'read'}}));
 assert.equal(display.resourceChanges.length,2);
 assert.equal(display.resourceChanges[0].mode,'data');
 assert.deepEqual(display.resourceChanges[0].actions,['read']);
 assert.deepEqual(display.resourceChanges[1].actions,['delete','create']);
 assert.equal(display.resourceChanges[1].mode,'managed');
});

test('Two actual panel instances reject Apply after every saved execution context change; fresh plan permits updated context',async()=>{
 const initial={executable:'terraform',environment:{TF_WORKSPACE:'prod',GOOGLE_APPLICATION_CREDENTIALS:'/mock/first.json',HTTPS_PROXY:'http://first.invalid',REMOVE:null}};
 const changes=[
  {...initial,executable:'/mock/executable with spaces'},
  {...initial,environment:{...initial.environment,TF_WORKSPACE:'other'}},
  {...initial,environment:{...initial.environment,GOOGLE_APPLICATION_CREDENTIALS:'/mock/second.json'}},
  {...initial,environment:{...initial.environment,HTTPS_PROXY:'http://second.invalid'}},
  {...initial,environment:{...initial.environment,REMOVE:'restored'}},
  {executable:'terraform',environment:{}},
 ];
 for(const changed of changes) {
  const first=createPanel();
  const second=createPanel(first);
  const calls=[];
  first.instance.runner.plan=async()=>rawPlan();
  first.instance.runner.apply=(...args)=>{calls.push(args); return {process:processMock(),writeInput(){}};};
  try {
   assert.equal(first.instance.runner,second.instance.runner);
   await first.instance.executionSettings.save('/a',initial.executable,JSON.stringify(initial.environment));
   await first.receive({type:'runPlan',root:'/a',parallelism:2});
   const id=first.messages.find(m=>m.type==='planComplete').plan.resourceChanges[0].selectionId;
   let prompt=0;
   first.vscode.window.showInputBox=async()=>++prompt===1?changed.executable:JSON.stringify(changed.environment);
   await second.receive({type:'configureExecution',root:'/a'});
   await first.receive({type:'applyTargets',root:'/a',targets:[id],parallelism:2});
   assert.equal(calls.length,0);
   assert.match(first.messages.at(-1).error,/fresh plan/);
   assert.equal(first.instance.currentPlan,null);
   await first.receive({type:'runPlan',root:'/a',parallelism:2});
   const fresh=first.messages.filter(m=>m.type==='planComplete').at(-1).plan.resourceChanges[0].selectionId;
   await first.receive({type:'applyTargets',root:'/a',targets:[fresh],parallelism:2});
   assert.equal(calls.length,1);
   assert.deepEqual(calls[0].at(-1),changed);
   assert.deepEqual(calls[0][1],['mock.a']);
   first.instance.applyHandle.process.emit('close',0);
  } finally {first.dom.window.close();second.dom.window.close();}
 }
});

test('Independent persisted settings writer invalidates old plan without relying on shared panel memory',async()=>{
 const ui=createPanel();
 let launches=0;
 ui.instance.runner.plan=async()=>rawPlan();
 ui.instance.runner.apply=()=>{launches++;throw Error('must not launch');};
 try {
  await ui.receive({type:'runPlan',root:'/a',parallelism:1});
  const id=ui.messages.find(m=>m.type==='planComplete').plan.resourceChanges[0].selectionId;
  const otherWindow=new ExecutionSettings(new HostSecrets(ui.secrets,ui.storageUri,false));
  await otherWindow.save('/a','terraform','{"TF_WORKSPACE":"other-window"}');
  await ui.receive({type:'applyTargets',root:'/a',targets:[id],parallelism:1});
  assert.equal(launches,0);
  assert.match(ui.messages.at(-1).error,/fresh plan/);
 }finally{ui.dom.window.close();}
});

test('Apply fails closed for foreign root, forged display address, empty selection and expired plan IDs',async()=>{
 for(const kind of ['root','forged','empty','expired','failed-plan']) {
  const ui=createPanel(); let launches=0;
  ui.instance.runner.plan=async()=>rawPlan();
  ui.instance.runner.apply=()=>{launches++;throw Error('must not launch');};
  try {
   await ui.receive({type:'runPlan',root:'/a',parallelism:1});
   const id=ui.messages.find(m=>m.type==='planComplete').plan.resourceChanges[0].selectionId;
   if(kind==='expired')await ui.receive({type:'runPlan',root:'/a',parallelism:1});
   if(kind==='failed-plan'){ui.instance.runner.plan=async()=>{throw Error('mock failure');};await ui.receive({type:'runPlan',root:'/a',parallelism:1});}
   await ui.receive({type:'applyTargets',root:kind==='root'?'/b':'/a',targets:kind==='empty'?[]:kind==='forged'?['mock.a']:[id],parallelism:1});
   assert.equal(launches,0);
   assert.match(ui.messages.at(-1).error,/fresh plan/);
  }finally{ui.dom.window.close();}
 }
});

test('Execution identity compares complete literal settings independent of JSON environment key order',()=>{
 assert.equal(executionIdentity({executable:'terraform',environment:{A:'a',B:null}}),executionIdentity({executable:'terraform',environment:{B:null,A:'a'}}));
 assert.notEqual(executionIdentity({executable:'terraform',environment:{A:'a'}}),executionIdentity({executable:'terraform',environment:{A:'b'}}));
});
