import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { parseInitArguments, safeInitSuggestion } from './initArguments';
import { hostStoragePath } from './hostStorage';

export class InitSettings {
	private namespace: string | undefined;
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly state: vscode.Memento,
		private readonly storageUri: vscode.Uri,
	) {}

	private hostNamespace(): string {
		if (this.namespace) return this.namespace;
		try {
			// Remote workspace hosts see file URIs without their remote authority.
			// globalState and SecretStorage may live on the client, so identity must
			// come from this extension's physical host storage, never workspace URIs.
			const directory = hostStoragePath(
				this.storageUri,
				this.storageUri.scheme === 'vscode-userdata' &&
					vscode.env.uiKind === vscode.UIKind.Desktop &&
					!vscode.env.remoteName,
			);
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (!fs.lstatSync(directory).isDirectory()) throw new Error();
			fs.chmodSync(directory, 0o700);
			const file = path.join(directory, 'init-secret-namespace');
			try {
				fs.lstatSync(file);
			} catch (error: unknown) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
				const token = randomBytes(32).toString('hex');
				const temporary = path.join(directory, `init-secret-namespace.${token}.tmp`);
				fs.writeFileSync(temporary, token, { flag: 'wx', mode: 0o600 });
				try {
					// Publish a complete file atomically: concurrent windows either win
					// this link or read the winner, never a partially written token.
					try {
						fs.linkSync(temporary, file);
					} catch (error: unknown) {
						if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
					}
				} finally {
					fs.unlinkSync(temporary);
				}
			}
			if (!fs.lstatSync(file).isFile()) throw new Error();
			fs.chmodSync(file, 0o600);
			const token = fs.readFileSync(file, 'utf8');
			if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
			this.namespace = token;
			return token;
		} catch {
			// Do not expose filesystem paths or raw errors, or fall back to an
			// old key that could belong to a different local/remote host.
			throw new Error('Init private host storage is unavailable.');
		}
	}

	private key(root: string): string {
		return `terraformUI.initArguments.v2.${this.hostNamespace()}.${root}`;
	}

	async load(root: string): Promise<string> {
		return (await this.secrets.get(this.key(root))) || '[]';
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
		await this.secrets.store(this.key(root), input || '[]');
		const suggestion = safeInitSuggestion(input);
		if (suggestion) {
			await this.state.update(
				'terraformUI.initSuggestions',
				[suggestion, ...this.suggestions().filter((item) => item !== suggestion)].slice(0, 10),
			);
		}
	}
}
