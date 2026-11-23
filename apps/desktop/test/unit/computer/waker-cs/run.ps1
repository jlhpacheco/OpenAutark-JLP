# Compiles resources/broker/Waker.cs with WakerTests.cs and the Json class cut out of resources/computer/windows-helper.ps1 (the
# way build.ps1 cuts it) in memory (CodeDom, the csc of .NET Framework 4.x) and runs the tests in this PowerShell process: no new
# exe is started. Exit code: 0 all pass, 1 a case failed, 2 compile error.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..')
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$text = [IO.File]::ReadAllText((Join-Path $root 'resources\computer\windows-helper.ps1'))
$start = $text.IndexOf("`$source = @'")
$end = $text.IndexOf("`n'@", $start)
if ($start -lt 0 -or $end -lt 0) { exit 2 }
$body = $text.Substring($start, $end - $start)
$body = $body.Substring($body.IndexOf("`n") + 1)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('autark-waker-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $helperCs = Join-Path $tmp 'Helper.cs'
  [IO.File]::WriteAllText($helperCs, $body, (New-Object Text.UTF8Encoding($false)))
  $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
  $parameters.GenerateInMemory = $true
  $parameters.CompilerOptions = '/unsafe'
  foreach ($file in @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'WPF\UIAutomationClient.dll', 'WPF\UIAutomationTypes.dll', 'WPF\WindowsBase.dll')) {
    [void]$parameters.ReferencedAssemblies.Add((Join-Path $framework $file))
  }
  $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
  $result = $provider.CompileAssemblyFromFile($parameters, [string[]]@((Join-Path $root 'resources\broker\Waker.cs'), (Join-Path $here 'WakerTests.cs'), $helperCs))
  if ($result.Errors.HasErrors) { $result.Errors | ForEach-Object { Write-Output $_.ToString() }; exit 2 }
  $code = $result.CompiledAssembly.GetType('AutarkBroker.WakerTests').GetMethod('Main').Invoke($null, @())
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
exit $code
