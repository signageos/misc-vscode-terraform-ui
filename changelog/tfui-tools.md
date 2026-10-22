### Added
- (public) Initialize Terraform roots with visible terminal-style arguments, private per-root saved settings, and safe flag suggestions.
- (public) Configure the Terraform executable and environment separately for each root.
- (public) Open the integrated terminal’s current Terraform folder, including folders in symlink-opened workspaces, by typing tfui or terraform-ui in opt-in new POSIX terminals, with keyboard and existing-terminal fallbacks and recovery instructions for expired shortcuts; requires VS Code 1.96.0 or newer.

### Fixed
- (public) Preserve multiline template and object diff coloring, unchanged context, and literal text rendering on every line; distinguish carriage returns from literal backslash-r text.
