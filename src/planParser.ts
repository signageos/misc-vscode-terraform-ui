import { diffArrays } from 'diff';
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
				appendValue(lines, '  - ', '  - ', oldVal);
				lines.push(`  + (known after apply)`);
			} else {
				lines.push(`+ ${key}: (known after apply)`);
			}
		} else if (oldVal === undefined && newVal !== undefined) {
			appendValue(lines, `+ ${key}: `, '+ ', newVal);
		} else if (oldVal !== undefined && newVal === undefined) {
			appendValue(lines, `- ${key}: `, '- ', oldVal);
		} else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
			lines.push(`~ ${key}:`);
			const oldLines = formatValue(oldVal).split('\n');
			const newLines = formatValue(newVal).split('\n');
			// Bound worst-case edits; fall back to whole-value removal/addition.
			const parts = diffArrays(oldLines, newLines, { maxEditLength: 1000, timeout: 100 });
			if (parts) {
				for (const part of parts) {
					const prefix = part.added ? '  + ' : part.removed ? '  - ' : '    ';
					for (const line of part.value) {
						lines.push(prefix + line);
					}
				}
			} else {
				appendValue(lines, '  - ', '  - ', oldVal);
				appendValue(lines, '  + ', '  + ', newVal);
			}
		} else {
			appendValue(lines, `  ${key}: `, '    ', oldVal);
		}
	}

	return lines.join('\n');
}

function appendValue(lines: string[], firstPrefix: string, continuationPrefix: string, value: unknown): void {
	for (const [index, line] of formatValue(value).split('\n').entries()) {
		lines.push((index === 0 ? firstPrefix : continuationPrefix) + line);
	}
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		if (!value.includes('\n')) {
			return JSON.stringify(value);
		}
		// A display-only heredoc, not executable HCL. Keep templates literal and
		// distinguish missing final newline and carriage returns explicitly.
		// Escape literal backslashes first so CR and literal backslash-r cannot
		// collapse to identical display lines before diffing.
		const content = value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r');
		let marker = 'EOT';
		let suffix = 0;
		const contentLines = content.split('\n');
		while (contentLines.some((line) => line.trim() === marker)) {
			marker = `EOT_${++suffix}`;
		}
		const ending = value.endsWith('\n') ? '' : '\n\\ No newline at end of value\n';
		return `<<-${marker}\n${content}${ending}${marker}`;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value, null, 2);
	}
	return String(value);
}
