param([string]$Cache = '', [int]$Jobs = 8)
$ErrorActionPreference = 'Stop'
$renderPreviousGoos = $env:GOOS
$renderPreviousGoarch = $env:GOARCH
$renderPreviousCgo = $env:CGO_ENABLED
$renderBuildLocation = Get-Location
try {
    Set-Location -LiteralPath $PSScriptRoot
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '1'
    $renderBuildArguments = @('run', './cmd/buildnative', '-jobs', "$Jobs")
    if ($Cache) { $renderBuildArguments += @('-cache', $Cache) }
    & go @renderBuildArguments
    if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
} finally {
    $env:GOOS = $renderPreviousGoos
    $env:GOARCH = $renderPreviousGoarch
    $env:CGO_ENABLED = $renderPreviousCgo
    Set-Location -LiteralPath $renderBuildLocation
}
