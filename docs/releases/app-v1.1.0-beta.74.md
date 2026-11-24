# App beta 74

The desktop app can reload a project task or another nested page directly. Packaged renderer assets keep the same local URL when a page is opened from the sidebar, restored from history or reloaded.

The package check resolves the script and stylesheet URLs at both the home page and a nested route, then verifies that the exported files are present.
