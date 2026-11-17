<#
  uninstall.ps1 - Chrome ネイティブメッセージングホストの登録を解除します。
  使い方: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param([switch]$Edge)

$ErrorActionPreference = 'Stop'
$hostName = 'com.local.m3u8mp4'
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"

$keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Vivaldi\NativeMessagingHosts\$hostName"
)
if ($Edge) { $keys += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }

foreach ($k in $keys) {
    if (Test-Path $k) {
        Remove-Item -Path $k -Recurse -Force
        Write-Host "[OK] レジストリを削除しました: $k"
    } else {
        Write-Host "[--] 未登録: $k"
    }
}

if (Test-Path $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
    Write-Host "[OK] マニフェストを削除しました: $manifestPath"
}

Write-Host ''
Write-Host '完了しました。Chrome の chrome://extensions から拡張機能も削除してください。'
