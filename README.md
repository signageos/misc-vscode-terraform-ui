# Terraform UI — VSCode Extension

A visual diff tool for Terraform plan changes with targeted apply support.

## Features

- **Visual Plan Diff**: Run `terraform plan` and see all resource changes in a split-pane UI
- **Resource List**: Left panel shows all resources to be changed with action badges (create/update/delete/replace)
- **Diff Viewer**: Click any resource to see its attribute-level diff on the right panel
- **Targeted Apply**: Select specific resources with checkboxes and apply only those changes using `-target`
- **Live Terminal Output**: See real-time `terraform` command output in the bottom panel
- **CLI Confirmation**: Type "yes" to confirm apply, just like the standard Terraform CLI
- **Auto-Detection**: Automatically finds all Terraform roots in your workspace

## Usage

1. Open a workspace containing Terraform files (`.tf`)
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Type **"Terraform UI"** and select it
4. Or right-click a folder/`.tf` file in the Explorer and select **"Terraform UI"**

### Workflow

1. Select a Terraform root from the dropdown
2. Click **▶ Run Plan** to execute `terraform plan`
3. Review resources in the left panel — click any to see detailed diff
4. Check the resources you want to apply
5. Click **Apply Selected** at the bottom
6. Type `yes` in the confirmation prompt and press Enter

## Requirements

- **Terraform CLI** must be installed and available in your `PATH`
- Terraform must be initialized (`terraform init`) in your project directories

## Development

```bash
cd experiments/vscode-terraform-ui
npm install
npm run compile
```

To test: Press `F5` in VSCode to launch Extension Development Host.
