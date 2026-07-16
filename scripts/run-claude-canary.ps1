# Launch an odai canary with a Claude Code runner and a fixed Codex judge.
# Output defaults to a unique timestamped directory. An explicitly supplied
# non-empty directory is rejected so a later run cannot silently overwrite
# evidence from an earlier model or arm.
#
# Examples:
#   pwsh -File scripts/run-claude-canary.ps1 -RunnerModel opus -SkillMode on
#   pwsh -File scripts/run-claude-canary.ps1 -RunnerModel sonnet -SkillMode off
#   pwsh -File scripts/run-claude-canary.ps1 -RunnerModel sonnet -Cases 4
#   pwsh -File scripts/run-claude-canary.ps1 -RunnerModel opus -Plan plans/odai-canary.md -Cases 1-12
#   pwsh -File scripts/run-claude-canary.ps1 -PrepareOnly -Cases 1

param(
  [string]$Plan = "plans/odai-ab-smoke.md",
  [string]$Cases = "1,2,3,4,5,8,11,12",
  [ValidateSet("on", "off")]
  [string]$SkillMode = "on",
  [string]$OutDir = "",
  [string]$Root = "",
  [int]$Timeout = 900,
  [int]$JudgeTimeout = 600,
  [string]$RunnerModel = "sonnet",
  [string]$JudgeModel = "gpt-5.6-sol",
  [string]$JudgeEffort = "high",
  [string]$ClaudeBin = "",
  [string]$CodexBin = "",
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
} else {
  $Root = [System.IO.Path]::GetFullPath($Root)
}

if ($ClaudeBin) { $env:ODAI_CLAUDE_COMMAND = $ClaudeBin }
if ($CodexBin) { $env:ODAI_CODEX_COMMAND = $CodexBin }

$modelSlug = ($RunnerModel -replace '[^A-Za-z0-9._-]', '-').Trim('-')
if (-not $modelSlug) { $modelSlug = "model" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutDir) {
  $OutDir = ".tmp/odai-claude-$modelSlug-$SkillMode-$stamp"
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

$runnerScript = Join-Path $Root "scripts\claude-canary-runner.mjs"
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
  "--runner-reasoning-effort", "inherit",
  "--judge-model", $JudgeModel,
  "--judge-reasoning-effort", $JudgeEffort,
  "--timeout", "$Timeout",
  "--judge-timeout", "$JudgeTimeout",
  "--cases", $Cases,
  "--out", $fullOut
)
if (-not $PrepareOnly) { $harnessArgs += "--run" }

Write-Host "Runner model: $RunnerModel"
Write-Host "Judge model: $JudgeModel / $JudgeEffort"
Write-Host "Skill mode: $SkillMode"
Write-Host "Mode: $(if ($PrepareOnly) { 'prepare only' } else { 'run' })"
Write-Host "Output: $fullOut"
& node @harnessArgs
exit $LASTEXITCODE
