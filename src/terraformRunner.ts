import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TerraformPlan } from './types';
import { parsePlanJson } from './planParser';

export type OutputCallback = (data: string) => void;

export class TerraformRunner {
	private currentProcess: cp.ChildProcess | null = null;

	/**
	 * Run `terraform plan` in the given directory, streaming output via callback.
	 * Returns the parsed plan when complete.
	 */
	async plan(cwd: string, onOutput: OutputCallback, parallelism?: number): Promise<TerraformPlan> {
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
				this.currentProcess = null;

				if (code !== 0) {
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

					showProc.stdout?.on('data', (data: Buffer) => {
						jsonChunks.push(data);
					});

					showProc.stderr?.on('data', (data: Buffer) => {
						onOutput(data.toString());
					});

					showProc.on('close', (showCode) => {
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
					try {
						fs.unlinkSync(planFile);
					} catch {
						/* ignore */
					}
					reject(err);
				}
			});

			proc.on('error', (err) => {
				this.currentProcess = null;
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
			this.currentProcess = null;
		}
	}
}
