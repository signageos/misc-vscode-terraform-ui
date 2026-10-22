import * as vscode from 'vscode';
import { formatInitArguments, parseInitArguments, restoreInitArguments, safeInitSuggestion } from './initArguments';
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
		const saved = await this.hostSecrets.load('initArguments.v2', root);
		return saved ? formatInitArguments(restoreInitArguments(saved)) : '';
	}

	suggestions(): string[] {
		const stored: unknown = this.state.get('terraformUI.initSuggestions');
		if (!Array.isArray(stored)) return [];
		return stored.flatMap((item): string[] => {
			if (typeof item !== 'string') return [];
			try {
				const suggestion = safeInitSuggestion(formatInitArguments(restoreInitArguments(item)));
				return suggestion ? [suggestion] : [];
			} catch {
				return [];
			}
		});
	}

	async save(root: string, input: string): Promise<void> {
		const args = parseInitArguments(input);
		await this.hostSecrets.save('initArguments.v2', root, JSON.stringify(args));
		const suggestion = safeInitSuggestion(input);
		if (suggestion) {
			await this.state.update(
				'terraformUI.initSuggestions',
				[suggestion, ...this.suggestions().filter((item) => item !== suggestion)]
					.slice(0, 10)
					.map((item) => JSON.stringify(parseInitArguments(item))),
			);
		}
	}
}
