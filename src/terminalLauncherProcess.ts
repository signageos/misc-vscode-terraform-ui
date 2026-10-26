import { spawn } from 'node:child_process';
import { parseSerializedTerminalQuery } from './terminalUri';

const base = process.env.TFUI_URL;
const cli = process.env.TFUI_CLI;
const openArgument = process.env.TFUI_OPEN_ARG;
if (
	!base ||
	!/^vscode(?:-insiders)?:\/\/[a-z0-9_-]+\.[a-z0-9_-]+\/(?:launch|terminal)\?[^#]+$/i.test(base) ||
	!parseSerializedTerminalQuery(base.slice(base.indexOf('?') + 1)) ||
	(cli !== 'code' && cli !== 'code-insiders') ||
	(openArgument !== '--open-url' && openArgument !== '--openExternal')
) {
	process.stderr.write('Terraform UI launcher is unavailable. Enable it again and create a new terminal.\n');
	process.exitCode = 1;
} else {
	const encoded = Buffer.from(process.cwd(), 'utf8').toString('base64url');
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(cli, [openArgument, `${base}&cwd=${encoded}`], { shell: false, stdio: 'inherit', env });
	child.on('error', () => {
		process.stderr.write('Could not launch VS Code. Ensure its code/code-insiders CLI is on this terminal PATH.\n');
		process.exitCode = 1;
	});
	child.on('exit', (code) => {
		process.exitCode = code === null ? 1 : code;
	});
}
