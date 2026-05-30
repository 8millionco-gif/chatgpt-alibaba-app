$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $node = (Get-Command node).Source
} elseif (Test-Path $bundledNode) {
  $node = $bundledNode
} else {
  throw "Node.js를 찾을 수 없습니다. Node.js를 설치하거나 Codex bundled runtime을 확인해 주세요."
}

Set-Location $scriptDir
& $node server.js
