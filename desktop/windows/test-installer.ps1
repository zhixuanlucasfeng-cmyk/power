$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:RUNNER_TEMP 'Power Installed App'
$env:POWER_HOME = Join-Path $env:RUNNER_TEMP 'Power Installer Test Data'
$env:POWER_PORT = '14546'
New-Item -ItemType Directory -Force $env:POWER_HOME | Out-Null
Set-Content (Join-Path $env:POWER_HOME 'keep.txt') 'Keep user data on uninstall'
$setup = Start-Process -FilePath (Resolve-Path 'dist/Power-Setup-x64.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$installDir`"") -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
if (!(Test-Path "$installDir\Power.exe")) { throw 'Launcher was not installed' }
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Power.lnk'
if (!(Test-Path $shortcut)) { throw 'Start menu shortcut missing' }
$app = Start-Process -FilePath "$installDir\Power.exe" -PassThru
try {
  $bridge = Join-Path $env:POWER_HOME 'desktop-connection.json'
  for ($i=0; $i -lt 100 -and !(Test-Path $bridge); $i++) { Start-Sleep -Milliseconds 300 }
  if (!(Test-Path $bridge)) { throw 'Installed desktop did not start' }
  $meta = Invoke-WebRequest 'http://127.0.0.1:14546/api/meta'
  if ($meta.StatusCode -ne 200) { throw 'Installed server unavailable' }
  $config = Get-Content $bridge -Raw | ConvertFrom-Json
  $tab = Invoke-RestMethod $config.endpoint -Method Post -Headers @{Authorization="Bearer $($config.token)"} -ContentType 'application/json' -Body '{"action":"new","args":{"url":"about:blank"}}'
  if (!$tab.id) { throw 'Installed browser could not create a tab' }
} finally {
  taskkill /PID $app.Id /T /F | Out-Null
}
$uninstall = Start-Process "$installDir\unins000.exe" -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw 'Uninstall failed' }
if (Test-Path "$installDir\Power.exe") { throw 'Uninstall left the launcher installed' }
if (!(Test-Path (Join-Path $env:POWER_HOME 'keep.txt'))) { throw 'Uninstall removed user data' }
Write-Output 'Installer, Start menu shortcut, app startup, browser tab and data-preserving uninstall passed.'
