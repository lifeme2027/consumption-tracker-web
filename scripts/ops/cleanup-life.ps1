<#
  life.kastop.com 数据保留清理脚本（见 DEPLOY.md「数据保留与清理」）。
  - 删除超过 -Days 天（默认 30）的明文备份目录：-BackupRoot 下名字以 yyyy-MM-dd 开头的子目录（按名字里的日期判断，不看文件时间）。
  - 删除超过 -Days 天的 IIS 访问日志（*.log，按最后写入时间）。
  - 删除超过 -Days 天的应用 stdout 日志（若曾临时开启 stdoutLogEnabled）。
  先用 -WhatIf 试跑，确认列出的都该删，再放进计划任务。
  不会碰 D:\Web\life\App_Data（线上数据库）与 appsettings.Production.json。

  示例：
    powershell -ExecutionPolicy Bypass -File D:\Web\life-ops\cleanup-life.ps1 -WhatIf
    powershell -ExecutionPolicy Bypass -File D:\Web\life-ops\cleanup-life.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$BackupRoot = 'D:\Backup\life',
    [string]$IisLogDir = 'C:\inetpub\logs\LogFiles',   # 其下各 W3SVC<站点ID> 子目录；用 IIS 管理器查看本站点的日志目录并改成实际值
    [string]$StdoutLogDir = 'D:\Web\life\logs',
    [int]$Days = 30
)
$ErrorActionPreference = 'Stop'
if ($Days -lt 1) { throw '-Days 必须 >= 1' }
$cutoff = (Get-Date).Date.AddDays(-$Days)
Write-Host "保留期 $Days 天，早于 $($cutoff.ToString('yyyy-MM-dd')) 的将被清理"

# 1) 明文备份目录：D:\Backup\life\2026-10-25 或 2026-10-25_xxx
if (Test-Path -LiteralPath $BackupRoot) {
    Get-ChildItem -LiteralPath $BackupRoot -Directory | ForEach-Object {
        if ($_.Name -match '^(\d{4})-(\d{2})-(\d{2})') {
            $d = [datetime]::MinValue
            if ([datetime]::TryParseExact($Matches[0], 'yyyy-MM-dd', $null, 'None', [ref]$d) -and $d -lt $cutoff) {
                if ($PSCmdlet.ShouldProcess($_.FullName, "删除过期备份（$($d.ToString('yyyy-MM-dd'))）")) {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force
                }
            }
        }
    }
} else { Write-Warning "备份目录不存在：$BackupRoot" }

# 2) IIS 访问日志
if (Test-Path -LiteralPath $IisLogDir) {
    Get-ChildItem -LiteralPath $IisLogDir -Recurse -File -Filter '*.log' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            if ($PSCmdlet.ShouldProcess($_.FullName, '删除过期 IIS 日志')) { Remove-Item -LiteralPath $_.FullName -Force }
        }
} else { Write-Warning "IIS 日志目录不存在：$IisLogDir" }

# 3) 应用 stdout 日志（默认关闭，仅排错时临时开启）
if (Test-Path -LiteralPath $StdoutLogDir) {
    Get-ChildItem -LiteralPath $StdoutLogDir -File |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            if ($PSCmdlet.ShouldProcess($_.FullName, '删除过期 stdout 日志')) { Remove-Item -LiteralPath $_.FullName -Force }
        }
}
