# language: PowerShell, file: install-task.ps1
# Daftarkan tugas harian "DuoStreak" yang memanggil run-streak.bat.
# Jalankan:  powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Hapus   :  Unregister-ScheduledTask -TaskName "DuoStreak" -Confirm:$false

$ErrorActionPreference = 'Stop'

$bat = Join-Path $PSScriptRoot 'run-streak.bat'
if (-not (Test-Path -LiteralPath $bat)) { throw "tidak ada: $bat" }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`""
$trigger = New-ScheduledTaskTrigger -Daily -At 09:00
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
    -TaskName 'DuoStreak' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Duolingo streak keeper (local)' `
    -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'DuoStreak'
$i = Get-ScheduledTaskInfo -TaskName 'DuoStreak'

Write-Host "terdaftar : $($t.TaskName)"
Write-Host "state     : $($t.State)"
Write-Host "next run  : $($i.NextRunTime)"
Write-Host ""
Write-Host "Catatan: default jalan hanya saat user login."
Write-Host "Supaya jalan walau logout: buka Task Scheduler -> DuoStreak ->"
Write-Host "Properties -> General -> 'Run whether user is logged on or not' (minta password sekali)."
