import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { openHostFolder } from './terminal';
import { hostStoragePath } from './hostStorage';
import { matchesTerminalQuery, parseTerminalQuery, resolveTerminalUri } from './terminalUri';

export async function installTerminalLaunchers(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of ['tfui', 'terraform-ui']) {
		const target = path.join(directory, name);
		await writeFile(target, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$TFUI_RUNTIME" "$TFUI_SCRIPT"\n', {
			mode: 0o700,
		});
		await chmod(target, 0o700);
	}
}

export function registerTerminalLauncher(
	context: vscode.ExtensionContext,
	open: (uri: vscode.Uri) => Promise<void>,
): vscode.Disposable & vscode.UriHandler {
	const collection = context.environmentVariableCollection;
	collection.persistent = false;
	collection.clear();
	let token: string | undefined;
	const callbackQueries = new Set<string>();
	let disposed = false;
	const extensionId = context.extension.id;
	const scheme = vscode.env.uriScheme;
	const command = vscode.commands.registerCommand('terraformUI.enableTerminalLauncher', async () => {
		if (!vscode.workspace.isTrusted) {
			await vscode.window.showWarningMessage('Trust this workspace before enabling tfui.');
			return;
		}
		if (
			process.platform === 'win32' ||
			context.extensionUri.scheme !== 'file' ||
			!!context.extensionUri.authority ||
			(scheme !== 'vscode' && scheme !== 'vscode-insiders') ||
			!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(extensionId)
		) {
			await vscode.window.showWarningMessage(
				'The PATH launcher requires a POSIX extension host and desktop VS Code. Use the terminal command or session-function fallback.',
			);
			return;
		}
		let storagePath: string;
		try {
			storagePath = hostStoragePath(
				context.globalStorageUri,
				vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName,
			);
		} catch {
			await vscode.window.showWarningMessage('Terminal launchers require host-local extension storage.');
			return;
		}
		const consent = await vscode.window.showWarningMessage(
			'Enable tfui and terraform-ui for NEW integrated terminals in this window? Writes helpers only in extension storage and prepends their directory to terminal PATH. No global PATH or shell startup files change. Requires the VS Code CLI on terminal PATH. Reloading requires enabling again and a new terminal.',
			{ modal: true },
			'Enable launchers',
		);
		if (consent !== 'Enable launchers' || disposed || !vscode.workspace.isTrusted) return;
		try {
			const directory = path.join(storagePath, 'terminal-bin');
			// A colon cannot be represented inside a POSIX PATH component.
			if (directory.includes(':')) throw new Error('Unsupported storage path');
			await installTerminalLaunchers(directory);
			if (disposed || !vscode.workspace.isTrusted) return;
			const nextToken = token || randomBytes(32).toString('hex');
			const target = vscode.Uri.from({
				scheme,
				authority: extensionId,
				path: '/launch',
				query: `token=${nextToken}`,
			});
			const external = await resolveTerminalUri(target, vscode.env.asExternalUri);
			if (disposed || !vscode.workspace.isTrusted) return;
			token = nextToken;
			callbackQueries.add(external.query);
			const options = { applyAtProcessCreation: true, applyAtShellIntegration: false };
			collection.description = 'Terraform UI typed launchers (new terminals only)';
			collection.replace('TFUI_RUNTIME', process.execPath, options);
			collection.replace(
				'TFUI_SCRIPT',
				vscode.Uri.joinPath(context.extensionUri, 'out', 'terminalLauncherProcess.js').fsPath,
				options,
			);
			collection.replace('TFUI_URL', external.toString(), options);
			collection.replace('TFUI_CLI', scheme === 'vscode-insiders' ? 'code-insiders' : 'code', options);
			collection.replace('TFUI_OPEN_ARG', vscode.env.remoteName ? '--openExternal' : '--open-url', options);
			collection.prepend('PATH', directory + path.delimiter, options);
			await vscode.window.showInformationMessage(
				'Create a NEW integrated terminal, cd to a workspace Terraform folder, then type tfui or terraform-ui.',
			);
		} catch {
			await vscode.window.showErrorMessage('Could not enable Terraform UI launchers in extension storage.');
		}
	});
	return {
		async handleUri(uri: vscode.Uri): Promise<void> {
			if (disposed || uri.scheme !== scheme || uri.authority !== extensionId || uri.path !== '/launch') return;
			if (!vscode.workspace.isTrusted) {
				await vscode.window.showWarningMessage('Trust this workspace before opening Terraform UI.');
				return;
			}
			const parameters = !uri.fragment ? parseTerminalQuery(uri.query, true) : undefined;
			if (
				!token ||
				!parameters ||
				parameters.get('token') !== token ||
				![...callbackQueries].some((query) => matchesTerminalQuery(uri.query, query, true))
			) {
				await vscode.window.showWarningMessage(
					'Terraform UI did not open: this launcher is invalid or belongs to another window or an earlier extension session. Focus the window where you enabled it. After a reload, run "Terraform UI: Enable tfui / terraform-ui in New Terminals" again and create a NEW terminal.',
				);
				return;
			}
			await openHostFolder(parameters.get('cwd') || '', open);
		},
		dispose() {
			disposed = true;
			token = undefined;
			callbackQueries.clear();
			collection.clear();
			command.dispose();
		},
	};
}
