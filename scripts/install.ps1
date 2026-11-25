param(
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'

function Set-InstalledSidecarCommand([string]$manifestPath) {
    $cmdPath = Join-Path $env:APPDATA 'Antigravity\bin\agy-node.cmd'
    if (-not (Test-Path -LiteralPath $cmdPath)) {
        Write-Host "agy-node.cmd not found; keeping default node command."
        return
    }
    $wrapper = Get-Content -LiteralPath $cmdPath -Encoding UTF8 -Raw
    if ($wrapper -notmatch '(?im)^[ \t]*"(?<exe>(?:[a-z]:\\|\\\\)[^"\r\n]*\\Antigravity\.exe)"[ \t]+%\*[ \t]*\r?$') {
        Write-Host "Could not identify Antigravity.exe in agy-node.cmd; keeping default node command."
        return
    }
    $exe = $Matches.exe
    if ($exe -notmatch '[^\x00-\x7f]') { return }
    if (-not [IO.File]::Exists($exe)) {
        Write-Host "Antigravity.exe not found at $exe; keeping default node command."
        return
    }
    $loader = Join-Path $env:USERPROFILE '.gemini\antigravity\lib\node_modules\sidecar_sdk\register_loader.js'
    if (-not [IO.File]::Exists($loader)) {
        Write-Host "SDK loader not found at $loader; keeping default node command."
        return
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest.command = $exe
    $manifest.args = @("--import=$(([uri]$loader).AbsoluteUri)") + $manifest.args
    if (-not $manifest.env) { $manifest | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
    $manifest.env | Add-Member -NotePropertyName ELECTRON_RUN_AS_NODE -NotePropertyValue '1' -Force
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host "Non-ASCII path detected: sidecar.json updated to launch via Antigravity.exe directly."
}

$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'agy-mini-bar'))
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\agy-mini-bar')).Path

if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) {
    throw "Source plugin manifest missing: $source\plugin.json"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
& robocopy.exe $source $destination /MIR /XJ /NFL /NDL /NJH /NJS /NP /R:2 /W:1
if ($LASTEXITCODE -ge 8) {
    throw "Plugin copy failed (robocopy exit code $LASTEXITCODE)."
}

Set-InstalledSidecarCommand (Join-Path $destination 'sidecars\mini_bar\sidecar.json')
Write-Host "Installed agy-mini-bar to $destination"
Write-Host "Next step: enable 'agy-mini-bar' in Antigravity Plugins panel (restart Antigravity from the Start Menu shortcut if not visible yet)."
exit 0
