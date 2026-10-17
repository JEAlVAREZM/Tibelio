$ErrorActionPreference = 'Stop'
$previousEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  $adminName = Read-Host 'Nombre del superadministrador'
  $adminUsername = Read-Host 'Usuario (3-64 letras minusculas, numeros, punto, guion)'
  $adminSecret = Read-Host 'Contrasena nueva (12-128 caracteres; no se muestra)' -AsSecureString
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecret)
  try {
    $payload = @{ displayName=$adminName; username=$adminUsername; password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer) } | ConvertTo-Json -Compress
    $payload | node scripts/prepare-superadmin.mjs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el SQL.' }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    $payload = $null
    $adminSecret.Dispose()
  }
} finally { $OutputEncoding = $previousEncoding; Pop-Location }
