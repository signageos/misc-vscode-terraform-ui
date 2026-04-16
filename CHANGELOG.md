# Change Log

All notable changes to the "vscode-terraform-ui" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]
### Fixed
- Uploading extensions to public registries

## [0.2.0] - 2026-04-15
### Added
- Interactive search filter for terraform roots with case-insensitive matching
- Parallelism option (`-parallelism` flag) for plan and apply, persisted per root
- Keyboard navigation for resource list with up/down arrow keys
- Toggle resource checkboxes with Space key
- Apply selected resources with Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux)
- Data source attributes included in diff for apply

### Fixed
- Data source diff rendering

## [0.1.0]
### Added
- Initial release
- Visual Terraform plan diff viewer with split-pane UI
- Resource list with action badges (create/update/delete/replace/read)
- Data source support in plan results
- Attribute-level diff viewer with color coding
- Targeted apply with `-target` flags via checkbox selection
- Real-time terminal output for plan and apply commands
- CLI "yes" confirmation for apply (like standard Terraform)
- Auto-detection of Terraform roots in workspace
- Context menu integration with root preselection
- Command palette entry: "Terraform UI"
