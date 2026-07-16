# Launch an odai canary with a Grok CLI runner and a fixed Codex judge.
# Grok runs with permission prompts bypassed; use only disposable harness
# fixtures. Output defaults to a unique directory and is never overwritten.
#
# Examples:
#   pwsh -File scripts/run-grok-canary.ps1 -Cases "1-12"
#   pwsh -File scripts/run-grok-canary.ps1 -Plan plans/odai-ab-smoke.md -SkillMode off
#   pwsh -File scripts/run-grok-canary.ps1 -PrepareOnly -Plan plans/odai-ab-smoke.md

param(
  [string]$Plan = "plans/odai-canary.md",
  [string]$Cases = "",
  [switch]$Smoke,
  [ValidateSet("on", "off")]
  [string]$SkillMode = "on",
  [string]$OutDir = "",
  [string]$Root = "",
  [int]$Timeout = 900,
  [int]$JudgeTimeout = 600,
  [string]$RunnerModel = "grok-4.5",
  [string]$JudgeModel = "gpt-5.6-sol",
  [string]$JudgeEffort = "high",
  [string]$GrokBin = "",
  [string]$CodexBin = "",
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
} else {
  $Root = [System.IO.Path]::GetFullPath($Root)
}

if ($GrokBin) { $env:ODAI_GROK_COMMAND = $GrokBin }
if ($CodexBin) { $env:ODAI_CODEX_COMMAND = $CodexBin }

$modelSlug = ($RunnerModel -replace '[^A-Za-z0-9._-]', '-').Trim('-')
if (-not $modelSlug) { $modelSlug = "model" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutDir) {
  $OutDir = ".tmp/odai-grok-$modelSlug-$SkillMode-$stamp"
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

$planPath = if ([System.IO.Path]::IsPathRooted($Plan)) {
  [System.IO.Path]::GetFullPath($Plan)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $Root $Plan))
}
$runnerScript = Join-Path $Root "scripts\grok-canary-runner.mjs"
$judgeScript = Join-Path $Root "scripts\codex-canary-judge.mjs"
$harnessScript = Join-Path $Root "scripts\odai-canary-harness.mjs"

$runner = "node `"$runnerScript`" --prompt-file {prompt_file} --cwd {workdir} --last-message {last_message} --model `"$RunnerModel`""
$judge = "node `"$judgeScript`" --cwd {workdir} --schema {schema} --output {judge_output} --model `"$JudgeModel`" --reasoning-effort `"$JudgeEffort`""

$harnessArgs = @(
  $harnessScript,
  "--plan", $planPath,
  "--skill-mode", $SkillMode,
  "--runner-cmd", $runner,
  "--judge-cmd", $judge,
  "--runner-model", $RunnerModel,
  "--runner-reasoning-effort", "inherit",
  "--judge-model", $JudgeModel,
  "--judge-reasoning-effort", $JudgeEffort,
  "--timeout", "$Timeout",
  "--judge-timeout", "$JudgeTimeout",
  "--out", $fullOut
)
if (-not $PrepareOnly) { $harnessArgs += "--run" }
if ($Smoke) { $harnessArgs += "--smoke" }
if ($Cases) { $harnessArgs += @("--cases", $Cases) }

Write-Host "Plan: $planPath"
Write-Host "Runner model: $RunnerModel"
Write-Host "Judge model: $JudgeModel / $JudgeEffort"
Write-Host "Skill mode: $SkillMode"
Write-Host "Mode: $(if ($PrepareOnly) { 'prepare only' } else { 'run' })"
Write-Host "Output: $fullOut"
& node @harnessArgs
exit $LASTEXITCODE
