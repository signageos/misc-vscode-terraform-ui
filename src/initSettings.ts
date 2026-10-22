import * as vscode from 'vscode';
import { parseInitArguments, safeInitSuggestion } from './initArguments';
import { HostSecrets } from './hostSecrets';

export class InitSettings {
	private readonly hostSecrets: HostSecrets;
	constructor(
		secrets: vscode.SecretStorage,
		private readonly state: vscode.Memento,
		storageUri: vscode.Uri,
	) {
		this.hostSecrets = new HostSecrets(
			secrets,
			storageUri,
			storageUri.scheme === 'vscode-userdata' &&
				vscode.env.uiKind === vscode.UIKind.Desktop &&
				!vscode.env.remoteName,
		);
	}

	async load(root: string): Promise<string> {
		return (await this.hostSecrets.load('initArguments.v2', root)) || '[]';
	}

	suggestions(): string[] {
		const stored: unknown = this.state.get('terraformUI.initSuggestions');
		if (!Array.isArray(stored)) return [];
		return stored.filter((item): item is string => {
			if (typeof item !== 'string') return false;
			try {
				return safeInitSuggestion(item) === item;
			} catch {
				return false;
			}
		});
	}

	async save(root: string, input: string): Promise<void> {
		parseInitArguments(input);
		await this.hostSecrets.save('initArguments.v2', root, input || '[]');
		const suggestion = safeInitSuggestion(input);
		if (suggestion) {
			await this.state.update(
				'terraformUI.initSuggestions',
				[suggestion, ...this.suggestions().filter((item) => item !== suggestion)].slice(0, 10),
			);
		}
	}
}
