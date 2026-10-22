export function parseInitArguments(input: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(input || '[]');
	} catch {
		throw new Error('Init arguments must be a JSON array of strings.');
	}
	if (!Array.isArray(value)) {
		throw new Error('Init arguments must be a JSON array of strings.');
	}
	const args: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || item.includes('\u0000')) {
			throw new Error('Each Init argument must be a string without NUL.');
		}
		if (
			/^--?(input|no-color|json|chdir|help|version|force-copy)(=|$)/.test(item) ||
			item === '--' ||
			item === '-h'
		) {
			throw new Error(
				'Init arguments cannot override input, output, directory, help, or copy-confirmation controls.',
			);
		}
		args.push(item);
	}
	return args;
}

const SUGGESTIBLE_FLAGS = new Set(['-upgrade', '-reconfigure', '-backend=false', '-get=false', '-lock=false']);

export function safeInitSuggestion(input: string): string | undefined {
	const args = parseInitArguments(input);
	return args.length > 0 && args.every((arg) => SUGGESTIBLE_FLAGS.has(arg)) ? JSON.stringify(args) : undefined;
}
