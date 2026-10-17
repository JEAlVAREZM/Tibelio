$ErrorActionPreference = 'Stop'
$previousEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Push-Location (Split-Path $PSScriptRoot -Parent)
$firstPointer = [IntPtr]::Zero
$secondPointer = [IntPtr]::Zero
try {
  $adminUsername = Read-Host 'Usuario del superadministrador que deseas recuperar'
  $firstSecret = Read-Host 'Nueva contrasena (12-128 caracteres)' -AsSecureString
  $secondSecret = Read-Host 'Repite la nueva contrasena' -AsSecureString
  $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($firstSecret)
  $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secondSecret)
  $payload = @{ username=$adminUsername; password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer); confirmPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer) } | ConvertTo-Json -Compress
  $payload | node scripts/prepare-superadmin.mjs --reset
  if ($LASTEXITCODE -ne 0) { throw 'No se genero el archivo de recuperacion. Revisa los datos e intenta nuevamente.' }
} finally {
  if ($firstPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer) }
  if ($secondPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer) }
  $payload = $null
  if ($firstSecret) { $firstSecret.Dispose() }
  if ($secondSecret) { $secondSecret.Dispose() }
  $OutputEncoding = $previousEncoding
  Pop-Location
}
