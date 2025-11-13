param(
  [string]$Path = "analytics\\trades.log",
  [int]$Tail = 50,
  [switch]$Follow
)

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Host "Log file not found: $Path" -ForegroundColor Yellow
  exit 1
}

if ($Follow) {
  Write-Host "Following: $Path (Ctrl+C to stop)" -ForegroundColor Cyan
  Get-Content -LiteralPath $Path -Wait -Encoding UTF8
} else {
  Write-Host "Last $Tail lines from: $Path" -ForegroundColor Cyan
  Get-Content -LiteralPath $Path -Tail $Tail -Encoding UTF8
}
