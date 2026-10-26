const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseTerminalQuery, matchesTerminalQuery, resolveTerminalUri } = require('../out/terminalUri');
const { uri } = require('./fixtures/terminal-uri.cjs');
const token = 'a'.repeat(64);
const query = `token=${token}&windowId=14`;

test('only exactly minted metadata survives routing; order is not significant', () => {
	assert.equal(matchesTerminalQuery(`windowId=14&token=${token}`, query), true);
	assert.equal(matchesTerminalQuery(query + '&cwd=L3Byb2plY3Q', query, true), true);
	for (const bad of [
		`token=${token}`, query + '&extra=1', query.replace('14', '15'), query + '&windowId=14',
		query + `&token=${token}`, query + `&tok%65n=${token}`, query + '&cwd=L3Byb2plY3Q&cwd=Lw',
		query + '&extra=%ZZ', query + '&', query + '&&extra=1', query.replace('token=', 'token'),
	]) {
		assert.equal(matchesTerminalQuery(bad, query), false, bad);
	}
	for (const bad of [`token=${token}&cwd=Lw`, `token=${token}&token=${token}`, `tok%65n=${token}`, query + '#x']) {
		// A query containing '#' is not a whole URI; it cannot match our minted metadata either.
		assert.equal(matchesTerminalQuery(bad, query), false);
	}
	assert.equal(parseTerminalQuery('x'.repeat(65537)), undefined);
});

test('externalization preserves route and exact token; transformed/ambiguous callbacks fail closed', async () => {
	const target = uri({ scheme: 'vscode', authority: 'signageos.terraform-ui', path: '/launch', query: `token=${token}` });
	const resolved = await resolveTerminalUri(target, async value => value.with({ query }));
	assert.equal(resolved.query, query);
	for (const change of [
		{ scheme: 'https' }, { authority: 'other.extension' }, { path: '/terminal' }, { fragment: 'hidden' },
		{ query: query.replace(token, 'b'.repeat(64)) }, { query: query + '&cwd=Lw' },
		{ query: query + '&token=' + token }, { query: query + '&windowId=16' },
	]) {
		await assert.rejects(resolveTerminalUri(target, async value => value.with(change)), /Unsupported terminal callback routing/);
	}
});

test('serialized queries decode exactly once like actual VS Code URI dispatch', () => {
	const { URI } = require('vscode-uri');
	const { parseSerializedTerminalQuery } = require('../out/terminalUri');
	const query = 'token=' + 'a'.repeat(64) + '&windowId=7&nonce=%26%3D%25';
	const serialized = URI.from({ scheme: 'vscode', authority: 'company.extension', path: '/launch', query }).toString().split('?')[1];
	assert.notEqual(serialized, query);
	const parsed = parseSerializedTerminalQuery(serialized);
	assert.equal(parsed.get('nonce'), '&=%');
	assert.equal(parsed.get('windowId'), '7');
	assert.equal(parseSerializedTerminalQuery(serialized + '%'), undefined);
	assert.equal(parseSerializedTerminalQuery(encodeURIComponent('token=' + 'a'.repeat(64) + '&token=' + 'b'.repeat(64))), undefined);
});
