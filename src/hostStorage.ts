import type * as vscode from 'vscode';
import * as path from 'node:path';

export function hostStoragePath(uri: vscode.Uri, localDesktop: boolean): string {
	// Native VS Code's FileUserDataProvider changes only the scheme to file:
	// https://github.com/microsoft/vscode/blob/1.96.0/src/vs/platform/userData/common/fileUserDataProvider.ts
	// That mapping is not valid for browser storage or a remote host's UI-side URI.
	const nativeUserData = uri.scheme === 'vscode-userdata' && localDesktop;
	if ((uri.scheme !== 'file' && !nativeUserData) || uri.authority || uri.query || uri.fragment) {
		throw new Error('Unsupported host storage');
	}
	if (!path.isAbsolute(uri.fsPath) || uri.fsPath.includes('\0')) {
		throw new Error('Unsupported host storage');
	}
	return uri.fsPath;
}
