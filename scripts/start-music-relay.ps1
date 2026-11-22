param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9@._-]*$')]
    [string]$SshTarget,

    [Parameter(Mandatory)]
    [ValidatePattern('^/[a-zA-Z0-9._/-]+/relay\.sock$')]
    [string]$RemoteSocket,

    [ValidateRange(1024, 65535)]
    [int]$LocalPort = 33177
)

$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $PSScriptRoot '..\backend\dist\music-sources\relay-worker.js'
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw 'Run npm -w backend run build before starting the music relay.'
}

$remoteDirectory = $RemoteSocket.Substring(0, $RemoteSocket.LastIndexOf('/'))
$prepareSocket = 'umask 077; dir=''__DIR__''; sock=''__SOCK__''; mkdir -p "$dir" && test -O "$dir" && chmod 700 "$dir" || exit 1; if test -e "$sock"; then test -S "$sock" && test -O "$sock" || exit 1; ss -Hxl | grep -Fq -- "$sock" && exit 1; rm -- "$sock" || exit 1; fi'
$prepareSocket = $prepareSocket.Replace('__DIR__', $remoteDirectory).Replace('__SOCK__', $RemoteSocket)
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10')
$forward = "${RemoteSocket}:127.0.0.1:$LocalPort"

$nodeCommand = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$worker = Start-Process -FilePath $nodeCommand -ArgumentList @("`"$workerPath`"", "$LocalPort") -WindowStyle Hidden -PassThru
try {
    if ($worker.WaitForExit(400)) {
        throw "Music relay worker exited with code $($worker.ExitCode)."
    }
    while (-not $worker.HasExited) {
        & ssh @sshOptions -T $SshTarget $prepareSocket
        if ($LASTEXITCODE -eq 0) {
            & ssh @sshOptions -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -R $forward $SshTarget
        }
        Start-Sleep -Seconds 5
    }
    throw "Music relay worker exited with code $($worker.ExitCode)."
} finally {
    if (-not $worker.HasExited) {
        Stop-Process -InputObject $worker
    }
}
