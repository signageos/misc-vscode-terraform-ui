import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { matchesTerminalQuery, parseTerminalQuery, resolveTerminalUri } from './terminalUri';

export function registerTerminalCommand(open: (uri: vscode.Uri) => Promise<void>): vscode.Disposable {
	return vscode.commands.registerCommand('terraformUI.openFromTerminal', async () => {
		if (!vscode.workspace.isTrusted) {
			await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
			return;
		}

		const terminal = vscode.window.activeTerminal;
		if (!terminal) {
			await vscode.window.showWarningMessage('Open an integrated terminal first.');
			return;
		}

		await openTerminalFolder(terminal, open);
	});
}

async function openTerminalFolder(terminal: vscode.Terminal, open: (uri: vscode.Uri) => Promise<void>): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
		return;
	}
	const cwd = terminal.shellIntegration?.cwd;
	if (!cwd) {
		await vscode.window.showWarningMessage(
			'Terminal folder is unavailable. Enable VS Code terminal shell integration, wait for the prompt, and retry. You can also open Terraform UI from the Explorer.',
		);
		return;
	}

	await openCurrentFolder(cwd, open);
}

export async function openCurrentFolder(cwd: vscode.Uri, open: (uri: vscode.Uri) => Promise<void>): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
		return;
	}

	const folder = vscode.workspace.getWorkspaceFolder(cwd);
	if (
		!folder ||
		(cwd.scheme !== 'file' && cwd.scheme !== 'vscode-remote') ||
		cwd.scheme !== folder.uri.scheme ||
		cwd.authority !== folder.uri.authority ||
		cwd.query ||
		cwd.fragment
	) {
		await vscode.window.showWarningMessage(
			'Open the terminal folder in this VS Code workspace first. Terminals connected to a different host are not supported.',
		);
		return;
	}

	try {
		const stat = await vscode.workspace.fs.stat(cwd);
		if (stat.type !== vscode.FileType.Directory) {
			await vscode.window.showWarningMessage('The terminal folder is not a directory.');
			return;
		}
		const files = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, '*.tf'), null, 1);
		if (files.length === 0) {
			await vscode.window.showWarningMessage('No Terraform configurations found in the terminal folder.');
			return;
		}
		if (!vscode.workspace.isTrusted) {
			await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
			return;
		}
		await open(cwd);
	} catch {
		await vscode.window.showErrorMessage(
			'Could not open Terraform UI from the terminal folder. Check that the folder is accessible.',
		);
	}
}

// The calling process supplies a literal cwd, never a UI-side/foreign URI.
export async function openHostFolder(encoded: string, open: (uri: vscode.Uri) => Promise<void>): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
		return;
	}
	const cwd = Buffer.from(encoded, 'base64url').toString('utf8');
	if (
		Buffer.from(cwd, 'utf8').toString('base64url') !== encoded ||
		cwd.includes('\0') ||
		!path.posix.isAbsolute(cwd) ||
		path.posix.normalize(cwd) !== cwd
	) {
		await vscode.window.showWarningMessage(
			'Terraform UI did not open: the launcher did not provide a supported extension-host folder. Enable the shortcut again.',
		);
		return;
	}
	for (const root of vscode.workspace.workspaceFolders || []) {
		// Remote workspace extension hosts see their own filesystem as file://.
		// Do not reinterpret vscode-local or foreign authorities as host paths.
		if (root.uri.scheme !== 'file' || root.uri.authority || root.uri.query || root.uri.fragment) continue;
		const relative = path.posix.relative(root.uri.path, cwd);
		if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
		await openCurrentFolder(root.uri.with({ path: cwd, query: '', fragment: '' }), open);
		return;
	}
	await vscode.window.showWarningMessage(
		'Open the terminal folder in this extension host’s workspace first. Foreign hosts are not supported.',
	);
}

export function registerTerminalShortcut(
	extensionId: string,
	open: (uri: vscode.Uri) => Promise<void>,
	launcher?: vscode.UriHandler,
	extensionUri?: vscode.Uri,
): vscode.Disposable {
	const tokens = new Map<string, { terminal: vscode.Terminal; query: string; processCwd: boolean }>();
	let disposed = false;
	const command = vscode.commands.registerCommand('terraformUI.enableTerminalShortcut', async () => {
		if (!vscode.workspace.isTrusted) {
			await vscode.window.showWarningMessage('Trust this workspace before enabling tfui.');
			return;
		}
		const terminal = vscode.window.activeTerminal;
		const integration = terminal?.shellIntegration;
		if (!terminal || !integration?.cwd) {
			await vscode.window.showWarningMessage(
				'Open an integrated terminal with shell integration and a reported current folder, wait for a clean prompt, and retry.',
			);
			return;
		}
		const scheme = vscode.env.uriScheme;
		if ((scheme !== 'vscode' && scheme !== 'vscode-insiders') || !/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(extensionId)) {
			await vscode.window.showWarningMessage('The tfui shortcut supports VS Code and VS Code Insiders only.');
			return;
		}
		const shell = await vscode.window.showQuickPick(['bash/zsh', 'PowerShell (pwsh)'], {
			placeHolder: 'Choose the shell actually running in this terminal (no automatic detection)',
		});
		if (shell !== 'bash/zsh' && shell !== 'PowerShell (pwsh)') return;
		const cli = scheme === 'vscode-insiders' ? 'code-insiders' : 'code';
		const consent = await vscode.window.showWarningMessage(
			`Define or replace tfui in this terminal session only? Use a clean, idle shell prompt with no pending input: shell integration may interrupt a running command. Requires ${cli} on this terminal's PATH. Only bash/zsh and PowerShell (pwsh) are supported. No files, PATH, or shell startup settings will be changed. Type tfui after changing folders to open Terraform UI. VS Code routes the shortcut back to this window. Reloading this extension invalidates the shortcut.`,
			{ modal: true },
			'Enable tfui',
		);
		if (consent !== 'Enable tfui') return;
		if (
			!vscode.workspace.isTrusted ||
			terminal.shellIntegration !== integration ||
			!integration.cwd ||
			!vscode.window.terminals.includes(terminal)
		) {
			await vscode.window.showWarningMessage('Terminal or workspace trust changed. Retry from a clean prompt.');
			return;
		}
		const processCwd = !!vscode.env.remoteName && shell === 'bash/zsh' && process.platform !== 'win32';
		if (
			processCwd &&
			(!extensionUri ||
				extensionUri.scheme !== 'file' ||
				extensionUri.authority ||
				extensionUri.query ||
				extensionUri.fragment)
		) {
			await vscode.window.showWarningMessage(
				'The remote session shortcut requires host-local extension files. Use a supported workspace extension host.',
			);
			return;
		}
		const token = randomBytes(32).toString('hex');
		try {
			const target = vscode.Uri.from({
				scheme,
				authority: extensionId,
				path: '/terminal',
				query: `token=${token}`,
			});
			const external = await resolveTerminalUri(target, vscode.env.asExternalUri);
			if (
				disposed ||
				!vscode.workspace.isTrusted ||
				terminal.shellIntegration !== integration ||
				!integration.cwd ||
				!vscode.window.terminals.includes(terminal)
			) {
				await vscode.window.showWarningMessage(
					'Terminal or workspace trust changed. Retry from a clean prompt.',
				);
				return;
			}
			const uri = external.toString();
			const quoted =
				shell === 'bash/zsh' ? "'" + uri.replace(/'/g, "'\\''") + "'" : "'" + uri.replace(/'/g, "''") + "'";
			const openArgument = vscode.env.remoteName ? '--openExternal' : '--open-url';
			let invocation = `${shell === 'PowerShell (pwsh)' ? '& ' : ''}'${cli}' ${openArgument} ${quoted}`;
			if (processCwd && extensionUri) {
				// VS Code 1.96 reports ambiguous vscode-local shell cwd URIs remotely.
				// Run the same host-side cwd encoder as PATH launchers, without changing PATH
				// or exporting settings into the user's shell. Quote only fixed data.
				const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
				const script = vscode.Uri.joinPath(extensionUri, 'out', 'terminalLauncherProcess.js').fsPath;
				invocation = `TFUI_URL=${quoted} TFUI_CLI=${quote(cli)} TFUI_OPEN_ARG=${quote(openArgument)} ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)}`;
			}
			const definition =
				shell === 'bash/zsh' ? `function tfui() { ${invocation}; }` : `function tfui { ${invocation} }`;
			integration.executeCommand(definition);
			for (const [previous, owner] of tokens) {
				if (owner.terminal === terminal) tokens.delete(previous);
			}
			tokens.set(token, { terminal, query: external.query, processCwd });
		} catch {
			await vscode.window.showErrorMessage(
				'Could not define tfui. Retry in a supported terminal at a clean prompt.',
			);
		}
	});
	const handler = vscode.window.registerUriHandler({
		async handleUri(uri) {
			if (uri.path === '/launch') {
				await launcher?.handleUri(uri);
				return;
			}
			if (uri.scheme !== vscode.env.uriScheme || uri.authority !== extensionId || uri.path !== '/terminal')
				return;
			const parameters = parseTerminalQuery(uri.query, true) || parseTerminalQuery(uri.query);
			const token = parameters?.get('token');
			const owner = token ? tokens.get(token) : undefined;
			const terminal =
				!uri.fragment && owner && matchesTerminalQuery(uri.query, owner.query, owner.processCwd)
					? owner.terminal
					: undefined;
			if (!terminal || !vscode.window.terminals.includes(terminal)) {
				await vscode.window.showWarningMessage(
					'Terraform UI did not open: this terminal shortcut is invalid or belongs to another window or an earlier extension session. Focus the window where you enabled it. After a reload, run "Terraform UI: Enable tfui in This Terminal" again at a clean prompt in the terminal you want to use.',
				);
				return;
			}
			if (owner?.processCwd) {
				await openHostFolder(parameters?.get('cwd') || '', open);
			} else {
				await openTerminalFolder(terminal, open);
			}
		},
	});
	const closed = vscode.window.onDidCloseTerminal((terminal) => {
		for (const [token, owner] of tokens) {
			if (owner.terminal === terminal) tokens.delete(token);
		}
	});
	return new vscode.Disposable(() => {
		disposed = true;
		tokens.clear();
		command.dispose();
		handler.dispose();
		closed.dispose();
	});
}
