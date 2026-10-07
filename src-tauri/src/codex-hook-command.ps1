param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop', 'Interrupt')]
    [string]$Event
)

$ErrorActionPreference = 'Stop'
$koukouUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $koukouUtf8
[Console]::OutputEncoding = $koukouUtf8
$koukouExe = Join-Path $PSScriptRoot 'koukou-hook.exe'
if (-not (Test-Path -LiteralPath $koukouExe -PathType Leaf)) {
    if ($Event -in @('Stop', 'SubagentStop')) { [Console]::Out.Write('{}') }
    exit 0
}
$koukouTimeout = if ($Event -eq 'PermissionRequest') { 110000 } else { 2000 }
$koukouPayload = [Console]::In.ReadToEnd()
$koukouStart = New-Object System.Diagnostics.ProcessStartInfo
$koukouStart.FileName = $koukouExe
$koukouStart.Arguments = "$Event --codex"
$koukouStart.UseShellExecute = $false
$koukouStart.CreateNoWindow = $true
$koukouStart.RedirectStandardInput = $true
$koukouStart.RedirectStandardOutput = $true
$koukouStart.RedirectStandardError = $true
$koukouStart.StandardOutputEncoding = $koukouUtf8
$koukouStart.StandardErrorEncoding = $koukouUtf8
$koukouProcess = New-Object System.Diagnostics.Process
$koukouProcess.StartInfo = $koukouStart
$koukouStarted = $false
try {
    $koukouStarted = $koukouProcess.Start()
    $koukouOutput = $koukouProcess.StandardOutput.ReadToEndAsync()
    $koukouError = $koukouProcess.StandardError.ReadToEndAsync()
    # Windows PowerShell 5.1 lacks ProcessStartInfo.StandardInputEncoding.
    # Write UTF-8 bytes directly so Thai and other Unicode payloads survive.
    $koukouBytes = $koukouUtf8.GetBytes($koukouPayload)
    $koukouProcess.StandardInput.BaseStream.Write($koukouBytes, 0, $koukouBytes.Length)
    $koukouProcess.StandardInput.Close()
    if (-not $koukouProcess.WaitForExit($koukouTimeout)) {
        $koukouProcess.Kill()
        $koukouProcess.WaitForExit()
        # Decline to decide; the normal Codex approval flow takes over.
        if ($Event -in @('Stop', 'SubagentStop')) { [Console]::Out.Write('{}') }
        exit 0
    }
    [Console]::Out.Write($koukouOutput.GetAwaiter().GetResult())
    [Console]::Error.Write($koukouError.GetAwaiter().GetResult())
    exit $koukouProcess.ExitCode
} finally {
    if ($koukouStarted -and -not $koukouProcess.HasExited) {
        $koukouProcess.Kill()
        $koukouProcess.WaitForExit()
    }
    $koukouProcess.Dispose()
}
