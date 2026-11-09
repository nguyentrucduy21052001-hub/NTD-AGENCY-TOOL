$dir = $PSScriptRoot
if (-not $dir) { $dir = (Get-Location).Path }

$paths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { $chrome = "chrome.exe" }

$extArg = "--load-extension=" + $dir
$url = "https://nguyentrucduy21052001-hub.github.io/panel.html"

Start-Process -FilePath $chrome -ArgumentList $extArg, $url
