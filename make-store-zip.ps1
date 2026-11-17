<#
  make-store-zip.ps1 - Chrome ウェブストア提出用の zip を作る

  使い方:
    powershell -ExecutionPolicy Bypass -File .\make-store-zip.ps1
    → dist\m3u8-to-mp4-<version>.zip が出来る

  注意:
    ・zip の直下に manifest.json が来るようにする（フォルダごと入れない）
    ・拡張の動作に不要なファイル（native-host, node_modules, README 等）は入れない
#>
[CmdletBinding()]
param([string]$OutDir = 'dist')

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$extDir = Join-Path $root 'extension'
$manifestPath = Join-Path $extDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) { throw "manifest.json がありません: $manifestPath" }

# manifest を検証
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) { throw 'manifest.json に version がありません' }
$version = $manifest.version

# zip に入れてよいものだけを列挙（ホワイトリスト）
$allowed = @('manifest.json', 'background.js', 'content.js', 'inject.js', 'popup.html', 'popup.css', 'popup.js', 'icons')
$missing = @()
foreach ($name in $allowed) {
    if (-not (Test-Path -LiteralPath (Join-Path $extDir $name))) {
        if ($name -ne 'icons') { $missing += $name }
    }
}
if ($missing.Count -gt 0) { throw ("拡張に必要なファイルがありません: " + ($missing -join ', ')) }

if (-not (Test-Path -LiteralPath (Join-Path $root $OutDir))) {
    New-Item -ItemType Directory -Path (Join-Path $root $OutDir) -Force | Out-Null
}
$zipPath = Join-Path (Join-Path $root $OutDir) ("m3u8-to-mp4-$version.zip")
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ZipFile.CreateFromDirectory は Windows で "\" 区切りになることがあるため、
# エントリ名を "/" に正規化して自前で作成する（Chrome 側の解釈を確実にする）
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $files = Get-ChildItem -LiteralPath $extDir -Recurse -File | Sort-Object FullName
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($extDir.Length + 1).Replace('\', '/')
        $top = $rel.Split('/')[0]
        if ($allowed -notcontains $top) { continue }

        $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        $fs = [System.IO.File]::OpenRead($f.FullName)
        try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
    }
} finally {
    $archive.Dispose()
    $zipStream.Dispose()
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $names = $zip.Entries | ForEach-Object { $_.FullName }
} finally {
    $zip.Dispose()
}

if ($names -notcontains 'manifest.json') { throw 'zip 直下に manifest.json がありません' }
if ($names | Where-Object { $_ -like '..*' }) { throw 'zip に親ディレクトリ参照が含まれています' }

Write-Host ("作成しました: " + $zipPath) -ForegroundColor Green
Write-Host ("サイズ: " + [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1) + " KB")
Write-Host '内容:'
$names | Sort-Object | ForEach-Object { Write-Host ("  " + $_) }
Write-Host ''
Write-Host 'このzipを Chrome ウェブストア デベロッパー ダッシュボードでアップロードしてください。'
