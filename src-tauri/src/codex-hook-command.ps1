$ErrorActionPreference = 'Stop'
$koukouPayload = [Console]::In.ReadToEnd()
$koukouStart = New-Object System.Diagnostics.ProcessStartInfo
$koukouStart.FileName = '__EXE__'
$koukouStart.Arguments = '__EVENT__ --codex'
$koukouStart.UseShellExecute = $false
$koukouStart.CreateNoWindow = $true
$koukouStart.RedirectStandardInput = $true
$koukouStart.RedirectStandardOutput = $true
$koukouStart.RedirectStandardError = $true
$koukouProcess = New-Object System.Diagnostics.Process
$koukouProcess.StartInfo = $koukouStart
$koukouStarted = $false
try {
    $koukouStarted = $koukouProcess.Start()
    $koukouOutput = $koukouProcess.StandardOutput.ReadToEndAsync()
    $koukouError = $koukouProcess.StandardError.ReadToEndAsync()
    $koukouProcess.StandardInput.Write($koukouPayload)
    $koukouProcess.StandardInput.Close()
    if (-not $koukouProcess.WaitForExit(__TIMEOUT_MS__)) {
        $koukouProcess.Kill()
        $koukouProcess.WaitForExit()
        # Decline to decide; the normal Codex approval flow takes over.
        if ('__EVENT__' -in @('Stop', 'SubagentStop')) { [Console]::Out.Write('{}') }
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
