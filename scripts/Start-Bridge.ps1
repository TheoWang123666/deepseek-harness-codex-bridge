# Launch the local bridge without a global npm installation or profile changes.
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $BridgeArguments
)

$ErrorActionPreference = 'Stop'
$bridgeEntry = Join-Path (Split-Path -Parent $PSScriptRoot) 'server.mjs'
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $nodeCommand.Source $bridgeEntry @BridgeArguments
exit $LASTEXITCODE
