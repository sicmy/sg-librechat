param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pinnedCommit = '119875979e26ea0f3be028312e2fe4c0fbe26528'
$repositoryUrl = 'https://github.com/LibreChat-AI/code-interpreter.git'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $repoRoot '.runtime\code-interpreter'
$repositoryPath = Join-Path $runtimeRoot 'repository.git'
$sourcePath = Join-Path $runtimeRoot "source-$($pinnedCommit.Substring(0, 9))-lf"
$secretsPath = Join-Path $runtimeRoot 'runtime.env'
$serviceOverride = Join-Path $repoRoot 'docker-compose.code-interpreter-service.yaml'
$libreChatOverride = Join-Path $repoRoot 'docker-compose.code-interpreter.yaml'
$libreChatEnv = Join-Path $repoRoot '.env'
$compatibilityPatch = Join-Path $repoRoot 'patches\code-interpreter\0001-enable-file-egress-socket.patch'

function New-RandomHex([int]$bytes) {
  $buffer = [byte[]]::new($bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

function Invoke-Checked([string]$command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$command failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $libreChatEnv)) {
  throw 'LibreChat .env is required. The launcher references it without reading or printing it.'
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $repositoryPath)) {
  Invoke-Checked 'git' @('clone', '--bare', '--filter=blob:none', $repositoryUrl, $repositoryPath)
}
Invoke-Checked 'git' @('--git-dir', $repositoryPath, 'fetch', '--prune', 'origin')
Invoke-Checked 'git' @('--git-dir', $repositoryPath, 'config', 'core.autocrlf', 'false')
Invoke-Checked 'git' @('--git-dir', $repositoryPath, 'config', 'core.eol', 'lf')
if (-not (Test-Path -LiteralPath $sourcePath)) {
  $archivePath = Join-Path $runtimeRoot "source-$($pinnedCommit.Substring(0, 9))-lf.zip"
  Invoke-Checked 'git' @(
    '--git-dir', $repositoryPath,
    'archive',
    '--format=zip',
    "--output=$archivePath",
    $pinnedCommit
  )
  New-Item -ItemType Directory -Force -Path $sourcePath | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $sourcePath
  Remove-Item -LiteralPath $archivePath
}
$probePath = 'docker/apt-install.sh'
$expectedProbeHash = & git --git-dir $repositoryPath rev-parse "$($pinnedCommit):$probePath"
$actualProbeHash = & git --git-dir $repositoryPath hash-object --no-filters (Join-Path $sourcePath $probePath)
if ($LASTEXITCODE -ne 0 -or $actualProbeHash -ne $expectedProbeHash) {
  throw 'Exported Code Interpreter source does not match the pinned commit.'
}

$sourceRelative = [IO.Path]::GetRelativePath($repoRoot, $sourcePath).Replace('\', '/')
& git -C $repoRoot apply --check "--directory=$sourceRelative" $compatibilityPatch 2>$null
if ($LASTEXITCODE -eq 0) {
  Invoke-Checked 'git' @('-C', $repoRoot, 'apply', "--directory=$sourceRelative", $compatibilityPatch)
} else {
  $payloadPath = Join-Path $sourcePath 'service\src\payload.ts'
  $payloadSource = [IO.File]::ReadAllText($payloadPath)
  $patchedImport = "import { env, planLimits, languageConfig, resolveLanguage } from './config';"
  $patchedCapability = '...(env.EGRESS_GATEWAY_URL ? { tool_call_socket: true } : {}),'
  if (-not $payloadSource.Contains($patchedImport) -or -not $payloadSource.Contains($patchedCapability)) {
    throw 'Code Interpreter compatibility patch does not match the pinned source.'
  }
}

if (-not (Test-Path -LiteralPath $secretsPath)) {
  $keyMaterialJson = & node -e @'
const { generateKeyPairSync } = require('node:crypto');
const jwt = generateKeyPairSync('ed25519');
const manifest = generateKeyPairSync('ed25519');
const publicJwk = jwt.publicKey.export({ format: 'jwk' });
publicJwk.kid = 'sg-local-codeapi-1';
publicJwk.alg = 'EdDSA';
publicJwk.use = 'sig';
process.stdout.write(JSON.stringify({
  privateJwk: JSON.stringify(jwt.privateKey.export({ format: 'jwk' })),
  jwks: JSON.stringify({ keys: [publicJwk] }),
  manifestPrivate: manifest.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  manifestPublic: manifest.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
}));
'@
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to generate local Code API signing keys.'
  }
  $keyMaterial = $keyMaterialJson | ConvertFrom-Json
  $lines = @(
    "CODEAPI_INTERNAL_SERVICE_TOKEN=$(New-RandomHex 32)",
    "CODEAPI_EGRESS_GRANT_SECRET=$(New-RandomHex 32)",
    "CODEAPI_REDIS_PASSWORD=$(New-RandomHex 24)",
    "CODEAPI_MINIO_ACCESS_KEY=$(New-RandomHex 12)",
    "CODEAPI_MINIO_SECRET_KEY=$(New-RandomHex 32)",
    "CODEAPI_JWT_PRIVATE_JWK_JSON='$($keyMaterial.privateJwk)'",
    "CODEAPI_JWT_JWKS_JSON='$($keyMaterial.jwks)'",
    "CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY=$($keyMaterial.manifestPrivate)",
    "CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY=$($keyMaterial.manifestPublic)"
  )
  [IO.File]::WriteAllLines($secretsPath, $lines, [Text.UTF8Encoding]::new($false))
}

$networkExists = & docker network ls --filter 'name=^sg-code-execution$' --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) {
  throw 'Docker is not available.'
}
if (-not $networkExists) {
  Invoke-Checked 'docker' @('network', 'create', 'sg-code-execution') | Out-Null
}

$codeCompose = @(
  'compose',
  '-p', 'sg-code-interpreter',
  '--env-file', $secretsPath,
  '-f', (Join-Path $sourcePath 'docker-compose.yaml'),
  '-f', $serviceOverride
)
Invoke-Checked 'docker' ($codeCompose + @('up', '-d', '--build'))

$requiredServices = @(
  'api',
  'service-worker',
  'egress_gateway',
  'tool_call_server',
  'sandbox-runner',
  'file_server',
  'redis',
  'minio'
)
$deadline = (Get-Date).AddMinutes(8)
do {
  $notReady = @()
  foreach ($service in $requiredServices) {
    $psArguments = $codeCompose + @('ps', '-q', $service)
    $containerId = & docker @psArguments
    if (-not $containerId) {
      $notReady += $service
      continue
    }
    $state = & docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $containerId
    if ($state -ne 'healthy' -and $state -ne 'running') {
      $notReady += $service
    }
  }
  if ($notReady.Count -eq 0) {
    break
  }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)

if ($notReady.Count -gt 0) {
  throw "Code Interpreter services not ready: $($notReady -join ', ')"
}

$libreChatCompose = @(
  'compose',
  '-p', 'librechat',
  '--env-file', $libreChatEnv,
  '--env-file', $secretsPath,
  '-f', (Join-Path $repoRoot 'docker-compose.yml'),
  '-f', (Join-Path $repoRoot 'docker-compose.override.yaml'),
  '-f', (Join-Path $repoRoot 'docker-compose.sandpack.yaml'),
  '-f', $libreChatOverride
)
Invoke-Checked 'docker' ($libreChatCompose + @('up', '-d', '--no-deps', 'api'))

$libreChatDeadline = (Get-Date).AddMinutes(2)
do {
  try {
    $ready = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5080/readyz' -TimeoutSec 5).StatusCode -eq 200
  } catch {
    $ready = $false
  }
  if ($ready) {
    break
  }
  Start-Sleep -Seconds 3
} while ((Get-Date) -lt $libreChatDeadline)

if (-not $ready) {
  throw 'LibreChat did not become ready after Code Interpreter integration.'
}

Write-Output 'Code Interpreter and LibreChat are ready.'
Write-Output 'Code API: http://127.0.0.1:53112/v1/health'
