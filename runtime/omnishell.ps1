# The terminal's command line on Windows, which has no shebang dispatch and so
# reaches neither the launcher beside this file nor the deno tool-stub both of
# them run: `mise tool-stub` is how a stub is executed where a shebang is not
# read. MISE_LOCKED=0 because the stub pins its own download and is not in the
# calling project's mise.lock.
#
# The read grant is the union of what the leaves need — the caller's directory,
# the interpreter a check evaluates against, the fixtures a self-test answers
# on — as three units, so cli.ts can hand back one and keep the others.
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Dir
$env:MISE_LOCKED = "0"
& mise tool-stub (Join-Path $Dir "deno.toml") run --no-lock --no-check --node-modules-dir=none `
	--config (Join-Path $Root "test" "deno.json") `
	"--allow-read=.,$(Join-Path $Root 'interpreter'),$(Join-Path $Root 'test')" --allow-env `
	(Join-Path $Dir "cli.ts") @args
exit $LASTEXITCODE
