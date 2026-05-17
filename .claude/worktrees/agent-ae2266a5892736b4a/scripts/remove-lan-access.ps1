# Run as Administrator to undo setup-lan-access.ps1
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Port = 8899

Write-Host "Removing portproxy rules for port $Port..." -ForegroundColor Cyan
$rules = netsh interface portproxy show v4tov4 | Select-String "$Port\s"
foreach ($r in $rules) {
    $ip = ($r.ToString().Trim() -split "\s+")[0]
    netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$ip 2>$null | Out-Null
}

Write-Host "Removing firewall rule..." -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "ClaudeMCP $Port (LAN)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host "Done." -ForegroundColor Green
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
