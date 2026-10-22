import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TerraformPlan } from './types';
import { parsePlanJson } from './planParser';
import { parseInitArguments } from './initArguments';
import { ExecutionSettingsValue, executionSnapshot, ExecutionSnapshot } from './execution';

export class InitCanceledError extends Error {}
export class TerraformExecutionError extends Error {}

export type OutputCallback = (data: string) => void;

export class TerraformRunner {
	private currentProcess: cp.ChildProcess | null = null;
	private planning = false;
	private planCanceled = false;

	private ensureIdle(): void {
		if (this.currentProcess || this.planning) throw new Error('A Terraform operation is already running.');
	}

	async init(cwd: string, input: string, settings?: ExecutionSettingsValue): Promise<void> {
		this.ensureIdle();
		const args = parseInitArguments(input);
		const execution = executionSnapshot(settings);
		const env = { ...execution.env, TF_INPUT: 'false' };
		return new Promise<void>((resolve, reject) => {
			let proc: cp.ChildProcess;
			try {
				proc = cp.spawn(execution.executable, ['init', ...args, '-input=false', '-no-color'], {
					cwd,
					env,
					shell: false,
					stdio: 'ignore',
				});
			} catch {
				reject(
					new TerraformExecutionError(
						'Could not start Terraform Init. Check execution settings and host access.',
					),
				);
				return;
			}
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
	async plan(
		cwd: string,
		onOutput: OutputCallback,
		parallelism?: number,
		settings?: ExecutionSettingsValue,
	): Promise<TerraformPlan> {
		this.ensureIdle();
		const execution = executionSnapshot(settings);
		const planFile = path.join(os.tmpdir(), `tfplan-${Date.now()}`);
		const args = ['plan', `-out=${planFile}`, '-no-color', '-input=false'];
		if (parallelism !== undefined) args.push(`-parallelism=${parallelism}`);
		this.planning = true;
		this.planCanceled = false;
		this.diagnostics('Plan', execution, onOutput);
		try {
			const rawOutput = await this.runPlanProcess(cwd, args, execution, onOutput, false);
			if (this.planCanceled) throw new TerraformExecutionError('Terraform Plan canceled.');
			const jsonOutput = await this.runPlanProcess(cwd, ['show', '-json', planFile], execution, onOutput, true);
			try {
				const plan = parsePlanJson(jsonOutput);
				plan.rawOutput = rawOutput;
				return plan;
			} catch {
				throw new TerraformExecutionError(
					'Terraform Show returned an invalid plan. Raw diagnostics are withheld.',
				);
			}
		} finally {
			this.planning = false;
			try {
				fs.unlinkSync(planFile);
			} catch {
				/* The process may not have created a plan file. */
			}
		}
	}

	private diagnostics(operation: string, execution: ExecutionSnapshot, onOutput: OutputCallback): void {
		onOutput(
			`Terraform ${operation}: extension-host execution; executable ${execution.executable === 'terraform' ? 'default' : 'custom'}.\n`,
		);
		if (execution.withholdOutput)
			onOutput('Raw output is withheld because environment overrides are configured.\n');
	}

	private runPlanProcess(
		cwd: string,
		args: string[],
		execution: ExecutionSnapshot,
		onOutput: OutputCallback,
		show: boolean,
	): Promise<string> {
		const operation = show ? 'Show' : 'Plan';
		return new Promise((resolve, reject) => {
			let proc: cp.ChildProcess;
			try {
				proc = cp.spawn(execution.executable, args, { cwd, env: execution.env, shell: false });
			} catch {
				reject(
					new TerraformExecutionError(
						`Could not start Terraform ${operation}. Check execution settings and host access.`,
					),
				);
				return;
			}
			this.currentProcess = proc;
			const chunks: Buffer[] = [];
			proc.stdout?.on('data', (data: Buffer) => {
				if (show || !execution.withholdOutput) chunks.push(data);
				if (!show && !execution.withholdOutput) onOutput(data.toString());
			});
			proc.stderr?.on('data', (data: Buffer) => {
				if (!execution.withholdOutput) {
					if (!show) chunks.push(data);
					onOutput(data.toString());
				}
			});
			proc.once('error', () =>
				reject(
					new TerraformExecutionError(
						`Could not start Terraform ${operation}. Check execution settings and host access.`,
					),
				),
			);
			proc.once('close', (code, signal) => {
				if (this.currentProcess === proc) this.currentProcess = null;
				if (signal) reject(new TerraformExecutionError(`Terraform ${operation} canceled.`));
				else if (code !== 0)
					reject(
						new TerraformExecutionError(
							`Terraform ${operation} failed (exit ${code}). Check execution settings and provider access in a secure terminal.`,
						),
					);
				else resolve(Buffer.concat(chunks).toString('utf8'));
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
		settings?: ExecutionSettingsValue,
	): { process: cp.ChildProcess; writeInput: (input: string) => void } {
		this.ensureIdle();
		const execution = executionSnapshot(settings);
		const args = ['apply', '-no-color'];
		if (parallelism !== undefined) {
			args.push(`-parallelism=${parallelism}`);
		}
		for (const target of targets) {
			args.push(`-target=${target}`);
		}

		this.diagnostics('Apply', execution, onOutput);
		let proc: cp.ChildProcess;
		try {
			proc = cp.spawn(execution.executable, args, { cwd, env: execution.env, shell: false });
		} catch {
			throw new TerraformExecutionError(
				'Could not start Terraform Apply. Check execution settings and host access.',
			);
		}
		this.currentProcess = proc;
		let promptTail = '';
		let prompted = false;
		const output = (data: Buffer): void => {
			if (!execution.withholdOutput) {
				onOutput(data.toString());
				return;
			}
			// Recognize only fixed confirmation text, including across chunk boundaries.
			// No provider output, executable path or environment values cross into the webview.
			promptTail = (promptTail + data.toString()).slice(-256);
			if (
				!prompted &&
				(promptTail.includes('Enter a value:') || promptTail.includes('Do you want to perform these actions'))
			) {
				prompted = true;
				onOutput('Enter a value:');
			}
		};
		proc.stdout?.on('data', output);
		proc.stderr?.on('data', output);
		proc.on('error', () => {
			/* The caller receives the event; never publish its raw error. */
		});

		proc.on('close', () => {
			if (this.currentProcess === proc) this.currentProcess = null;
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
		if (this.planning) this.planCanceled = true;
		if (this.currentProcess) {
			this.currentProcess.kill('SIGTERM');
		}
	}
}
