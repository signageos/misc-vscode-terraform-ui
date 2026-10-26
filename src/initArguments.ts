import { quote, split } from 'shlex';

export function parseInitArguments(input: string): string[] {
	if (/[\r\n\u0000]/.test(input)) throw new Error('Enter Init arguments on one line without NUL.');
	try {
		return validateInitArguments(split(input));
	} catch {
		throw new Error('Invalid Init arguments. Check quotes, escapes, and reserved flags.');
	}
}

export function restoreInitArguments(input: string): string[] {
	const value: unknown = JSON.parse(input);
	return validateInitArguments(value);
}

function validateInitArguments(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error('Saved Init arguments must be an array.');
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

export function formatInitArguments(args: string[]): string {
	// Quote user-controlled fragments with the library; keep legacy newlines single-line.
	return args
		.map((arg) =>
			arg
				.split(/([\r\n])/)
				.map((part) => (part === '\n' ? "$'\\n'" : part === '\r' ? "$'\\r'" : quote(part)))
				.join(''),
		)
		.join(' ');
}

export function safeInitSuggestion(input: string): string | undefined {
	const args = parseInitArguments(input);
	return args.length > 0 && args.every((arg) => SUGGESTIBLE_FLAGS.has(arg)) ? formatInitArguments(args) : undefined;
}
