import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { openCurrentFolder } from './terminal';
import { hostStoragePath } from './hostStorage';

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
			token = token || randomBytes(32).toString('hex');
			const options = { applyAtProcessCreation: true, applyAtShellIntegration: false };
			collection.description = 'Terraform UI typed launchers (new terminals only)';
			collection.replace('TFUI_RUNTIME', process.execPath, options);
			collection.replace(
				'TFUI_SCRIPT',
				vscode.Uri.joinPath(context.extensionUri, 'out', 'terminalLauncherProcess.js').fsPath,
				options,
			);
			collection.replace('TFUI_URL', `${scheme}://${extensionId}/launch?token=${token}`, options);
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
			if (
				disposed ||
				!token ||
				!vscode.workspace.isTrusted ||
				uri.scheme !== scheme ||
				uri.authority !== extensionId ||
				uri.path !== '/launch' ||
				uri.query.length > 65536 ||
				uri.fragment
			)
				return;
			const match = /^token=([a-f0-9]{64})&cwd=([A-Za-z0-9_-]+)$/.exec(uri.query);
			if (!match || match[1] !== token) return;
			const encoded = match[2];
			const cwd = Buffer.from(encoded, 'base64url').toString('utf8');
			if (
				Buffer.from(cwd, 'utf8').toString('base64url') !== encoded ||
				cwd.includes('\0') ||
				!path.posix.isAbsolute(cwd) ||
				path.posix.normalize(cwd) !== cwd
			)
				return;
			const roots = vscode.workspace.workspaceFolders || [];
			for (const root of roots) {
				// A workspace extension host sees its own filesystem as file://, even remotely:
				// VS Code transforms vscode-remote URIs on the UI/agent boundary.
				// Never reinterpret this process's cwd as a different host's filesystem.
				if (root.uri.scheme !== 'file' || root.uri.authority || root.uri.query || root.uri.fragment) continue;
				const relative = path.posix.relative(root.uri.path, cwd);
				if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
				const target = root.uri.with({ path: cwd, query: '', fragment: '' });
				await openCurrentFolder(target, open);
				return;
			}
			await vscode.window.showWarningMessage(
				'Open the terminal folder in this extension host’s workspace first. Foreign hosts are not supported.',
			);
		},
		dispose() {
			disposed = true;
			token = undefined;
			collection.clear();
			command.dispose();
		},
	};
}
