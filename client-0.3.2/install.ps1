<#
.SYNOPSIS
  Installs the BeeNet (蜂网) client for the current user (no administrator rights).

.DESCRIPTION
  Copies beenet.exe and node-agent.exe from this folder to
  %LOCALAPPDATA%\BeeNet\app and makes a Start menu shortcut. It does not start
  the client at sign-in (that is a switch on the client's account page), does
  not touch anything outside your own profile, and shares nothing: the client
  asks on its first start.

  -DryRun shows what would be done and changes nothing. -Uninstall removes the
  program and the shortcut (your account key and settings in
  %APPDATA%\BeeNet stay unless you add -RemoveData).
#>
param([switch] $DryRun, [switch] $Uninstall, [switch] $RemoveData, [switch] $Start)
$ErrorActionPreference = "Stop"
$app = Join-Path $env:LOCALAPPDATA "BeeNet\app"
$data = Join-Path $env:APPDATA "BeeNet"
$lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "BeeNet.lnk"
function Step($what, [scriptblock] $act) { if ($DryRun) { Write-Host "would: $what" } else { Write-Host $what; & $act } }

if ($Uninstall) {
  Step "stop a running client" { Get-Process beenet, node-agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$app*" } | Stop-Process -Force }
  Step "remove $app" { if (Test-Path $app) { Remove-Item -Recurse -Force $app } }
  Step "remove the Start menu shortcut" { if (Test-Path $lnk) { Remove-Item -Force $lnk } }
  Step "remove the start-at-sign-in entry, if any" { Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name BeeNet -ErrorAction SilentlyContinue }
  if ($RemoveData) { Step "remove $data (your key and settings)" { if (Test-Path $data) { Remove-Item -Recurse -Force $data } } }
  return
}
foreach ($f in "beenet.exe", "node-agent.exe") {
  if (-not (Test-Path (Join-Path $PSScriptRoot $f))) { throw "$f is not next to this script" }
}
Step "copy the program to $app" {
  New-Item -ItemType Directory -Force $app | Out-Null
  foreach ($f in "beenet.exe", "node-agent.exe") { Copy-Item -Force (Join-Path $PSScriptRoot $f) (Join-Path $app $f) }
}
Step "make the Start menu shortcut" {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $app "beenet.exe"
  $s.WorkingDirectory = $app
  $s.Description = "蜂网 BeeNet"
  $s.Save()
}
if ($Start) { Step "start the client" { Start-Process (Join-Path $app "beenet.exe") } }
Write-Host "Done. Open BeeNet from the Start menu; it asks before it shares anything."
