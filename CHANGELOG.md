# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

Entries should be short and human-readable; for longer entries, use an indented list.

`Changed` and `Removed` entries should be used only for breaking changes to the outward-facing API.

## [Unreleased]

## [0.3.1] - 2026-10-27
### Fixed
- (public) Terraform UI can run operations concurrently in different root directories while preventing overlapping operations in the same directory.

## [0.3.0] - 2026-10-26
### Added
- (public) Initialize Terraform roots with visible terminal-style arguments, private per-root saved settings, and safe flag suggestions.
- (public) Configure the Terraform executable visibly and choose masked or explicitly revealed environment editing separately for each root.
- (public) Open the integrated terminal’s current Terraform folder, including folders in symlink-opened workspaces, by typing tfui or terraform-ui in opt-in new POSIX terminals, with keyboard and existing-terminal fallbacks and recovery instructions for expired shortcuts; requires VS Code 1.96.0 or newer.

### Fixed
- (public) Preserve multiline template and object diff coloring, unchanged context, and literal text rendering on every line; distinguish carriage returns from literal backslash-r text.

## [0.2.1] - 2026-04-16
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

## [0.1.0] - 2026-04-15
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
