# Launch an odai canary with a Kimi Code runner and a fixed Codex judge.
# Each run uses a new timestamped directory so evidence is never overwritten.

param(
  [string]$Plan = "plans/odai-ab-smoke.md",
  [string]$Cases = "1,2,3,4,5,8,11,12",
  [ValidateSet("on", "off")]
  [string]$SkillMode = "on",
  [string]$OutDir = "",
  [string]$Root = "",
  [int]$Timeout = 900,
  [int]$JudgeTimeout = 600,
  [string]$RunnerModel = "kimi-code/k3",
  [string]$JudgeModel = "gpt-5.6-sol",
  [string]$JudgeEffort = "high",
  [string]$KimiBin = "",
  [string]$CodexBin = "",
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
} else {
  $Root = [System.IO.Path]::GetFullPath($Root)
}

if ($KimiBin) { $env:ODAI_KIMI_COMMAND = $KimiBin }
if ($CodexBin) { $env:ODAI_CODEX_COMMAND = $CodexBin }

$modelSlug = ($RunnerModel -replace '[^A-Za-z0-9._-]', '-').Trim('-')
if (-not $modelSlug) { $modelSlug = "model" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutDir) {
  $OutDir = ".tmp/odai-kimi-$modelSlug-$SkillMode-$stamp"
}
$fullOut = if ([System.IO.Path]::IsPathRooted($OutDir)) {
  [System.IO.Path]::GetFullPath($OutDir)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $Root $OutDir))
}

if (Test-Path -LiteralPath $fullOut) {
  $existing = Get-ChildItem -LiteralPath $fullOut -Force | Select-Object -First 1
  if ($existing) {
    throw "Refusing to reuse non-empty output directory: $fullOut"
  }
} else {
  New-Item -ItemType Directory -Path $fullOut | Out-Null
}

$runnerScript = Join-Path $Root "scripts\kimi-canary-runner.mjs"
$judgeScript = Join-Path $Root "scripts\codex-canary-judge.mjs"
$harnessScript = Join-Path $Root "scripts\odai-canary-harness.mjs"
$planPath = if ([System.IO.Path]::IsPathRooted($Plan)) {
  [System.IO.Path]::GetFullPath($Plan)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $Root $Plan))
}

$runner = "node `"$runnerScript`" --prompt-file {prompt_file} --cwd {workdir} --last-message {last_message} --model `"$RunnerModel`""
$judge = "node `"$judgeScript`" --cwd {workdir} --schema {schema} --output {judge_output} --model `"$JudgeModel`" --reasoning-effort `"$JudgeEffort`""

$harnessArgs = @(
  $harnessScript,
  "--plan", $planPath,
  "--skill-mode", $SkillMode,
  "--runner-cmd", $runner,
  "--judge-cmd", $judge,
  "--runner-model", $RunnerModel,
  "--runner-reasoning-effort", "max",
  "--judge-model", $JudgeModel,
  "--judge-reasoning-effort", $JudgeEffort,
  "--timeout", "$Timeout",
  "--judge-timeout", "$JudgeTimeout",
  "--cases", $Cases,
  "--out", $fullOut
)
if (-not $PrepareOnly) {
  $harnessArgs += "--run"
  $harnessArgs += "--defer-judge"
}

Write-Host "Runner model: $RunnerModel / max"
Write-Host "Judge model: $JudgeModel / $JudgeEffort"
Write-Host "Skill mode: $SkillMode"
Write-Host "Mode: $(if ($PrepareOnly) { 'prepare only' } else { 'run with deferred judge' })"
Write-Host "Output: $fullOut"
& node @harnessArgs
exit $LASTEXITCODE
