import * as vscode from 'vscode';
import * as path from 'path';
import { TerraformUIPanel } from './webviewPanel';

export function activate(context: vscode.ExtensionContext): void {
	console.log('[Terraform UI] Extension activating...');
	vscode.window.showInformationMessage('Terraform UI extension activated!');

	const disposable = vscode.commands.registerCommand('terraformUI.open', async (uri?: vscode.Uri) => {
		const roots = await findTerraformRoots(uri);

		if (roots.length === 0) {
			vscode.window.showWarningMessage('No Terraform configurations found in the workspace.');
			return;
		}

		TerraformUIPanel.create(context.extensionUri, roots);
	});

	context.subscriptions.push(disposable);
}

export function deactivate(): void {
	// Nothing to clean up
}

/**
 * Find all directories containing .tf files in the workspace.
 * If a URI is provided (from context menu), use its directory as the starting point.
 */
async function findTerraformRoots(contextUri?: vscode.Uri): Promise<string[]> {
	const roots = new Set<string>();

	// If invoked from context menu on a specific folder/file
	if (contextUri) {
		const stat = await vscode.workspace.fs.stat(contextUri);
		const dir = stat.type === vscode.FileType.Directory
			? contextUri.fsPath
			: path.dirname(contextUri.fsPath);

		// Check if this dir has .tf files
		const tfFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(dir, '*.tf'),
			null,
			1,
		);
		if (tfFiles.length > 0) {
			roots.add(dir);
		}
	}

	// Scan workspace folders for all terraform roots
	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const tfFiles = await vscode.workspace.findFiles(
				new vscode.RelativePattern(folder, '**/*.tf'),
				'**/.terraform/**',
				500,
			);

			for (const file of tfFiles) {
				roots.add(path.dirname(file.fsPath));
			}
		}
	}

	return Array.from(roots).sort();
}
