const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPanel, loadWithMocks } = require('./helpers.cjs');
const { executionIdentity } = require('../out/execution');

const tick = () => new Promise(setImmediate);
const operations = ['runInit', 'runPlan', 'applyTargets'];
const emptyPlan = JSON.stringify({ resource_changes: [] });

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfui-lock-tests-'));
	const roots = ['first', 'second'].map((name) => path.join(directory, name));
	roots.forEach((root) => fs.mkdirSync(root));
	const alias = path.join(directory, 'alias');
	fs.symlinkSync(roots[0], alias, 'dir');
	const calls = [];
	const planDirectories = [];
	let throwSpawn = false;
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {
		fs: {
			...fs,
			mkdtempSync: (prefix) => {
				const directory = fs.mkdtempSync(prefix);
				planDirectories.push(directory);
				return directory;
			},
		},
		child_process: {
			spawn: (executable, args, options) => {
				if (throwSpawn) throw Error('PRIVATE spawn diagnostic');
				const proc = new EventEmitter();
				proc.stdout = new EventEmitter();
				proc.stderr = new EventEmitter();
				proc.stdin = { write() {} };
				proc.kill = (signal) => {
					proc.signal = signal;
					return true;
				};
				calls.push({ executable, args, options, proc });
				return proc;
			},
		},
	});
	const first = createPanel();
	const second = createPanel(first);
	for (const ui of [first, second]) {
		ui.instance.terraformRoots = [...roots, alias];
		ui.instance.runner = new TerraformRunner();
	}
	t.after(() => {
		first.dom.window.close();
		second.dom.window.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return {
		first,
		second,
		roots,
		alias,
		calls,
		planDirectories,
		TerraformRunner,
		setSpawnFailure: (value) => {
			throwSpawn = value;
		},
	};
}

function request(ui, type, root) {
	if (type === 'applyTargets') {
		// Supply a valid host-side approval; execution/root/ID safety is independently exercised in execution.test.cjs.
		ui.instance.currentPlan = {
			root,
			canonicalRoot: fs.realpathSync(root),
			executionIdentity: executionIdentity({ executable: 'terraform', environment: {} }),
			targets: new Map([['approved-id', 'mock.a']]),
		};
	}
	return ui.receive({ type, root, arguments: '', parallelism: 2, targets: ['approved-id'] });
}

async function finish(f, call, code = 0) {
	call.proc.emit('close', code, null);
	await tick();
	if (call.args[0] === 'plan' && code === 0 && !call.proc.signal) {
		const show = f.calls.find(
			(next) => next.args[0] === 'show' && next.options.cwd === call.options.cwd && !next.finished,
		);
		assert.ok(show, 'Plan must retain its operation through Show');
		show.finished = true;
		show.proc.stdout.emit('data', Buffer.from(emptyPlan));
		show.proc.emit('close', 0, null);
		await tick();
	}
}

for (const ownerType of operations) {
	for (const contenderType of operations) {
		for (const spelling of ['same', 'alias']) {
			test(`${ownerType} excludes ${contenderType} for ${spelling} canonical root`, async (t) => {
				const f = fixture(t);
				const pending = request(f.first, ownerType, f.roots[0]);
				await tick();
				assert.equal(f.calls.length, 1);
				await request(f.second, contenderType, spelling === 'same' ? f.roots[0] : f.alias);
				assert.equal(f.calls.length, 1, 'negative control: same-state work cannot spawn');
				assert.match(f.second.messages.at(-1).error, /already running/);
				await finish(f, f.calls[0]);
				await pending;
				const retry = request(f.second, contenderType, f.roots[0]);
				await tick();
				const started = f.calls.at(-1);
				assert.equal(
					started.args[0],
					contenderType === 'runInit' ? 'init' : contenderType === 'runPlan' ? 'plan' : 'apply',
				);
				await finish(f, started);
				await retry;
			});
		}
		test(`${ownerType} overlaps ${contenderType} in a distinct root`, async (t) => {
			const f = fixture(t);
			const first = request(f.first, ownerType, f.roots[0]);
			const second = request(f.second, contenderType, f.roots[1]);
			await tick();
			assert.equal(f.calls.length, 2, 'both processes start before either closes');
			assert.notEqual(f.first.instance.runner, f.second.instance.runner);
			await finish(f, f.calls[0]);
			await finish(f, f.calls[1]);
			await Promise.all([first, second]);
		});
	}
}

for (const type of operations) {
	test(`${type} reserves before asynchronous preflight and cannot overwrite its own lease`, async (t) => {
		const f = fixture(t);
		let release;
		f.first.instance.executionSettings.load = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const pending = request(f.first, type, f.roots[0]);
		await tick();
		await request(f.first, 'runInit', f.roots[1]);
		await request(f.second, 'runInit', f.alias);
		assert.equal(f.calls.length, 0);
		assert.match(f.first.messages.at(-1).error, /already running/);
		assert.match(f.second.messages.at(-1).error, /already running/);
		// A rejected second-root request must not reserve or steal that root.
		const unrelated = request(f.second, 'runInit', f.roots[1]);
		await tick();
		assert.equal(f.calls.length, 1);
		await finish(f, f.calls[0]);
		await unrelated;
		release({ executable: 'terraform', environment: {} });
		await tick();
		assert.equal(f.calls.length, 2);
		await finish(f, f.calls[1]);
		await pending;
	});

	for (const action of ['cancel', 'dispose', 'error']) {
		test(`${type}: ${action} retains ownership until actual close and cannot affect another root`, async (t) => {
			const f = fixture(t);
			const pending = request(f.first, type, f.roots[0]);
			const other = request(f.second, 'runInit', f.roots[1]);
			await tick();
			const owned = f.calls.find((call) => call.options.cwd === f.roots[0]);
			const independent = f.calls.find((call) => call.options.cwd === f.roots[1]);
			if (action === 'cancel') await f.first.receive({ type: 'cancelApply' });
			else if (action === 'dispose') f.first.instance.dispose();
			else owned.proc.emit('error', Error('PRIVATE asynchronous process diagnostic'));
			await tick();
			assert.equal(independent.proc.signal, undefined);
			assert.equal(owned.proc.signal, action === 'error' ? undefined : 'SIGTERM');
			await finish(f, independent);
			await other;
			await request(f.second, 'runInit', f.alias);
			assert.equal(f.calls.length, 2);
			assert.match(f.second.messages.at(-1).error, /already running/);
			owned.proc.emit('close', action === 'error' ? -2 : null, action === 'error' ? null : 'SIGTERM');
			await pending;
			const next = request(f.second, 'runInit', f.alias);
			await tick();
			assert.equal(f.calls.length, 3);
			// Stale callbacks from a former owner cannot release or cancel the replacement.
			owned.proc.emit('close', 0, null);
			await tick();
			assert.equal(f.second.instance.ownsOperation, true);
			assert.equal(f.calls[2].proc.signal, undefined);
			const third = createPanel(f.first);
			third.instance.terraformRoots = [f.roots[0]];
			t.after(() => third.dom.window.close());
			await request(third, 'runInit', f.roots[0]);
			assert.match(third.messages.at(-1).error, /already running/);
			assert.equal(f.calls.length, 3);
			assert.equal(JSON.stringify(f.first.messages).includes('PRIVATE'), false);
			await finish(f, f.calls[2]);
			await next;
		});
	}

	for (const failure of ['preflight', 'sync-spawn']) {
		test(`${type} releases after ${failure} failure`, async (t) => {
			const f = fixture(t);
			if (failure === 'preflight')
				f.first.instance.executionSettings.load = async () => {
					throw Error('PRIVATE');
				};
			else f.setSpawnFailure(true);
			await request(f.first, type, f.roots[0]);
			assert.equal(f.calls.length, 0);
			assert.equal(f.first.instance.ownsOperation, false);
			assert.ok(f.planDirectories.every((directory) => !fs.existsSync(directory)));
			assert.equal(JSON.stringify(f.first.messages).includes('PRIVATE'), false);
			f.setSpawnFailure(false);
			const next = request(f.second, 'runInit', f.alias);
			await tick();
			assert.equal(f.calls.length, 1);
			await finish(f, f.calls[0]);
			await next;
		});
	}
}

test('Plan/Show gap keeps the lease and cancellation there prevents Show', async (t) => {
	const f = fixture(t);
	const pending = request(f.first, 'runPlan', f.roots[0]);
	await tick();
	f.calls[0].proc.emit('close', 0, null);
	const competitor = request(f.second, 'runInit', f.alias);
	await f.first.receive({ type: 'cancelApply' });
	await competitor;
	await pending;
	assert.equal(f.calls.length, 1);
	assert.match(f.first.messages.at(-1).error, /canceled/);
});

test('Show retains ownership and cancellation never publishes an approved plan', async (t) => {
	const f = fixture(t);
	const pending = request(f.first, 'runPlan', f.roots[0]);
	await tick();
	f.calls[0].proc.emit('close', 0, null);
	await tick();
	assert.equal(f.calls[1].args[0], 'show');
	await f.first.receive({ type: 'cancelApply' });
	await request(f.second, 'runInit', f.alias);
	assert.equal(f.calls.length, 2);
	f.calls[1].proc.stdout.emit('data', Buffer.from(emptyPlan));
	f.calls[1].proc.emit('close', 0, null);
	await pending;
	assert.equal(f.first.instance.currentPlan, null);
	assert.match(f.first.messages.at(-1).error, /canceled/);
});

test('Canonical lookup fails closed without revealing a path or leaving a lease', async (t) => {
	const f = fixture(t);
	const missing = path.join(f.roots[0], 'PRIVATE-missing');
	f.first.instance.terraformRoots.push(missing);
	await request(f.first, 'runInit', missing);
	assert.equal(f.calls.length, 0);
	assert.equal(f.first.instance.ownsOperation, false);
	assert.equal(JSON.stringify(f.first.messages).includes('PRIVATE'), false);
});

test('Frozen clocks cannot collide; concurrent plans retain and clean only their own temporary files', async (t) => {
	const f = fixture(t);
	const realNow = Date.now;
	Date.now = () => 123;
	try {
		const first = request(f.first, 'runPlan', f.roots[0]);
		const second = request(f.second, 'runPlan', f.roots[1]);
		await tick();
		const files = f.calls.map((call) => call.args.find((arg) => arg.startsWith('-out=')).slice(5));
		assert.notEqual(files[0], files[1]);
		assert.notEqual(path.dirname(files[0]), path.dirname(files[1]));
		for (const file of files) {
			assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
			fs.writeFileSync(file, 'owned private mock plan');
		}
		const foreignFile = path.join(path.dirname(path.dirname(files[0])), 'tfplan-123');
		fs.writeFileSync(foreignFile, 'unowned negative control', { flag: 'wx' });
		t.after(() => fs.rmSync(foreignFile, { force: true }));
		f.calls[0].proc.emit('error', Error('PRIVATE'));
		await tick();
		assert.equal(fs.existsSync(files[0]), true, 'no cleanup while a process may still write');
		f.calls[0].proc.emit('close', -2, null);
		await first;
		assert.equal(fs.existsSync(path.dirname(files[0])), false);
		assert.equal(fs.readFileSync(files[1], 'utf8'), 'owned private mock plan');
		await finish(f, f.calls[1]);
		await second;
		assert.equal(fs.existsSync(path.dirname(files[1])), false);
		assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'unowned negative control');
	} finally {
		Date.now = realNow;
	}
});

for (const failure of ['plan-exit', 'show-error', 'show-sync-spawn', 'show-json', 'cancel-plan', 'cancel-show']) {
	test(`Temporary plan directory cleanup after ${failure}`, async (t) => {
		const f = fixture(t);
		const pending = request(f.first, 'runPlan', f.roots[0]);
		await tick();
		const plan = f.calls[0];
		const file = plan.args.find((arg) => arg.startsWith('-out=')).slice(5);
		fs.writeFileSync(file, 'private mock plan');
		if (failure === 'plan-exit') plan.proc.emit('close', 1, null);
		else if (failure === 'cancel-plan') {
			await f.first.receive({ type: 'cancelApply' });
			plan.proc.emit('close', null, 'SIGTERM');
		} else if (failure === 'show-sync-spawn') {
			f.setSpawnFailure(true);
			plan.proc.emit('close', 0, null);
		} else {
			plan.proc.emit('close', 0, null);
			await tick();
			const show = f.calls[1];
			if (failure === 'show-error') show.proc.emit('error', Error('PRIVATE'));
			if (failure === 'cancel-show') await f.first.receive({ type: 'cancelApply' });
			show.proc.stdout.emit('data', Buffer.from('not json'));
			assert.equal(fs.existsSync(file), true);
			show.proc.emit('close', failure === 'show-error' ? -2 : 0, null);
		}
		await pending;
		assert.equal(fs.existsSync(path.dirname(file)), false);
		assert.equal(f.first.instance.currentPlan, null);
	});
}

for (const type of operations) {
	test(`${type} uses the canonical cwd captured before asynchronous preflight`, async (t) => {
		const f = fixture(t);
		let release;
		f.first.instance.executionSettings.load = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const pending = request(f.first, type, f.alias);
		await tick();
		fs.unlinkSync(f.alias);
		fs.symlinkSync(f.roots[1], f.alias, 'dir');
		release({ executable: 'terraform', environment: {} });
		await tick();
		assert.equal(f.calls[0].options.cwd, f.roots[0]);
		await finish(f, f.calls[0]);
		await pending;
	});
}

test('Apply rejects a retargeted symlink even when root spelling and saved execution settings match', async (t) => {
	const f = fixture(t);
	const pending = request(f.first, 'runPlan', f.alias);
	await tick();
	f.calls[0].proc.emit('close', 0, null);
	await tick();
	f.calls[1].proc.stdout.emit(
		'data',
		Buffer.from(
			JSON.stringify({
				resource_changes: [
					{
						address: 'mock.a',
						mode: 'managed',
						type: 'mock',
						name: 'a',
						change: { actions: ['create'], before: null, after: {} },
					},
				],
			}),
		),
	);
	f.calls[1].proc.emit('close', 0, null);
	await pending;
	const target = f.first.messages.find((message) => message.type === 'planComplete').plan.resourceChanges[0]
		.selectionId;
	fs.unlinkSync(f.alias);
	fs.symlinkSync(f.roots[1], f.alias, 'dir');
	await f.first.receive({ type: 'applyTargets', root: f.alias, targets: [target], parallelism: 2 });
	assert.equal(f.calls.length, 2);
	assert.match(f.first.messages.at(-1).error, /fresh plan/);
});

test('Disposal during preflight prevents spawning and releases only after preflight returns', async (t) => {
	const f = fixture(t);
	let release;
	f.first.instance.executionSettings.load = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const pending = request(f.first, 'runInit', f.roots[0]);
	await tick();
	f.first.instance.dispose();
	await request(f.second, 'runPlan', f.alias);
	assert.match(f.second.messages.at(-1).error, /already running/);
	release({ executable: 'terraform', environment: {} });
	await pending;
	assert.equal(f.calls.length, 0);
	const next = request(f.second, 'runInit', f.alias);
	await tick();
	await finish(f, f.calls[0]);
	await next;
});

async function until(check) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, 'offline child failed to reach expected barrier');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test('Real offline child executables overlap across roots and retain the alias lease after SIGTERM until close', async (t) => {
	const f = fixture(t);
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {});
	const executable = path.join(path.dirname(f.roots[0]), 'offline-child');
	fs.writeFileSync(
		executable,
		`#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync('termination-requested', 'yes'));
fs.writeFileSync('started', JSON.stringify(process.argv.slice(2)));
const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); process.exit(0); } }, 10);
`,
		{ mode: 0o700 },
	);
	for (const ui of [f.first, f.second]) {
		ui.instance.runner = new TerraformRunner();
		ui.instance.executionSettings.load = async () => ({ executable, environment: {} });
	}
	const first = request(f.first, 'runInit', f.roots[0]);
	const second = request(f.second, 'runInit', f.roots[1]);
	try {
		await until(() => f.roots.every((root) => fs.existsSync(path.join(root, 'started'))));
		await f.first.receive({ type: 'cancelApply' });
		await until(() => fs.existsSync(path.join(f.roots[0], 'termination-requested')));
		assert.equal(fs.existsSync(path.join(f.roots[1], 'termination-requested')), false);
		fs.writeFileSync(path.join(f.roots[1], 'release'), 'yes');
		await second;
		await request(f.second, 'runInit', f.alias);
		assert.match(f.second.messages.at(-1).error, /already running/);
	} finally {
		for (const root of f.roots) fs.writeFileSync(path.join(root, 'release'), 'yes');
		await Promise.all([first, second]);
	}
});

test('Real asynchronous ENOENT spawn failure releases ownership after child close', async (t) => {
	const f = fixture(t);
	const { TerraformRunner } = loadWithMocks('../out/terraformRunner', {});
	f.first.instance.runner = new TerraformRunner();
	f.first.instance.executionSettings.load = async () => ({
		executable: path.join(f.roots[0], 'PRIVATE-missing'),
		environment: {},
	});
	await request(f.first, 'runInit', f.roots[0]);
	assert.equal(f.first.instance.ownsOperation, false);
	assert.equal(JSON.stringify(f.first.messages).includes('PRIVATE'), false);
	const next = request(f.second, 'runInit', f.alias);
	await tick();
	assert.equal(f.calls.length, 1);
	await finish(f, f.calls[0]);
	await next;
});

async function connectPanel(ui, root) {
	ui.instance.preselectedRoot = root;
	ui.connect();
	await tick();
	await Promise.all(ui.pending);
}

async function planThroughDOM(f, ui) {
	const start = f.calls.length;
	ui.dom.window.document.getElementById('planBtn').click();
	await tick();
	assert.equal(f.calls[start].args[0], 'plan');
	f.calls[start].proc.emit('close', 0, null);
	await tick();
	assert.equal(f.calls[start + 1].args[0], 'show');
	f.calls[start + 1].proc.stdout.emit(
		'data',
		Buffer.from(
			JSON.stringify({
				resource_changes: [
					{
						address: 'mock.a',
						mode: 'managed',
						type: 'mock',
						name: 'a',
						change: { actions: ['create'], before: null, after: { value: 1 } },
					},
				],
			}),
		),
	);
	f.calls[start + 1].proc.emit('close', 0, null);
	await Promise.all(ui.pending);
	const checkbox = ui.dom.window.document.querySelector('.resource-item input[type=checkbox]');
	assert.ok(checkbox, 'host plan result renders a selectable resource');
	checkbox.click();
	assert.equal(ui.dom.window.document.getElementById('applyBar').classList.contains('visible'), true);
	return ui.messages.filter((message) => message.type === 'planComplete').at(-1).plan.resourceChanges[0].selectionId;
}

for (const failedOperation of ['runPlan', 'applyTargets']) {
	test(`DOM ${failedOperation} canonical lookup failure clears approval and rejects old IDs after root restoration`, async (t) => {
		const f = fixture(t);
		const ui = f.first;
		await connectPanel(ui, f.alias);
		const oldId = await planThroughDOM(f, ui);
		fs.unlinkSync(f.alias);
		ui.dom.window.document.getElementById(failedOperation === 'runPlan' ? 'planBtn' : 'applyBtn').click();
		await Promise.all(ui.pending);
		assert.equal(ui.instance.currentPlan, null, 'failed canonical lookup must consume approval');
		assert.equal(ui.dom.window.document.querySelectorAll('.resource-item input[type=checkbox]').length, 0);
		assert.equal(ui.dom.window.document.getElementById('applyBar').classList.contains('visible'), false);
		const sentBeforeEmptyApply = ui.sent.length;
		ui.dom.window.document.getElementById('applyBtn').click();
		assert.equal(ui.sent.length, sentBeforeEmptyApply, 'cleared selections cannot send an Apply request');
		assert.match(ui.dom.window.document.getElementById('terminalOutput').textContent, /Could not resolve/);
		fs.symlinkSync(f.roots[0], f.alias, 'dir');
		ui.dom.window
			.acquireVsCodeApi()
			.postMessage({ type: 'applyTargets', root: f.alias, targets: [oldId], parallelism: 2 });
		await Promise.all(ui.pending);
		assert.equal(f.calls.length, 2, 'restoring the root must not resurrect an old approval');
		assert.match(ui.messages.at(-1).error, /fresh plan/);
		// Negative control: the restored root still supports a fresh, selectable plan.
		const freshId = await planThroughDOM(f, ui);
		assert.notEqual(freshId, oldId);
	});
}

test('DOM dispatch keeps independent panels enabled, same-key denial coherent, and cancel owner-only', async (t) => {
	const f = fixture(t);
	await connectPanel(f.first, f.roots[0]);
	await connectPanel(f.second, f.roots[1]);
	const a = f.first.dom.window.document;
	const b = f.second.dom.window.document;
	a.getElementById('planBtn').click();
	await tick();
	assert.equal(f.calls.length, 1);
	assert.equal(a.getElementById('planBtn').disabled, true);
	assert.equal(b.getElementById('planBtn').disabled, false, 'root A must not disable root B');
	assert.equal(b.getElementById('initBtn').disabled, false);
	b.getElementById('initBtn').click();
	await tick();
	assert.equal(f.calls.length, 2, 'independent DOM dispatch must start before A closes');
	assert.equal(b.getElementById('planBtn').disabled, true);
	a.getElementById('cancelOperationBtn').click();
	await tick();
	assert.equal(f.calls[0].proc.signal, 'SIGTERM');
	assert.equal(f.calls[1].proc.signal, undefined);
	assert.equal(a.getElementById('planBtn').disabled, true, 'owner remains busy until actual close');
	assert.equal(b.getElementById('planBtn').disabled, true, 'owner cancel must not reset another panel');
	await finish(f, f.calls[1]);
	await Promise.all(f.second.pending);
	assert.equal(b.getElementById('planBtn').disabled, false);
	// A third live webview selects the alias and must receive a coherent local denial.
	const contender = createPanel(f.first);
	contender.instance.terraformRoots = [f.alias];
	contender.instance.runner = new f.TerraformRunner();
	t.after(() => contender.dom.window.close());
	await connectPanel(contender, f.alias);
	const c = contender.dom.window.document;
	c.getElementById('planBtn').click();
	await Promise.all(contender.pending);
	assert.equal(f.calls.length, 2);
	assert.equal(c.getElementById('planBtn').disabled, false, 'denied webview leaves its pending state');
	assert.equal(c.getElementById('cancelOperationBtn').hidden, true);
	assert.match(c.getElementById('statusText').textContent, /already running/);
	assert.equal(a.getElementById('planBtn').disabled, true);
	// Even forged cancel from the denied webview cannot signal A or B.
	contender.dom.window.acquireVsCodeApi().postMessage({ type: 'cancelApply' });
	await Promise.all(contender.pending);
	assert.equal(f.calls[1].proc.signal, undefined);
	f.calls[0].proc.emit('close', null, 'SIGTERM');
	await Promise.all(f.first.pending);
	assert.equal(a.getElementById('planBtn').disabled, false);
	assert.equal(a.getElementById('cancelOperationBtn').hidden, true);
	// Same-key retry becomes usable only after the former owner's actual close.
	c.getElementById('initBtn').click();
	await tick();
	assert.equal(f.calls.length, 3);
	assert.equal(f.calls[2].options.cwd, f.roots[0]);
	c.getElementById('cancelOperationBtn').click();
	await tick();
	assert.equal(f.calls[2].proc.signal, 'SIGTERM');
	f.calls[2].proc.emit('close', null, 'SIGTERM');
	await Promise.all(contender.pending);
	assert.equal(c.getElementById('planBtn').disabled, false);
});
