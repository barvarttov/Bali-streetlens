# Registers a Windows scheduled task that runs tools\run-live.ps1 every time you log in.
# powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1        (add -Remove to undo)
param([switch]$Remove)
$name = "StreetLens live AGA"
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Removed."; exit 0 }
$script = Join-Path $PSScriptRoot "run-live.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered '$name'. After the next login the backend and tunnel start by themselves; the public link is saved in %LOCALAPPDATA%\streetlens-live\share-link.txt"
