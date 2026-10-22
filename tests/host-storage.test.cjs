const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hostStoragePath } = require('../out/hostStorage');

function uri(change = {}) {
	return { scheme: 'vscode-userdata', authority: '', path: '/tmp/profile with spaces/User/globalStorage/signageos.terraform-ui', query: '', fragment: '',
		get fsPath() { return this.path; }, ...change };
}

test('actual native desktop globalStorageUri resolves only on the local desktop host', () => {
	assert.equal(hostStoragePath(uri(), true), uri().path);
	assert.throws(() => hostStoragePath(uri(), false));
	assert.equal(hostStoragePath(uri({ scheme: 'file' }), false), uri().path);
});

for (const change of [{ scheme: 'https' }, { scheme: 'vscode-remote' }, { authority: 'foreign' }, { query: 'x' }, { fragment: 'x' }, { path: 'relative' }, { path: '/tmp/\0invalid' }]) {
	test(`host storage rejects foreign or ambiguous URI: ${JSON.stringify(change)}`, () => {
		assert.throws(() => hostStoragePath(uri(change), true));
		assert.throws(() => hostStoragePath(uri({ ...change, scheme: 'file', authority: 'foreign' }), true));
	});
}
