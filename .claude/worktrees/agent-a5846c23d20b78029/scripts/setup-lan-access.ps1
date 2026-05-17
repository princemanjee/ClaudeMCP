# Run this file as Administrator: right-click -> "Run with PowerShell" after
# launching PowerShell elevated, OR right-click the file -> "Run as administrator".
# It does three things:
#   1. Makes sure IP Helper service (required by netsh portproxy) is running
#   2. Adds portproxy rules so LAN IPs forward to 127.0.0.1 where Docker actually answers
#   3. Adds a firewall rule that allows inbound 8899 on all profiles
#
# To undo later, run: scripts/remove-lan-access.ps1

$ErrorActionPreference = "Stop"

# Relaunch elevated if we're not already
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Not running as Administrator. Relaunching..." -ForegroundColor Yellow
    Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Port = 8899

Write-Host "[1/3] Ensuring IP Helper service is running..." -ForegroundColor Cyan
Set-Service -Name iphlpsvc -StartupType Automatic
Start-Service -Name iphlpsvc -ErrorAction SilentlyContinue
Get-Service iphlpsvc | Format-Table Name, Status, StartType -AutoSize

Write-Host "[2/3] Adding netsh portproxy rules for all DHCP IPv4 addresses..." -ForegroundColor Cyan
# Clear any prior rules on this port so we start clean
netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
$dhcpIps = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp |
    Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
    Select-Object -ExpandProperty IPAddress
foreach ($ip in $dhcpIps) {
    Write-Host "  forwarding $ip:$Port -> 127.0.0.1:$Port"
    netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$ip 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenport=$Port listenaddress=$ip connectport=$Port connectaddress=127.0.0.1
}
Write-Host ""
netsh interface portproxy show v4tov4

Write-Host "[3/3] Ensuring firewall rule exists for all profiles..." -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "ClaudeMCP $Port (LAN)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "ClaudeMCP $Port (LAN)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
Get-NetFirewallRule -DisplayName "ClaudeMCP $Port (LAN)" | Format-Table DisplayName, Enabled, Direction, Action, Profile -AutoSize

Write-Host ""
Write-Host "Done. Test from another device: http://<LAN-IP>:$Port/health" -ForegroundColor Green
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
