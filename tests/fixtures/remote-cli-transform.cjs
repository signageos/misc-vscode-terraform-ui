const path = require('node:path');
const url = require('node:url');

// Source-derived URL transformation only, not a replacement CLI. Official tagged sources:
// https://github.com/microsoft/vscode/blob/1.93.0/src/vs/server/node/server.cli.ts
// https://github.com/microsoft/vscode/blob/1.95.3/src/vs/server/node/server.cli.ts
// https://github.com/microsoft/vscode/blob/1.96.0/src/vs/server/node/server.cli.ts
// openInBrowser chooses url.parse or pathToURI; pathToURI trims, resolves against
// preferredCwd, then calls pathToFileURL. Only the recognition expression changes.
const recognizedUrls = new Map([
	['1.93.0', /^(http|https|file):\/\//],
	['1.95.3', /^(http|https|file):\/\//],
	['1.96.0', /^[a-z-]+:\/\/.+/],
]);

function openExternalUri(version, location, preferredCwd) {
	const recognized = recognizedUrls.get(version);
	if (!recognized) throw new Error('Unverified VS Code CLI version');
	return recognized.test(location)
		? url.parse(location).href
		: url.pathToFileURL(path.resolve(preferredCwd, location.trim())).href;
}

function handlerUri(location) {
	const parsed = new URL(location);
	return {
		scheme: parsed.protocol.slice(0, -1), authority: parsed.host, path: parsed.pathname,
		query: parsed.search.slice(1), fragment: parsed.hash.slice(1),
	};
}

module.exports = { openExternalUri, handlerUri };
