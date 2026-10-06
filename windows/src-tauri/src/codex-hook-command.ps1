$ErrorActionPreference = 'Stop'
$coucouPayload = [Console]::In.ReadToEnd()
$coucouStart = New-Object System.Diagnostics.ProcessStartInfo
$coucouStart.FileName = '__EXE__'
$coucouStart.Arguments = '__EVENT__ --codex'
$coucouStart.UseShellExecute = $false
$coucouStart.CreateNoWindow = $true
$coucouStart.RedirectStandardInput = $true
$coucouStart.RedirectStandardOutput = $true
$coucouStart.RedirectStandardError = $true
$coucouProcess = New-Object System.Diagnostics.Process
$coucouProcess.StartInfo = $coucouStart
$coucouStarted = $false
try {
    $coucouStarted = $coucouProcess.Start()
    $coucouOutput = $coucouProcess.StandardOutput.ReadToEndAsync()
    $coucouError = $coucouProcess.StandardError.ReadToEndAsync()
    $coucouProcess.StandardInput.Write($coucouPayload)
    $coucouProcess.StandardInput.Close()
    if (-not $coucouProcess.WaitForExit(__TIMEOUT_MS__)) {
        $coucouProcess.Kill()
        $coucouProcess.WaitForExit()
        # Decline to decide; the normal Codex approval flow takes over.
        if ('__EVENT__' -in @('Stop', 'SubagentStop')) { [Console]::Out.Write('{}') }
        exit 0
    }
    [Console]::Out.Write($coucouOutput.GetAwaiter().GetResult())
    [Console]::Error.Write($coucouError.GetAwaiter().GetResult())
    exit $coucouProcess.ExitCode
} finally {
    if ($coucouStarted -and -not $coucouProcess.HasExited) {
        $coucouProcess.Kill()
        $coucouProcess.WaitForExit()
    }
    $coucouProcess.Dispose()
}
