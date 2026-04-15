/** Represents a single resource change from a Terraform plan */
export interface ResourceChange {
	/** Full resource address (e.g., "aws_instance.web") */
	address: string;
	/** Module address if inside a module */
	moduleAddress?: string;
	/** Resource type (e.g., "aws_instance") */
	type: string;
	/** Resource name (e.g., "web") */
	name: string;
	/** Actions: "create", "update", "delete", "replace", "read" */
	actions: string[];
	/** Attribute values before the change */
	before: Record<string, unknown> | null;
	/** Attribute values after the change */
	after: Record<string, unknown> | null;
	/** Keys of attributes known only after apply */
	afterUnknown: Record<string, unknown> | null;
}

/** Parsed terraform plan result */
export interface TerraformPlan {
	resourceChanges: ResourceChange[];
	rawOutput: string;
}

/** Message types sent from extension to webview */
export type ExtensionMessage =
	| { type: 'planStarted' }
	| { type: 'planOutput'; data: string }
	| { type: 'planComplete'; plan: TerraformPlan }
	| { type: 'planError'; error: string }
	| { type: 'applyStarted' }
	| { type: 'applyOutput'; data: string }
	| { type: 'applyComplete'; success: boolean }
	| { type: 'applyError'; error: string }
	| { type: 'terraformRoots'; roots: string[]; preselectedRoot?: string }
	| { type: 'waitingForConfirmation' };

/** Message types sent from webview to extension */
export type WebviewMessage =
	| { type: 'runPlan'; root: string }
	| { type: 'applyTargets'; root: string; targets: string[] }
	| { type: 'confirmApply'; input: string }
	| { type: 'cancelApply' }
	| { type: 'requestRoots' };
