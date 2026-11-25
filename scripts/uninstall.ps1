param(
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'

$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'agy-mini-bar'))

if ((Split-Path -Parent $destination) -ne $pluginRoot -or (Split-Path -Leaf $destination) -ne 'agy-mini-bar') {
    throw "Invalid plugin destination: $destination"
}

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
    Write-Host "Removed agy-mini-bar from $destination"
} else {
    Write-Host "Not installed: $destination"
}
exit 0
