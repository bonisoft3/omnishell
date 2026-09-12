$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Dir ".." "runtime" "omnishell.ps1") @args
exit $LASTEXITCODE
