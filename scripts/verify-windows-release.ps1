$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $repoRoot 'desktop/dist'
$expectedPublisher = [Environment]::GetEnvironmentVariable('WINDOWS_SIGNING_PUBLISHER')
if ([string]::IsNullOrWhiteSpace($expectedPublisher)) {
  throw 'WINDOWS_SIGNING_PUBLISHER is required'
}

$installers = @(Get-ChildItem -Path $distRoot -Filter 'Emperor-Agent-*-win-x64.exe' -File)
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows x64 installer, found $($installers.Count)"
}
$installer = $installers[0]
$installRoot = Join-Path $env:RUNNER_TEMP 'EmperorAgent'
$installedExecutable = Join-Path $installRoot 'Emperor Agent.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Emperor Agent.exe'

function Assert-TrustedSignature([string]$Path) {
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid Authenticode signature for $Path`: $($signature.Status)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Missing signer certificate for $Path"
  }
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($publisher -cne $expectedPublisher) {
    throw "Unexpected Authenticode publisher for $Path"
  }
}

function Invoke-CheckedProcess(
  [string]$FilePath,
  [string[]]$ArgumentList
) {
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$FilePath exited with code $($process.ExitCode)"
  }
}

Remove-Item -Path $installRoot -Recurse -Force -ErrorAction SilentlyContinue
try {
  Assert-TrustedSignature $installer.FullName
  Invoke-CheckedProcess $installer.FullName @('/S', "/D=$installRoot")
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
    throw "Installed executable not found: $installedExecutable"
  }
  Assert-TrustedSignature $installedExecutable

  $env:EMPEROR_SMOKE_APP = $installedExecutable
  Invoke-CheckedProcess 'node' @(
    (Join-Path $repoRoot 'desktop/scripts/run-packaged-smoke.cjs')
  )

  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Uninstaller not found: $uninstaller"
  }
  Assert-TrustedSignature $uninstaller
  Invoke-CheckedProcess $uninstaller @('/S')

  $hash = (Get-FileHash -Path $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = Join-Path $distRoot 'SHA256SUMS-windows-x64.txt'
  Set-Content -Path $checksumPath -Value "$hash *$($installer.Name)" -Encoding utf8NoBOM
  Write-Host "Windows trusted release verification passed: $($installer.Name)"
}
finally {
  Remove-Item Env:EMPEROR_SMOKE_APP -ErrorAction SilentlyContinue
  Remove-Item -Path $installRoot -Recurse -Force -ErrorAction SilentlyContinue
}
