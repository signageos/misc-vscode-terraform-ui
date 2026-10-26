import type * as vscode from 'vscode';

/** Strict application parameters plus opaque, session-minted VS Code routing metadata. */
export function parseTerminalQuery(query: string, withCwd = false): Map<string, string> | undefined {
	if (!query || query.length > 65536 || /%(?![a-f0-9]{2})/i.test(query)) return;
	const parameters = new Map<string, string>();
	for (const part of query.split('&')) {
		if (!/^[a-z][a-z0-9]*=/i.test(part)) return;
		const entries = [...new URLSearchParams(part)];
		const entry = entries[0];
		if (entries.length !== 1 || !entry || parameters.has(entry[0])) return;
		parameters.set(entry[0], entry[1]);
	}
	if (!/^[a-f0-9]{64}$/.test(parameters.get('token') || '')) return;
	if (withCwd) {
		if (!/^[A-Za-z0-9_-]+$/.test(parameters.get('cwd') || '')) return;
	} else if (parameters.has('cwd')) return;
	return parameters;
}

export function matchesTerminalQuery(query: string, minted: string, withCwd = false): boolean {
	const actual = parseTerminalQuery(query, withCwd);
	const expected = parseTerminalQuery(minted);
	if (!actual || !expected || actual.size !== expected.size + (withCwd ? 1 : 0)) return false;
	for (const [key, value] of expected) {
		if (actual.get(key) !== value) return false;
	}
	return true;
}

/** Resolve in the owning extension host; never manufacture or guess window routing fields. */
export async function resolveTerminalUri(
	target: vscode.Uri,
	resolve: (uri: vscode.Uri) => Thenable<vscode.Uri>,
): Promise<vscode.Uri> {
	const external = await resolve(target);
	const original = parseTerminalQuery(target.query);
	const resolved = parseTerminalQuery(external.query);
	if (
		external.scheme !== target.scheme ||
		external.authority !== target.authority ||
		external.path !== target.path ||
		external.fragment ||
		!original ||
		!resolved ||
		resolved.get('token') !== original.get('token')
	) {
		throw new Error('Unsupported terminal callback routing');
	}
	return external;
}

/** VS Code URI serialization encodes the query; its handler receives it decoded once. */
export function parseSerializedTerminalQuery(serialized: string): Map<string, string> | undefined {
	try {
		return parseTerminalQuery(decodeURIComponent(serialized));
	} catch {
		return;
	}
}
