param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$smokeScript = Join-Path $repoRoot 'scripts\code-interpreter-smoke.mjs'
$container = & docker ps --filter 'name=^/LibreChat$' --format '{{.Names}}'
if ($LASTEXITCODE -ne 0 -or $container -ne 'LibreChat') {
  throw 'LibreChat container is not running.'
}

Get-Content -LiteralPath $smokeScript -Raw |
  docker exec -i LibreChat node --input-type=module -
if ($LASTEXITCODE -ne 0) {
  throw 'Code Interpreter smoke test failed.'
}
