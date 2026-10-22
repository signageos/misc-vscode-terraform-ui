import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

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

export function registerTerminalShortcut(
	extensionId: string,
	open: (uri: vscode.Uri) => Promise<void>,
	launcher?: vscode.UriHandler,
): vscode.Disposable {
	const tokens = new Map<string, vscode.Terminal>();
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
			`Define or replace tfui in this terminal session only? Use a clean, idle shell prompt with no pending input: shell integration may interrupt a running command. Requires ${cli} on this terminal's PATH. Only bash/zsh and PowerShell (pwsh) are supported. No files, PATH, or shell startup settings will be changed. Type tfui after changing folders to open Terraform UI. The URI may be delivered to the topmost VS Code window; keep this window on top. Reloading this extension invalidates the shortcut.`,
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
		const token = randomBytes(32).toString('hex');
		const uri = `${scheme}://${extensionId}/terminal?token=${token}`;
		const openArgument = vscode.env.remoteName ? '--openExternal' : '--open-url';
		const invocation = `${shell === 'PowerShell (pwsh)' ? '& ' : ''}'${cli}' ${openArgument} '${uri}'`;
		const definition =
			shell === 'bash/zsh' ? `function tfui() { ${invocation}; }` : `function tfui { ${invocation} }`;
		try {
			integration.executeCommand(definition);
			for (const [previous, owner] of tokens) {
				if (owner === terminal) tokens.delete(previous);
			}
			tokens.set(token, terminal);
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
			const terminal =
				!uri.fragment && /^token=[a-f0-9]{64}$/.test(uri.query)
					? tokens.get(uri.query.slice('token='.length))
					: undefined;
			if (!terminal || !vscode.window.terminals.includes(terminal)) {
				await vscode.window.showWarningMessage(
					'Terraform UI did not open: this terminal shortcut is invalid or belongs to another window or an earlier extension session. Focus the window where you enabled it. After a reload, run "Terraform UI: Enable tfui in This Terminal" again at a clean prompt in the terminal you want to use.',
				);
				return;
			}
			await openTerminalFolder(terminal, open);
		},
	});
	const closed = vscode.window.onDidCloseTerminal((terminal) => {
		for (const [token, owner] of tokens) {
			if (owner === terminal) tokens.delete(token);
		}
	});
	return new vscode.Disposable(() => {
		tokens.clear();
		command.dispose();
		handler.dispose();
		closed.dispose();
	});
}
