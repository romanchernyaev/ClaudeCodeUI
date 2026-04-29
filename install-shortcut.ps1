param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectRoot "launch.vbs"
$iconSrc = Join-Path $projectRoot "frontend\icon.ico"

if (-not (Test-Path $launcher)) {
    throw "Missing launcher: $launcher"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "Claude Code UI.lnk"

$wshell = New-Object -ComObject WScript.Shell
$sc = $wshell.CreateShortcut($lnkPath)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = [char]34 + $launcher + [char]34
$sc.WorkingDirectory = $projectRoot
$sc.WindowStyle = 1
$sc.Description = "Claude Code UI"
if (Test-Path $iconSrc) {
    $sc.IconLocation = $iconSrc
}
$sc.Save()

Write-Host ""
Write-Host "[ok] Shortcut created at: $lnkPath"
Write-Host ""
Write-Host "To pin to taskbar: right-click the Desktop icon, choose Show more options, then Pin to taskbar."
