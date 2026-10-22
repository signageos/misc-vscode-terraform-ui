import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TerraformPlan } from './types';
import { parsePlanJson } from './planParser';
import { parseInitArguments } from './initArguments';

export class InitCanceledError extends Error {}

export type OutputCallback = (data: string) => void;

export class TerraformRunner {
	private currentProcess: cp.ChildProcess | null = null;

	private ensureIdle(): void {
		if (this.currentProcess) throw new Error('A Terraform operation is already running.');
	}

	async init(cwd: string, input: string): Promise<void> {
		this.ensureIdle();
		const args = parseInitArguments(input);
		const env: NodeJS.ProcessEnv = { ...process.env, TF_INPUT: 'false', TF_IN_AUTOMATION: '1' };
		delete env.TF_CLI_ARGS;
		delete env.TF_CLI_ARGS_init;
		delete env.TF_LOG;
		delete env.TF_LOG_PATH;
		delete env.TF_LOG_CORE;
		delete env.TF_LOG_PROVIDER;
		return new Promise<void>((resolve, reject) => {
			const proc = cp.spawn('terraform', ['init', ...args, '-input=false', '-no-color'], {
				cwd,
				env,
				shell: false,
				stdio: 'ignore',
			});
			this.currentProcess = proc;
			proc.once('error', () => {
				reject(new Error('Could not start terraform init. Check Terraform installation and folder access.'));
			});
			proc.once('close', (code, signal) => {
				if (this.currentProcess === proc) this.currentProcess = null;
				if (signal) reject(new InitCanceledError('Terraform Init canceled.'));
				else if (code !== 0)
					reject(
						new Error(
							`Terraform Init failed (exit ${code}). Output is withheld to protect credentials; diagnose in a secure terminal.`,
						),
					);
				else resolve();
			});
		});
	}

	/**
	 * Run `terraform plan` in the given directory, streaming output via callback.
	 * Returns the parsed plan when complete.
	 */
	async plan(cwd: string, onOutput: OutputCallback, parallelism?: number): Promise<TerraformPlan> {
		this.ensureIdle();
		// Use a temp file for the plan binary output
		const planFile = path.join(os.tmpdir(), `tfplan-${Date.now()}`);

		return new Promise<TerraformPlan>((resolve, reject) => {
			let rawOutput = '';

			const args = ['plan', `-out=${planFile}`, '-no-color', '-input=false'];
			if (parallelism !== undefined) {
				args.push(`-parallelism=${parallelism}`);
			}

			onOutput(`$ terraform ${args.join(' ')}\n`);
			onOutput(`Working directory: ${cwd}\n\n`);

			const proc = cp.spawn('terraform', args, {
				cwd,
				env: { ...process.env },
			});
			this.currentProcess = proc;

			proc.stdout?.on('data', (data: Buffer) => {
				const text = data.toString();
				rawOutput += text;
				onOutput(text);
			});

			proc.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				rawOutput += text;
				onOutput(text);
			});

			proc.on('close', async (code) => {
				if (code !== 0) {
					this.currentProcess = null;
					try {
						fs.unlinkSync(planFile);
					} catch {
						/* ignore */
					}
					reject(new Error(`terraform plan exited with code ${code}`));
					return;
				}

				try {
					// Parse the plan file with terraform show -json using spawn to avoid buffer limits
					const jsonChunks: Buffer[] = [];
					const showProc = cp.spawn('terraform', ['show', '-json', planFile], {
						cwd,
					});

					this.currentProcess = showProc;

					showProc.stdout?.on('data', (data: Buffer) => {
						jsonChunks.push(data);
					});

					showProc.stderr?.on('data', (data: Buffer) => {
						onOutput(data.toString());
					});

					showProc.on('close', (showCode) => {
						this.currentProcess = null;
						try {
							fs.unlinkSync(planFile);
						} catch {
							/* ignore */
						}

						if (showCode !== 0) {
							reject(new Error(`terraform show -json exited with code ${showCode}`));
							return;
						}

						try {
							const jsonOutput = Buffer.concat(jsonChunks).toString('utf-8');
							const plan = parsePlanJson(jsonOutput);
							plan.rawOutput = rawOutput;
							resolve(plan);
						} catch (parseErr) {
							reject(parseErr);
						}
					});

					showProc.on('error', (err) => {
						try {
							fs.unlinkSync(planFile);
						} catch {
							/* ignore */
						}
						reject(err);
					});
				} catch (err) {
					this.currentProcess = null;
					try {
						fs.unlinkSync(planFile);
					} catch {
						/* ignore */
					}
					reject(err);
				}
			});

			proc.on('error', (err) => {
				reject(err);
			});
		});
	}

	/**
	 * Run `terraform apply` with -target flags.
	 * Returns a handle to write stdin (for "yes" confirmation) and streams output.
	 */
	apply(
		cwd: string,
		targets: string[],
		onOutput: OutputCallback,
		parallelism?: number,
	): { process: cp.ChildProcess; writeInput: (input: string) => void } {
		this.ensureIdle();
		const args = ['apply', '-no-color'];
		if (parallelism !== undefined) {
			args.push(`-parallelism=${parallelism}`);
		}
		for (const target of targets) {
			args.push(`-target=${target}`);
		}

		const cmdStr = `$ terraform ${args.join(' ')}`;
		onOutput(`${cmdStr}\n`);
		onOutput(`Working directory: ${cwd}\n\n`);

		const proc = cp.spawn('terraform', args, {
			cwd,
			env: { ...process.env },
		});
		this.currentProcess = proc;

		proc.stdout?.on('data', (data: Buffer) => {
			onOutput(data.toString());
		});

		proc.stderr?.on('data', (data: Buffer) => {
			onOutput(data.toString());
		});

		proc.on('close', () => {
			this.currentProcess = null;
		});

		return {
			process: proc,
			writeInput: (input: string) => {
				proc.stdin?.write(input);
			},
		};
	}

	/** Kill the current running process */
	cancel(): void {
		if (this.currentProcess) {
			this.currentProcess.kill('SIGTERM');
		}
	}
}
