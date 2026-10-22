import * as path from 'path';
import { createHash } from 'crypto';
import { TerraformPlan } from './types';

export interface ExecutionSettingsValue {
	executable: string;
	environment: Record<string, string | null>;
}

export interface ExecutionSnapshot {
	executable: string;
	env: NodeJS.ProcessEnv;
	protectedValues: string[];
	withholdOutput: boolean;
}

export const DEFAULT_EXECUTION: ExecutionSettingsValue = { executable: 'terraform', environment: {} };

function reserved(name: string): boolean {
	return /^(TF_CLI_ARGS(?:_|$)|TF_LOG(?:_|$)|TF_INPUT$|TF_IN_AUTOMATION$)/i.test(name);
}

/** A literal executable, never a command line. Relative paths must be made absolute by the user. */
export function validateExecutable(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 4096 ||
		/[\u0000-\u001f\u007f]/.test(value) ||
		(!path.isAbsolute(value) && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value))
	)
		throw new Error('Use a literal executable name or absolute path, without arguments.');
	return value;
}

export function parseEnvironment(input: string): Record<string, string | null> {
	if (input.length > 65536) throw new Error('Environment overrides are too large.');
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error('Use a JSON object of strings or null values.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Use a JSON object of strings or null values.');
	const entries = Object.entries(value);
	if (entries.length > 128) throw new Error('Too many environment overrides.');
	const names = new Set<string>();
	for (const [name, item] of entries) {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || reserved(name) || names.has(name.toUpperCase())) {
			throw new Error(
				'Invalid, duplicate-case, or reserved environment variable name. Terraform input, logging and CLI argument overrides are not supported.',
			);
		}
		if (item !== null && (typeof item !== 'string' || item.includes('\0')))
			throw new Error('Environment values must be strings without NUL, or null to remove a variable.');
		names.add(name.toUpperCase());
	}
	return Object.fromEntries(
		entries.filter((entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null),
	);
}

export function executionSnapshot(settings: ExecutionSettingsValue = DEFAULT_EXECUTION): ExecutionSnapshot {
	const executable = validateExecutable(settings.executable);
	const environment = parseEnvironment(JSON.stringify(settings.environment));
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [name, value] of Object.entries(environment)) {
		// Windows environment names are case insensitive. Avoid duplicate inherited keys there.
		if (process.platform === 'win32') {
			for (const inherited of Object.keys(env))
				if (inherited.toUpperCase() === name.toUpperCase()) delete env[inherited];
		}
		if (value === null) delete env[name];
		else Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
	}
	for (const name of Object.keys(env)) if (reserved(name)) delete env[name];
	env.TF_IN_AUTOMATION = '1';
	return {
		executable,
		env,
		protectedValues: Object.values(environment)
			.filter((value): value is string => typeof value === 'string' && value.length > 0)
			.sort((a, b) => b.length - a.length),
		withholdOutput: Object.keys(environment).length > 0,
	};
}

/** Content identity stays host-side. Sorting avoids invalidating a plan for JSON key order alone. */
export function executionIdentity(settings: ExecutionSettingsValue): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				settings.executable,
				Object.entries(settings.environment).sort(([a], [b]) => a.localeCompare(b)),
			]),
		)
		.digest('hex');
}

/** Display-only projection. Never use redacted strings as operational addresses or semantics. */
export function maskPlanForDisplay(plan: TerraformPlan, execution: ExecutionSnapshot): TerraformPlan {
	const mask = (text: string): string => {
		for (const secret of execution.protectedValues) text = text.split(secret).join('[REDACTED]');
		return text;
	};
	const walk = (value: unknown): unknown => {
		if (typeof value === 'string') return mask(value);
		if (typeof value === 'number' && execution.protectedValues.includes(String(value))) return '[REDACTED]';
		if (Array.isArray(value)) return value.map(walk);
		if (value !== null && typeof value === 'object')
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), walk(item)]));
		return value;
	};
	const attributes = (value: Record<string, unknown> | null | undefined): Record<string, unknown> | null =>
		value === null || value === undefined
			? null
			: Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), walk(item)]));
	return {
		rawOutput: plan.rawOutput,
		resourceChanges: plan.resourceChanges.map((change) => ({
			address: mask(change.address),
			moduleAddress: change.moduleAddress === undefined ? undefined : mask(change.moduleAddress),
			name: mask(change.name),
			type: mask(change.type),
			mode: change.mode,
			actions: [...change.actions],
			before: attributes(change.before),
			after: attributes(change.after),
			afterUnknown: attributes(change.afterUnknown),
		})),
	};
}
