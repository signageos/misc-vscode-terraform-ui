const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsePlanJson, buildResourceDiff } = require('../out/planParser');
const { createPanel } = require('./helpers.cjs');

function fixture() {
	return parsePlanJson(fs.readFileSync(path.join(__dirname, 'fixtures/multiline.json'), 'utf8')).resourceChanges[0];
}

test('multiline regression: second removed/added template lines retain their diff prefixes', () => {
	const text = buildResourceDiff(fixture());
	assert.match(text, /^  - old two$/m);
	assert.match(text, /^  \+ new two$/m);
	assert.match(text, /^    start$/m);
	assert.match(text, /^    end$/m);
});

test('multiline regression: actual rendered DOM colors every changed line and preserves context', () => {
	const ui = createPanel();
	try {
		const resource = fixture();
		ui.deliver({ type: 'planComplete', plan: { resourceChanges: [{ ...resource, diffText: buildResourceDiff(resource) }] } });
		const rows = [...ui.dom.window.document.querySelectorAll('#diffContent > div')];
		assert.equal(rows.find((row) => row.textContent.includes('old two')).className, 'line-remove');
		assert.equal(rows.find((row) => row.textContent.includes('new two')).className, 'line-add');
		assert.equal(rows.find((row) => row.textContent.includes('start')).className, 'line-unchanged');
	} finally { ui.dom.window.close(); }
});


for (const [name, before, after, afterUnknown, prefix] of [
	['create', null, { content: 'first\nsecond\n' }, {}, '+ '],
	['delete', { content: 'first\nsecond\n' }, null, {}, '- '],
	['unknown', { content: 'first\nsecond\n' }, { content: null }, { content: true }, '  - '],
]) {
	test(`multiline ${name}: every physical value line is classified`, () => {
		const text = buildResourceDiff({ ...fixture(), before, after, afterUnknown });
		assert.ok(text.split('\n').includes(prefix + 'second'));
		assert.ok(text.split('\n').includes(prefix + 'EOT'));
		if (name === 'unknown') assert.match(text, /  \+ \(known after apply\)/);
	});
}

test('heredoc delimiter collisions, literal templates, blank lines, tabs and newline changes stay visible', () => {
	const content = 'EOT\nEOT_1\n\t${literal}\n\nlast';
	const text = buildResourceDiff({ ...fixture(), before: { content }, after: { content: content + '\n' } });
	assert.match(text, /<<-EOT_2/);
	assert.ok(text.split('\n').includes('    \t${literal}'));
	assert.ok(text.split('\n').includes('    '));
	assert.ok(text.split('\n').includes('  - \\ No newline at end of value'));
	assert.equal(text.split('\n').filter((line) => line === '    EOT_2').length, 1);
	const crlf = buildResourceDiff({ ...fixture(), before: null, after: { content: 'first\r\nsecond\r\n' } });
	assert.ok(crlf.split('\n').includes('+ second\\r'));
	assert.equal(crlf.includes('\r'), false);
});

test('carriage returns and literal backslash-r remain distinguishable in both diff directions and actual DOM', () => {
	for (const reverse of [false, true]) {
		const values = ['first\r\nsecond\n', 'first\\r\nsecond\n'];
		if (reverse) values.reverse();
		const resource = { ...fixture(), before: { content: values[0] }, after: { content: values[1] } };
		const text = buildResourceDiff(resource);
		const removed = 'first' + '\\'.repeat(reverse ? 2 : 1) + 'r';
		const added = 'first' + '\\'.repeat(reverse ? 1 : 2) + 'r';
		assert.ok(text.split('\n').includes('  - ' + removed), text);
		assert.ok(text.split('\n').includes('  + ' + added), text);
		assert.ok(text.split('\n').includes('    second'), text);
		assert.equal(text.includes('\r'), false);
		const ui = createPanel();
		try {
			ui.deliver({ type: 'planComplete', plan: { resourceChanges: [{ ...resource, diffText: text }] } });
			const rows = [...ui.dom.window.document.querySelectorAll('#diffContent > div')];
			assert.equal(rows.find(row => row.textContent === '  - ' + removed).className, 'line-remove');
			assert.equal(rows.find(row => row.textContent === '  + ' + added).className, 'line-add');
		} finally { ui.dom.window.close(); }
	}
});

test('object line diffs preserve context instead of misclassifying braces or unchanged JSON', () => {
	const text = buildResourceDiff(fixture());
	assert.match(text, /^      "a": 1,$/m);
	assert.match(text, /^  -   "b": 2$/m);
	assert.match(text, /^  \+   "b": 3$/m);
	assert.match(text, /^    \}$/m);
});

test('bounded line diff fallback still prefixes every physical line', () => {
	const { loadWithMocks } = require('./helpers.cjs');
	const { buildResourceDiff: fallback } = loadWithMocks('../out/planParser', { diff: { diffArrays: () => undefined } });
	const text = fallback(fixture());
	assert.match(text, /^  - old two$/m);
	assert.match(text, /^  \+ new two$/m);
});

test('actual DOM treats templates and malicious HTML as text, including unchanged sign-prefixed lines', () => {
	const ui = createPanel();
	try {
		const content = '<img src=x onerror="window.injected=true">\n<script>window.injected=true</script>\n${notJavaScript}\n';
		const resource = { ...fixture(), address: '<img src=x onerror="window.injected=true">', after: { content, unchanged: fixture().before.unchanged } };
		ui.deliver({ type: 'planComplete', plan: { resourceChanges: [{ ...resource, diffText: buildResourceDiff(resource) }, { ...fixture(), diffText: buildResourceDiff(fixture()) }] } });
		const doc = ui.dom.window.document;
		assert.equal(doc.querySelector('#diffContent img'), null);
		assert.equal(doc.querySelector('#resourceItems img'), null);
		assert.equal(ui.dom.window.injected, undefined);
		assert.ok(doc.querySelector('#diffContent').textContent.includes('<script>window.injected=true</script>'));
		const rows = [...doc.querySelectorAll('#diffContent > div')];
		assert.equal(rows.find((row) => row.textContent.includes('+ not an addition')).className, 'line-unchanged');
		assert.equal(rows.find((row) => row.textContent.includes('- not a removal')).className, 'line-unchanged');
		doc.querySelectorAll('.resource-item')[1].click();
		assert.ok(doc.querySelector('#diffHeader').textContent.includes('local_file.template'));
		const checkbox = doc.querySelector('.resource-item input');
		checkbox.click();
		assert.ok(doc.querySelector('#applyBar').classList.contains('visible'));
	} finally { ui.dom.window.close(); }
});
