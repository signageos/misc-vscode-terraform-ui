import { HostSecrets } from './hostSecrets';
import { DEFAULT_EXECUTION, ExecutionSettingsValue, parseEnvironment, validateExecutable } from './execution';

export class ExecutionSettings {
	constructor(private readonly hostSecrets: HostSecrets) {}

	async load(root: string): Promise<ExecutionSettingsValue> {
		const stored = await this.hostSecrets.load('execution.v1', root);
		if (!stored) return { ...DEFAULT_EXECUTION, environment: {} };
		const value: unknown = JSON.parse(stored);
		if (!value || typeof value !== 'object' || !('executable' in value) || !('environment' in value))
			throw new Error('Invalid execution settings.');
		return {
			executable: validateExecutable(value.executable),
			environment: parseEnvironment(JSON.stringify(value.environment)),
		};
	}

	async save(root: string, executable: string, environment: string): Promise<void> {
		const settings = { executable: validateExecutable(executable), environment: parseEnvironment(environment) };
		await this.hostSecrets.save('execution.v1', root, JSON.stringify(settings));
	}
}
