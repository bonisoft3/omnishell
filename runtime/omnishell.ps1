# Windows reaches the pinned Deno stub through Mise rather than a shebang.
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Dir
# The stub's lock sits beside .mise.toml in $Root; mise reads it only from a
# trusted config.
$env:MISE_TRUSTED_CONFIG_PATHS = if ($env:MISE_TRUSTED_CONFIG_PATHS) { "$Root;$env:MISE_TRUSTED_CONFIG_PATHS" } else { $Root }
& mise tool-stub (Join-Path $Dir "deno.toml") run --no-lock --no-check --node-modules-dir=none `
	--config (Join-Path $Root "test" "deno.json") `
	"--allow-read=.,$Root" --allow-write=. --allow-env `
	(Join-Path $Dir "cli.ts") @args
exit $LASTEXITCODE
