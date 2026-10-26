import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { hostStoragePath } from './hostStorage';

/** Host identity stays on the execution host even when SecretStorage is client-backed. */
export class HostSecrets {
	private namespace: string | undefined;
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly storageUri: vscode.Uri,
		private readonly allowNativeUserData: boolean,
	) {}

	private hostNamespace(): string {
		if (this.namespace) return this.namespace;
		try {
			// Remote workspace hosts see file URIs without their remote authority.
			// globalState and SecretStorage may live on the client, so identity must
			// come from this extension's physical host storage, never workspace URIs.
			const directory = hostStoragePath(this.storageUri, this.allowNativeUserData);
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (!fs.lstatSync(directory).isDirectory()) throw new Error();
			fs.chmodSync(directory, 0o700);
			// Retain this filename and Init key scope for existing saved arguments.
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
			throw new Error('Private host storage is unavailable.');
		}
	}

	async load(scope: string, root: string): Promise<string | undefined> {
		return this.secrets.get(`terraformUI.${scope}.${this.hostNamespace()}.${root}`);
	}

	async save(scope: string, root: string, value: string): Promise<void> {
		await this.secrets.store(`terraformUI.${scope}.${this.hostNamespace()}.${root}`, value);
	}
}
