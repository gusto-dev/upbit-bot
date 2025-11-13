param(
  [string]$Path = "analytics\\trades.log",
  [string]$Symbol,
  [string]$Event,
  [string]$Day
)

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Host "Log file not found: $Path" -ForegroundColor Yellow
  exit 1
}

# Load and parse JSONL
$raw = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 }
$items = @()
foreach ($line in $raw) {
  try {
    $obj = $line | ConvertFrom-Json
    if ($null -ne $obj) { $items += $obj }
  } catch { }
}

if ($Symbol) { $items = $items | Where-Object { $_.symbol -eq $Symbol } }
if ($Event)  { $items = $items | Where-Object { $_.event -eq $Event } }
if ($Day)    { $items = $items | Where-Object { $_.day -eq $Day } }

$withNet = $items | Where-Object { $_.PSObject.Properties.Name -contains 'net' -and $null -ne $_.net }
$wins   = $withNet | Where-Object { [double]$_.net -gt 0 }
$losses = $withNet | Where-Object { [double]$_.net -lt 0 }

$netTotal = ($withNet | Measure-Object -Property net -Sum).Sum
$grossTotal = ($items | Where-Object { $null -ne $_.gross } | Measure-Object -Property gross -Sum).Sum
$feeTotal = ($items | Where-Object { $null -ne $_.fee } | Measure-Object -Property fee -Sum).Sum

$avgWin = 0
if ($wins.Count -gt 0) { $avgWin = ($wins | Measure-Object -Property net -Average).Average }
$avgLoss = 0
if ($losses.Count -gt 0) { $avgLoss = (($losses | ForEach-Object { [math]::Abs([double]$_.net) }) | Measure-Object -Average).Average }

$totalTrades = $wins.Count + $losses.Count
$winRate = 0
if ($totalTrades -gt 0) { $winRate = [double]$wins.Count / [double]$totalTrades }

$profitFactor = 0
if ($avgLoss -gt 0) { $profitFactor = [double]$avgWin / [double]$avgLoss } else { if ($avgWin -gt 0) { $profitFactor = [double]::PositiveInfinity } }
$expectancy = $winRate * $avgWin - (1 - $winRate) * $avgLoss

[PSCustomObject]@{
  Count         = $items.Count
  Trades        = $totalTrades
  Wins          = $wins.Count
  Losses        = $losses.Count
  WinRatePct    = [math]::Round($winRate * 100, 2)
  GrossTotal    = [math]::Round($grossTotal, 2)
  FeeTotal      = [math]::Round($feeTotal, 2)
  NetTotal      = [math]::Round($netTotal, 2)
  AvgWin        = [math]::Round($avgWin, 2)
  AvgLoss       = [math]::Round($avgLoss, 2)
  ProfitFactor  = if ($profitFactor -eq [double]::PositiveInfinity) { 'Inf' } else { [math]::Round($profitFactor, 3) }
  Expectancy    = [math]::Round($expectancy, 2)
} | Format-List
