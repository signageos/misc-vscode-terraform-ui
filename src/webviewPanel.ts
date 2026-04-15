import * as vscode from 'vscode';
import { TerraformRunner } from './terraformRunner';
import { buildResourceDiff } from './planParser';
import { TerraformPlan, WebviewMessage, ResourceChange } from './types';

export class TerraformUIPanel {
	public static readonly viewType = 'terraformUI';

	private readonly panel: vscode.WebviewPanel;
	private readonly runner: TerraformRunner;
	private readonly extensionUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];
	private currentPlan: TerraformPlan | null = null;
	private applyHandle: ReturnType<TerraformRunner['apply']> | null = null;

	public static create(extensionUri: vscode.Uri, terraformRoots: string[], preselectedRoot?: string): TerraformUIPanel {
		const panel = vscode.window.createWebviewPanel(
			TerraformUIPanel.viewType,
			'Terraform UI',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		return new TerraformUIPanel(panel, extensionUri, terraformRoots, preselectedRoot);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private terraformRoots: string[],
		private preselectedRoot?: string,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.runner = new TerraformRunner();

		this.panel.webview.html = this.getHtmlContent();

		this.panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => this.handleMessage(message),
			null,
			this.disposables,
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		// Send the terraform roots once webview is ready
		setTimeout(() => {
			this.postMessage({ type: 'terraformRoots', roots: this.terraformRoots, preselectedRoot: this.preselectedRoot });
		}, 300);
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'requestRoots':
				this.postMessage({ type: 'terraformRoots', roots: this.terraformRoots, preselectedRoot: this.preselectedRoot });
				break;

			case 'runPlan':
				await this.runPlan(message.root);
				break;

			case 'applyTargets':
				this.runApply(message.root, message.targets);
				break;

			case 'confirmApply':
				if (this.applyHandle) {
					this.applyHandle.writeInput(message.input + '\n');
				}
				break;

			case 'cancelApply':
				this.runner.cancel();
				this.applyHandle = null;
				break;
		}
	}

	private async runPlan(root: string): Promise<void> {
		this.postMessage({ type: 'planStarted' });

		try {
			const plan = await this.runner.plan(root, (data) => {
				this.postMessage({ type: 'planOutput', data });
			});

			this.currentPlan = plan;

			// Enrich plan with diff text for each resource
			const enrichedChanges = plan.resourceChanges.map((rc) => ({
				...rc,
				diffText: buildResourceDiff(rc),
			}));

			this.postMessage({
				type: 'planComplete',
				plan: { ...plan, resourceChanges: enrichedChanges },
			});
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.postMessage({ type: 'planError', error: errorMsg });
		}
	}

	private runApply(root: string, targets: string[]): void {
		this.postMessage({ type: 'applyStarted' });

		this.applyHandle = this.runner.apply(root, targets, (data) => {
			this.postMessage({ type: 'applyOutput', data });

			// Detect when terraform asks for confirmation
			if (data.includes('Enter a value:') || data.includes('Do you want to perform these actions')) {
				this.postMessage({ type: 'waitingForConfirmation' });
			}
		});

		this.applyHandle.process.on('close', (code) => {
			this.applyHandle = null;
			this.postMessage({ type: 'applyComplete', success: code === 0 });
		});

		this.applyHandle.process.on('error', (err) => {
			this.applyHandle = null;
			this.postMessage({ type: 'applyError', error: err.message });
		});
	}

	private postMessage(message: unknown): void {
		this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		this.runner.cancel();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}

	private getHtmlContent(): string {
		const nonce = getNonce();

		return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Terraform UI</title>
	<style nonce="${nonce}">
		:root {
			--bg-primary: var(--vscode-editor-background);
			--bg-secondary: var(--vscode-sideBar-background);
			--bg-tertiary: var(--vscode-panel-background, var(--vscode-terminal-background, #1e1e1e));
			--border-color: var(--vscode-panel-border, var(--vscode-widget-border, #444));
			--text-primary: var(--vscode-editor-foreground);
			--text-secondary: var(--vscode-descriptionForeground);
			--accent: var(--vscode-button-background);
			--accent-hover: var(--vscode-button-hoverBackground);
			--accent-fg: var(--vscode-button-foreground);
			--danger: var(--vscode-errorForeground, #f44);
			--success: var(--vscode-testing-iconPassed, #4a4);
			--warning: var(--vscode-editorWarning-foreground, #fa4);
			--diff-add-bg: rgba(0, 180, 0, 0.15);
			--diff-remove-bg: rgba(220, 0, 0, 0.15);
			--diff-change-bg: rgba(220, 180, 0, 0.12);
			--highlight-bg: var(--vscode-list-activeSelectionBackground, #094771);
			--highlight-fg: var(--vscode-list-activeSelectionForeground, #fff);
		}
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
			font-size: var(--vscode-font-size, 13px);
			color: var(--text-primary);
			background: var(--bg-primary);
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		/* Top bar */
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			background: var(--bg-secondary);
			border-bottom: 1px solid var(--border-color);
			flex-shrink: 0;
		}
		.toolbar button {
			padding: 4px 10px;
			border: 1px solid var(--border-color);
			background: var(--bg-primary);
			color: var(--text-primary);
			border-radius: 3px;
			font-size: 12px;
			cursor: pointer;
		}
		.toolbar button {
			background: var(--accent);
			color: var(--accent-fg);
			border: none;
			font-weight: 600;
		}
		.toolbar button:hover { background: var(--accent-hover); }
		.toolbar button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.toolbar .spacer { flex: 1; }
		.toolbar .status {
			font-size: 11px;
			color: var(--text-secondary);
		}

		/* Main split layout */
		.main {
			display: flex;
			flex: 1;
			overflow: hidden;
		}

		/* Left panel: resource list */
		.resource-list {
			width: 340px;
			min-width: 220px;
			border-right: 1px solid var(--border-color);
			display: flex;
			flex-direction: column;
			background: var(--bg-secondary);
			overflow: hidden;
		}
		.resource-list-header {
			padding: 8px 12px;
			font-weight: 600;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--text-secondary);
			border-bottom: 1px solid var(--border-color);
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.resource-list-header .count {
			background: var(--accent);
			color: var(--accent-fg);
			padding: 1px 6px;
			border-radius: 10px;
			font-size: 10px;
			font-weight: 700;
		}
		.resource-items {
			flex: 1;
			overflow-y: auto;
			padding: 4px 0;
		}
		.resource-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 12px;
			cursor: pointer;
			border-left: 3px solid transparent;
			transition: background 0.1s;
		}
		.resource-item:hover { background: rgba(255,255,255,0.04); }
		.resource-item.selected {
			background: var(--highlight-bg);
			color: var(--highlight-fg);
			border-left-color: var(--accent);
		}
		.resource-item input[type="checkbox"] {
			cursor: pointer;
			flex-shrink: 0;
		}
		.resource-item .resource-info {
			flex: 1;
			min-width: 0;
		}
		.resource-item .resource-address {
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.resource-item .resource-action {
			font-size: 10px;
			font-weight: 600;
			padding: 1px 5px;
			border-radius: 3px;
			text-transform: uppercase;
			flex-shrink: 0;
		}
		.action-create { background: var(--diff-add-bg); color: var(--success); }
		.action-update { background: var(--diff-change-bg); color: var(--warning); }
		.action-delete { background: var(--diff-remove-bg); color: var(--danger); }
		.action-replace { background: var(--diff-remove-bg); color: var(--danger); }
		.action-read { background: rgba(100,100,255,0.15); color: #88f; }
		.resource-mode-tag {
			display: inline-block;
			padding: 0 4px;
			border-radius: 3px;
			font-size: 9px;
			font-weight: 700;
			text-transform: uppercase;
			background: rgba(100,100,255,0.2);
			color: #88f;
			vertical-align: middle;
			margin-right: 2px;
		}

		/* Right panel: diff viewer */
		.diff-panel {
			flex: 1;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.diff-header {
			padding: 8px 16px;
			font-weight: 600;
			font-size: 12px;
			border-bottom: 1px solid var(--border-color);
			background: var(--bg-secondary);
			font-family: var(--vscode-editor-font-family, monospace);
		}
		.diff-content {
			flex: 1;
			overflow: auto;
			padding: 12px 16px;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			line-height: 1.6;
			white-space: pre;
			tab-size: 2;
		}
		.diff-content .line-add { background: var(--diff-add-bg); color: var(--success); }
		.diff-content .line-remove { background: var(--diff-remove-bg); color: var(--danger); }
		.diff-content .line-change { background: var(--diff-change-bg); color: var(--warning); }
		.diff-content .line-header { color: var(--text-secondary); font-weight: 600; }
		.diff-content .line-unchanged { color: var(--text-secondary); opacity: 0.7; }

		.empty-state {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			color: var(--text-secondary);
			font-size: 14px;
			text-align: center;
			padding: 40px;
			line-height: 1.6;
		}

		/* Bottom: terminal output + apply bar */
		.bottom-section {
			border-top: 1px solid var(--border-color);
			display: flex;
			flex-direction: column;
			height: 220px;
			min-height: 100px;
			flex-shrink: 0;
		}
		.terminal-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 4px 12px;
			background: var(--bg-secondary);
			border-bottom: 1px solid var(--border-color);
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			color: var(--text-secondary);
			letter-spacing: 0.5px;
		}
		.terminal-header .clear-btn {
			cursor: pointer;
			opacity: 0.6;
			margin-left: auto;
		}
		.terminal-header .clear-btn:hover { opacity: 1; }
		.terminal-output {
			flex: 1;
			overflow-y: auto;
			padding: 8px 12px;
			font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family, monospace));
			font-size: 12px;
			line-height: 1.5;
			white-space: pre-wrap;
			word-break: break-all;
			background: var(--bg-tertiary);
		}

		/* Apply bar */
		.apply-bar {
			display: none;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			background: var(--bg-secondary);
			border-top: 1px solid var(--border-color);
		}
		.apply-bar.visible { display: flex; }
		.apply-bar .apply-info {
			flex: 1;
			font-size: 12px;
		}
		.apply-bar .apply-btn {
			padding: 6px 20px;
			background: var(--accent);
			color: var(--accent-fg);
			border: none;
			border-radius: 3px;
			font-weight: 600;
			cursor: pointer;
			font-size: 13px;
		}
		.apply-bar .apply-btn:hover { background: var(--accent-hover); }
		.apply-bar .apply-btn.danger {
			background: var(--danger);
		}

		/* Confirmation input */
		.confirm-bar {
			display: none;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			background: var(--bg-secondary);
			border-top: 1px solid var(--border-color);
		}
		.confirm-bar.visible { display: flex; }
		.confirm-bar label {
			font-size: 12px;
			font-weight: 600;
		}
		.confirm-bar input {
			flex: 1;
			max-width: 200px;
			padding: 4px 8px;
			border: 1px solid var(--border-color);
			background: var(--bg-primary);
			color: var(--text-primary);
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			border-radius: 3px;
		}
		.confirm-bar button {
			padding: 4px 12px;
			background: var(--accent);
			color: var(--accent-fg);
			border: none;
			border-radius: 3px;
			font-weight: 600;
			cursor: pointer;
		}
		.confirm-bar .cancel-btn {
			background: transparent;
			color: var(--text-secondary);
			border: 1px solid var(--border-color);
		}

		/* Spinner */
		.spinner {
			display: inline-block;
			width: 12px;
			height: 12px;
			border: 2px solid var(--text-secondary);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
		}
		@keyframes spin { to { transform: rotate(360deg); } }

		/* Searchable root dropdown */
		.root-search-wrapper {
			position: relative;
			flex: 1;
			max-width: 420px;
		}
		.root-search-input {
			width: 100%;
			padding: 4px 10px;
			border: 1px solid var(--border-color);
			background: var(--bg-primary);
			color: var(--text-primary);
			border-radius: 3px;
			font-size: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
			outline: none;
		}
		.root-search-input:focus {
			border-color: var(--accent);
		}
		.root-search-input::placeholder {
			color: var(--text-secondary);
			opacity: 0.7;
		}
		.root-dropdown {
			display: none;
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			max-height: 280px;
			overflow-y: auto;
			background: var(--bg-primary);
			border: 1px solid var(--border-color);
			border-top: none;
			border-radius: 0 0 3px 3px;
			z-index: 100;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		}
		.root-dropdown.visible {
			display: block;
		}
		.root-dropdown-item {
			padding: 6px 10px;
			font-size: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.root-dropdown-item:hover,
		.root-dropdown-item.highlighted {
			background: var(--highlight-bg);
			color: var(--highlight-fg);
		}
		.root-dropdown-item.selected {
			font-weight: 600;
		}
		.root-dropdown-empty {
			padding: 8px 10px;
			font-size: 12px;
			color: var(--text-secondary);
			font-style: italic;
		}

		/* Resize handle */
		.resize-handle {
			height: 4px;
			cursor: ns-resize;
			background: transparent;
			flex-shrink: 0;
		}
		.resize-handle:hover { background: var(--accent); }
	</style>
</head>
<body>
	<!-- Toolbar -->
	<div class="toolbar">
		<label style="font-size:12px;font-weight:600;">Root:</label>
		<div class="root-search-wrapper" id="rootSearchWrapper">
			<input type="text" class="root-search-input" id="rootSearchInput" placeholder="Search terraform roots..." autocomplete="off" />
			<div class="root-dropdown" id="rootDropdown"></div>
		</div>
		<button id="planBtn" disabled>▶ Run Plan</button>
		<div class="spacer"></div>
		<div class="status" id="statusText"></div>
	</div>

	<!-- Main area -->
	<div class="main">
		<!-- Left: Resource list -->
		<div class="resource-list">
			<div class="resource-list-header">
				Resources <span class="count" id="resourceCount">0</span>
			</div>
			<div class="resource-items" id="resourceItems">
				<div class="empty-state" id="resourceEmpty">
					Run a plan to see resource changes
				</div>
			</div>
		</div>

		<!-- Right: Diff viewer -->
		<div class="diff-panel">
			<div class="diff-header" id="diffHeader">Select a resource to view changes</div>
			<div class="diff-content" id="diffContent">
				<div class="empty-state">
					Click on a resource in the list to see its planned changes
				</div>
			</div>
		</div>
	</div>

	<!-- Bottom section -->
	<div class="bottom-section" id="bottomSection">
		<div class="resize-handle" id="resizeHandle"></div>
		<div class="terminal-header">
			<span>Output</span>
			<span class="clear-btn" id="clearTerminal" title="Clear output">✕</span>
		</div>
		<div class="terminal-output" id="terminalOutput"></div>

		<!-- Confirmation input for apply -->
		<div class="confirm-bar" id="confirmBar">
			<label>Type "yes" to confirm:</label>
			<input type="text" id="confirmInput" placeholder="yes" autocomplete="off" />
			<button id="confirmBtn">Send</button>
			<button class="cancel-btn" id="cancelBtn">Cancel</button>
		</div>

		<!-- Apply bar -->
		<div class="apply-bar" id="applyBar">
			<div class="apply-info" id="applyInfo">0 resources selected</div>
			<button class="apply-btn" id="applyBtn">Apply Selected</button>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		// State
		let resources = [];
		let selectedResource = null;
		let checkedResources = new Set();
		let currentRoot = '';
		let isRunning = false;

		// DOM elements
		const rootSearchInput = document.getElementById('rootSearchInput');
		const rootDropdown = document.getElementById('rootDropdown');
		const rootSearchWrapper = document.getElementById('rootSearchWrapper');
		const planBtn = document.getElementById('planBtn');
		const statusText = document.getElementById('statusText');
		const resourceItems = document.getElementById('resourceItems');
		const resourceEmpty = document.getElementById('resourceEmpty');
		const resourceCount = document.getElementById('resourceCount');
		const diffHeader = document.getElementById('diffHeader');
		const diffContent = document.getElementById('diffContent');
		const terminalOutput = document.getElementById('terminalOutput');
		const clearTerminal = document.getElementById('clearTerminal');
		const applyBar = document.getElementById('applyBar');
		const applyInfo = document.getElementById('applyInfo');
		const applyBtn = document.getElementById('applyBtn');
		const confirmBar = document.getElementById('confirmBar');
		const confirmInput = document.getElementById('confirmInput');
		const confirmBtn = document.getElementById('confirmBtn');
		const cancelBtn = document.getElementById('cancelBtn');
		const bottomSection = document.getElementById('bottomSection');
		const resizeHandle = document.getElementById('resizeHandle');

		// Resize logic for bottom panel
		let isResizing = false;
		resizeHandle.addEventListener('mousedown', (e) => {
			isResizing = true;
			e.preventDefault();
		});
		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const rect = document.body.getBoundingClientRect();
			const newHeight = rect.bottom - e.clientY;
			bottomSection.style.height = Math.max(80, Math.min(newHeight, rect.height - 100)) + 'px';
		});
		document.addEventListener('mouseup', () => { isResizing = false; });

		// Searchable root dropdown logic
		let allRoots = [];
		let highlightedIndex = -1;

		function getRootLabel(root) {
			const parts = root.replace(/\\\\/g, '/').split('/');
			return parts.slice(-2).join('/');
		}

		function renderDropdown(filter) {
			rootDropdown.innerHTML = '';
			const query = (filter || '').toLowerCase();
			const filtered = allRoots.filter(root => getRootLabel(root).toLowerCase().includes(query) || root.toLowerCase().includes(query));

			if (filtered.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'root-dropdown-empty';
				empty.textContent = query ? 'No matching roots' : 'No Terraform roots found';
				rootDropdown.appendChild(empty);
				highlightedIndex = -1;
				return filtered;
			}

			highlightedIndex = Math.min(highlightedIndex, filtered.length - 1);
			if (highlightedIndex < 0) highlightedIndex = 0;

			filtered.forEach((root, i) => {
				const item = document.createElement('div');
				item.className = 'root-dropdown-item'
					+ (root === currentRoot ? ' selected' : '')
					+ (i === highlightedIndex ? ' highlighted' : '');
				item.textContent = getRootLabel(root);
				item.title = root;
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					selectRoot(root);
				});
				item.addEventListener('mouseenter', () => {
					highlightedIndex = i;
					updateHighlight();
				});
				rootDropdown.appendChild(item);
			});
			return filtered;
		}

		function updateHighlight() {
			const items = rootDropdown.querySelectorAll('.root-dropdown-item');
			items.forEach((item, i) => {
				item.classList.toggle('highlighted', i === highlightedIndex);
			});
		}

		function selectRoot(root) {
			currentRoot = root;
			rootSearchInput.value = getRootLabel(root);
			rootDropdown.classList.remove('visible');
			planBtn.disabled = !currentRoot || isRunning;
		}

		function showDropdown() {
			renderDropdown(rootSearchInput.value);
			rootDropdown.classList.add('visible');
		}

		rootSearchInput.addEventListener('focus', () => {
			rootSearchInput.select();
			showDropdown();
		});

		rootSearchInput.addEventListener('input', () => {
			highlightedIndex = 0;
			renderDropdown(rootSearchInput.value);
		});

		rootSearchInput.addEventListener('keydown', (e) => {
			const items = rootDropdown.querySelectorAll('.root-dropdown-item');
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (!rootDropdown.classList.contains('visible')) {
					showDropdown();
					return;
				}
				highlightedIndex = Math.min(highlightedIndex + 1, items.length - 1);
				updateHighlight();
				if (items[highlightedIndex]) items[highlightedIndex].scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				highlightedIndex = Math.max(highlightedIndex - 1, 0);
				updateHighlight();
				if (items[highlightedIndex]) items[highlightedIndex].scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'Enter') {
				e.preventDefault();
				if (highlightedIndex >= 0 && items[highlightedIndex]) {
					const query = (rootSearchInput.value || '').toLowerCase();
					const filtered = allRoots.filter(root => getRootLabel(root).toLowerCase().includes(query) || root.toLowerCase().includes(query));
					if (filtered[highlightedIndex]) {
						selectRoot(filtered[highlightedIndex]);
					}
				}
			} else if (e.key === 'Escape') {
				rootDropdown.classList.remove('visible');
				rootSearchInput.value = currentRoot ? getRootLabel(currentRoot) : '';
			}
		});

		rootSearchInput.addEventListener('blur', () => {
			// Delay to allow mousedown on dropdown items to fire first
			setTimeout(() => {
				rootDropdown.classList.remove('visible');
				rootSearchInput.value = currentRoot ? getRootLabel(currentRoot) : '';
			}, 150);
		});

		// Plan button
		planBtn.addEventListener('click', () => {
			if (!currentRoot || isRunning) return;
			vscode.postMessage({ type: 'runPlan', root: currentRoot });
		});

		// Clear terminal
		clearTerminal.addEventListener('click', () => {
			terminalOutput.textContent = '';
		});

		// Apply button
		applyBtn.addEventListener('click', () => {
			if (checkedResources.size === 0 || !currentRoot || isRunning) return;
			const targets = Array.from(checkedResources);
			vscode.postMessage({ type: 'applyTargets', root: currentRoot, targets });
		});

		// Confirmation
		confirmBtn.addEventListener('click', sendConfirmation);
		confirmInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') sendConfirmation();
		});
		cancelBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'cancelApply' });
			confirmBar.classList.remove('visible');
		});

		function sendConfirmation() {
			const val = confirmInput.value;
			vscode.postMessage({ type: 'confirmApply', input: val });
			appendTerminal('> ' + val + '\\n');
			confirmInput.value = '';
			confirmBar.classList.remove('visible');
		}

		// Render resource list
		function renderResources() {
			resourceCount.textContent = resources.length;

			if (resources.length === 0) {
				resourceItems.innerHTML = '';
				resourceItems.appendChild(resourceEmpty);
				resourceEmpty.style.display = '';
				return;
			}

			resourceEmpty.style.display = 'none';
			resourceItems.innerHTML = '';

			for (const rc of resources) {
				const item = document.createElement('div');
				item.className = 'resource-item' + (selectedResource === rc.address ? ' selected' : '');

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = checkedResources.has(rc.address);
				checkbox.addEventListener('change', (e) => {
					e.stopPropagation();
					if (checkbox.checked) {
						checkedResources.add(rc.address);
					} else {
						checkedResources.delete(rc.address);
					}
					updateApplyBar();
				});
				checkbox.addEventListener('click', (e) => e.stopPropagation());

				const info = document.createElement('div');
				info.className = 'resource-info';
				const addr = document.createElement('div');
				addr.className = 'resource-address';
				if (rc.mode === 'data') {
					const dataTag = document.createElement('span');
					dataTag.className = 'resource-mode-tag';
					dataTag.textContent = 'data';
					addr.appendChild(dataTag);
					addr.appendChild(document.createTextNode(' ' + rc.address));
				} else {
					addr.textContent = rc.address;
				}
				addr.title = rc.address;
				info.appendChild(addr);

				const actionBadge = document.createElement('span');
				actionBadge.className = 'resource-action action-' + getActionClass(rc.actions, rc.mode);
				actionBadge.textContent = rc.mode === 'data' ? 'read' : rc.actions.join('/');

				item.appendChild(checkbox);
				item.appendChild(info);
				item.appendChild(actionBadge);

				item.addEventListener('click', () => {
					selectedResource = rc.address;
					renderResources();
					renderDiff(rc);
				});

				resourceItems.appendChild(item);
			}
		}

		function getActionClass(actions, mode) {
			if (mode === 'data') return 'read';
			if (actions.includes('delete') && actions.includes('create')) return 'replace';
			if (actions.includes('delete')) return 'delete';
			if (actions.includes('create')) return 'create';
			if (actions.includes('update')) return 'update';
			if (actions.includes('read')) return 'read';
			return 'update';
		}

		function renderDiff(rc) {
			diffHeader.textContent = rc.address + '  (' + rc.actions.join(', ') + ')';

			const diffText = rc.diffText || 'No diff available';
			const lines = diffText.split('\\n');
			diffContent.innerHTML = '';

			for (const line of lines) {
				const div = document.createElement('div');
				if (line.startsWith('# ')) {
					div.className = 'line-header';
				} else if (line.startsWith('+ ')) {
					div.className = 'line-add';
				} else if (line.startsWith('- ')) {
					div.className = 'line-remove';
				} else if (line.startsWith('~ ')) {
					div.className = 'line-change';
				} else if (line.startsWith('  - ') || line.startsWith('  + ')) {
					div.className = line.startsWith('  +') ? 'line-add' : 'line-remove';
				} else {
					div.className = 'line-unchanged';
				}
				div.textContent = line;
				diffContent.appendChild(div);
			}
		}

		function updateApplyBar() {
			const count = checkedResources.size;
			if (count > 0 && !isRunning) {
				applyBar.classList.add('visible');
				applyInfo.textContent = count + ' resource' + (count > 1 ? 's' : '') + ' selected for apply';
			} else {
				applyBar.classList.remove('visible');
			}
		}

		function appendTerminal(text) {
			terminalOutput.textContent += text;
			terminalOutput.scrollTop = terminalOutput.scrollHeight;
		}

		function setStatus(text, spinning) {
			statusText.innerHTML = (spinning ? '<span class="spinner"></span> ' : '') + text;
		}

		function setRunning(val) {
			isRunning = val;
			planBtn.disabled = !currentRoot || isRunning;
			updateApplyBar();
		}

		// Handle messages from extension
		window.addEventListener('message', (event) => {
			const msg = event.data;
			switch (msg.type) {
				case 'terraformRoots': {
					allRoots = msg.roots || [];
					if (allRoots.length === 0) {
						rootSearchInput.placeholder = 'No Terraform roots found';
						rootSearchInput.value = '';
						currentRoot = '';
					} else {
						rootSearchInput.placeholder = 'Search terraform roots... (' + allRoots.length + ' found)';
						// Preselect the root from context menu, or default to first
						if (msg.preselectedRoot && allRoots.includes(msg.preselectedRoot)) {
							currentRoot = msg.preselectedRoot;
						} else {
							currentRoot = allRoots[0];
						}
						rootSearchInput.value = getRootLabel(currentRoot);
						planBtn.disabled = false;
					}
					break;
				}
				case 'planStarted':
					setRunning(true);
					setStatus('Running plan...', true);
					terminalOutput.textContent = '';
					resources = [];
					selectedResource = null;
					checkedResources.clear();
					renderResources();
					diffHeader.textContent = 'Select a resource to view changes';
					diffContent.innerHTML = '<div class="empty-state">Running terraform plan...</div>';
					break;

				case 'planOutput':
					appendTerminal(msg.data);
					break;

				case 'planComplete':
					setRunning(false);
					resources = msg.plan.resourceChanges;
					setStatus(resources.length + ' resource change' + (resources.length !== 1 ? 's' : ''), false);
					renderResources();
					if (resources.length > 0) {
						selectedResource = resources[0].address;
						renderResources();
						renderDiff(resources[0]);
					} else {
						diffContent.innerHTML = '<div class="empty-state">No changes detected. Infrastructure is up-to-date.</div>';
					}
					appendTerminal('\\n--- Plan complete: ' + resources.length + ' change(s) ---\\n');
					break;

				case 'planError':
					setRunning(false);
					setStatus('Plan failed', false);
					appendTerminal('\\nERROR: ' + msg.error + '\\n');
					break;

				case 'applyStarted':
					setRunning(true);
					setStatus('Applying...', true);
					terminalOutput.textContent = '';
					confirmBar.classList.remove('visible');
					break;

				case 'applyOutput':
					appendTerminal(msg.data);
					break;

				case 'waitingForConfirmation':
					confirmBar.classList.add('visible');
					confirmInput.focus();
					setStatus('Waiting for confirmation...', false);
					break;

				case 'applyComplete':
					setRunning(false);
					confirmBar.classList.remove('visible');
					if (msg.success) {
						setStatus('Apply complete ✓', false);
						appendTerminal('\\n--- Apply completed successfully ---\\n');
					} else {
						setStatus('Apply failed', false);
						appendTerminal('\\n--- Apply failed ---\\n');
					}
					break;

				case 'applyError':
					setRunning(false);
					confirmBar.classList.remove('visible');
					setStatus('Apply error', false);
					appendTerminal('\\nERROR: ' + msg.error + '\\n');
					break;
			}
		});

		// Request roots on load
		vscode.postMessage({ type: 'requestRoots' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
