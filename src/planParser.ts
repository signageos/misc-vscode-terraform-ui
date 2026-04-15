import { ResourceChange, TerraformPlan } from './types';

interface PlanJson {
	resource_changes?: Array<{
		address: string;
		module_address?: string;
		mode: string;
		type: string;
		name: string;
		change: {
			actions: string[];
			before: Record<string, unknown> | null;
			after: Record<string, unknown> | null;
			after_unknown: Record<string, unknown> | null;
		};
	}>;
}

/**
 * Parse terraform plan JSON output (from `terraform show -json <planfile>`)
 * into structured ResourceChange objects.
 */
export function parsePlanJson(jsonStr: string): TerraformPlan {
	const data: PlanJson = JSON.parse(jsonStr);
	const resourceChanges: ResourceChange[] = [];

	if (data.resource_changes) {
		for (const rc of data.resource_changes) {
			// Skip no-op for managed resources, but always keep data sources
			if (rc.change.actions.length === 1 && rc.change.actions[0] === 'no-op' && rc.mode !== 'data') {
				continue;
			}

			// For data sources with no-op, show them as "read" action
			const actions =
				rc.mode === 'data' && rc.change.actions.length === 1 && rc.change.actions[0] === 'no-op'
					? ['read']
					: rc.change.actions;

			resourceChanges.push({
				address: rc.address,
				moduleAddress: rc.module_address,
				mode: rc.mode,
				type: rc.type,
				name: rc.name,
				actions,
				before: rc.change.before,
				after: rc.change.after,
				afterUnknown: rc.change.after_unknown,
			});
		}
	}

	return {
		resourceChanges,
		rawOutput: '',
	};
}

/** Build a human-readable diff between before and after for a resource */
export function buildResourceDiff(change: ResourceChange): string {
	const lines: string[] = [];
	const actionLabel = change.actions.join(', ');
	lines.push(`# ${change.address}`);
	lines.push(`# Action: ${actionLabel}`);
	lines.push('');

	const before = change.before ?? {};
	const after = change.after ?? {};
	const afterUnknown = change.afterUnknown ?? {};

	const allKeys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)]);
	const sortedKeys = Array.from(allKeys).sort();

	for (const key of sortedKeys) {
		const oldVal = before[key];
		const newVal = after[key];
		const isUnknown = afterUnknown[key];

		if (isUnknown) {
			if (oldVal !== undefined) {
				lines.push(`~ ${key}:`);
				lines.push(`  - ${formatValue(oldVal)}`);
				lines.push(`  + (known after apply)`);
			} else {
				lines.push(`+ ${key}: (known after apply)`);
			}
		} else if (oldVal === undefined && newVal !== undefined) {
			lines.push(`+ ${key}: ${formatValue(newVal)}`);
		} else if (oldVal !== undefined && newVal === undefined) {
			lines.push(`- ${key}: ${formatValue(oldVal)}`);
		} else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
			lines.push(`~ ${key}:`);
			lines.push(`  - ${formatValue(oldVal)}`);
			lines.push(`  + ${formatValue(newVal)}`);
		} else {
			lines.push(`  ${key}: ${formatValue(oldVal)}`);
		}
	}

	return lines.join('\n');
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		return `"${value}"`;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value, null, 2);
	}
	return String(value);
}
