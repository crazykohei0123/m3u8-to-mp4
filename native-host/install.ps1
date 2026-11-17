<#
  install.ps1 - m3u8 to MP4 ネイティブメッセージングホストのセットアップ

  使い方（拡張機能を先に読み込んでから実行）:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId abcdefghijklmnop...
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Edge   # Edge にも登録

  オプション:
    -ExtensionId <id[,id2]> 拡張ID（カンマ区切りで複数可。省略時は自動検出）
    -SkipBuild         ランチャ(m3u8host.exe)を再ビルドしない
    -Edge              Microsoft Edge にも登録する
    -DryRun            書き込みを行わず内容だけ表示する
#>
[CmdletBinding()]
param(
    [string]$ExtensionId = '',
    [switch]$SkipBuild,
    [switch]$Edge,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$hostName     = 'com.local.m3u8mp4'
$rootDir      = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $rootDir 'extension'
$launcherCs   = Join-Path $PSScriptRoot 'launcher\Launcher.cs'
$exePath      = Join-Path $PSScriptRoot 'm3u8host.exe'
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"

function Read-JsonShared([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Close(); $fs.Close()
        return ($text | ConvertFrom-Json)
    } catch {
        try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
    }
}

function Find-ExtensionIds([string]$dir) {
    $appName = 'm3u8 to MP4 (local ffmpeg)'
    $found = New-Object System.Collections.Generic.List[string]

    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Vivaldi\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
    ) | Where-Object { Test-Path -LiteralPath $_ }

    if (-not $roots) { return @() }

    $normalized = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\').ToLowerInvariant()

    foreach ($userData in $roots) {
        $targets = New-Object System.Collections.Generic.List[string]
        $targets.Add((Join-Path $userData 'Secure Preferences'))
        $targets.Add((Join-Path $userData 'Preferences'))
        foreach ($p in (Get-ChildItem -LiteralPath $userData -Directory -ErrorAction SilentlyContinue)) {
            $targets.Add((Join-Path $p.FullName 'Secure Preferences'))
            $targets.Add((Join-Path $p.FullName 'Preferences'))
        }

        foreach ($t in $targets) {
            $json = Read-JsonShared $t
            if (-not $json) { continue }
            if (-not $json.extensions) { continue }
            $settings = $json.extensions.settings
            if (-not $settings) { continue }
            foreach ($prop in $settings.PSObject.Properties) {
                $entry = $prop.Value
                if (-not $entry) { continue }

                $hit = $false
                # 1) パッケージ化されていない拡張（開発用）: path がこのフォルダと一致
                if ($entry.path) {
                    $pn = ([string]$entry.path).TrimEnd('\').ToLowerInvariant()
                    if ($pn -eq $normalized) { $hit = $true }
                }
                # 2) ストアからインストールした版: manifest.name で一致（path は Extensions\<id>\<ver>）
                if (-not $hit -and $entry.manifest -and ([string]$entry.manifest.name) -eq $appName) { $hit = $true }

                if ($hit -and -not $found.Contains($prop.Name)) {
                    Write-Host ("      検出: " + $prop.Name + "  <- " + $t)
                    $found.Add($prop.Name)
                }
            }
        }
    }
    return $found.ToArray()
}

Write-Host '=== m3u8 to MP4 : native host setup ===' -ForegroundColor Cyan

# 1) ランチャのビルド
if (-not $SkipBuild -or -not (Test-Path -LiteralPath $exePath)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    }
    if (-not (Test-Path -LiteralPath $csc)) { throw ".NET Framework の csc.exe が見つかりません: $csc" }

    Write-Host "[1/4] ランチャをビルド: $exePath"
    if (-not $DryRun) {
        & $csc /nologo /target:exe /optimize "/out:$exePath" $launcherCs | Out-Null
        if (-not (Test-Path -LiteralPath $exePath)) { throw "ランチャのビルドに失敗しました" }
    }
} else {
    Write-Host "[1/4] ランチャはビルド済み: $exePath"
}

# 2) node.exe のパスを記録（Chrome から起動したときの PATH 差異対策）
$nodePath = ''
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $nodePath = $nodeCmd.Source }
if (-not $nodePath) { throw 'node.exe が見つかりません。Node.js をインストールして PATH に通してください。' }

Write-Host "[2/4] node: $nodePath"
if (-not $DryRun) {
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'node-path.txt'), $nodePath + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

# 3) 拡張IDの決定（複数指定可: 開発版とストア版の両方を許可できる）
$ids = New-Object System.Collections.Generic.List[string]

if ($ExtensionId) {
    foreach ($part in ($ExtensionId -split ',')) {
        $t = $part.Trim()
        if ($t -and -not $ids.Contains($t)) { $ids.Add($t) }
    }
}

if ($ids.Count -eq 0) {
    Write-Host '[3/4] 拡張IDを自動検出しています...'
    foreach ($found in (Find-ExtensionIds $extensionDir)) {
        if (-not $ids.Contains($found)) { $ids.Add($found) }
    }
}

if ($ids.Count -eq 0) {
    throw @"
拡張IDを自動検出できませんでした。次の手順で指定してください:
  1. ブラウザで vivaldi://extensions または chrome://extensions を開く
  2. 拡張をインストール（ストア版）または「パッケージ化されていない拡張機能を読み込む」で
     $extensionDir
     を選択
  3. 表示された ID をコピーして再実行:
     powershell -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId <ID>
     複数指定する場合: -ExtensionId "<開発用ID>,<ストア版ID>"
"@
}

foreach ($id in $ids) {
    if ($id -notmatch '^[a-p]{32}$') { Write-Warning "拡張IDの形式が通常と異なります: $id" }
}
Write-Host ("[3/4] extension id: " + ($ids -join ', '))

$allowedOrigins = @()
foreach ($id in $ids) { $allowedOrigins += "chrome-extension://$id/" }

# 4) マニフェスト生成とレジストリ登録
$manifest = [ordered]@{
    name            = $hostName
    description     = 'm3u8 to MP4 : local ffmpeg host'
    path            = $exePath
    type            = 'stdio'
    allowed_origins = $allowedOrigins
}

if ($DryRun) {
    Write-Host '[4/4] DryRun: 以下の内容を書き込む予定です'
    Write-Host ($manifest | ConvertTo-Json -Depth 5)
    Write-Host "registry: HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
    Write-Host "registry: HKCU:\Software\Vivaldi\NativeMessagingHosts\$hostName"
    return
}

$manifestJson = $manifest | ConvertTo-Json -Depth 5
# BOM なし UTF-8 で書く（Chrome のパーサ対策）
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))

$keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Vivaldi\NativeMessagingHosts\$hostName"
)
if ($Edge) { $keys += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }

foreach ($k in $keys) {
    $null = New-Item -Path $k -Force -Value $manifestPath
    Write-Host "[4/4] 登録: $k"
}

Write-Host ''
Write-Host '完了しました。vivaldi://extensions（または chrome://extensions）で拡張を再読み込みしてください。' -ForegroundColor Green
Write-Host 'ffmpeg のパスは拡張のポップアップ → 設定 で指定します（例: C:\ffmpeg\bin\ffmpeg.exe）。'
