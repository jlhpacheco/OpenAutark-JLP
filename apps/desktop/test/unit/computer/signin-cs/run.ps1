# Compiles resources/broker/SignIn.cs with SignInTests.cs in memory (CodeDom, the csc of .NET Framework 4.x – the way
# windows-helper.ps1 loads its C#) and runs the tests in this PowerShell process: no new exe is started, so Smart App
# Control / the virus scanner cannot hold an unsigned test exe. Exit code: 0 all pass, 1 a case failed, 2 compile error.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..')
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateInMemory = $true
$parameters.CompilerOptions = '/unsafe'
foreach ($file in @('System.dll', 'System.Core.dll', 'WPF\UIAutomationClient.dll', 'WPF\UIAutomationTypes.dll', 'WPF\WindowsBase.dll')) {
  [void]$parameters.ReferencedAssemblies.Add((Join-Path $framework $file))
}
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$result = $provider.CompileAssemblyFromFile($parameters, [string[]]@((Join-Path $root 'resources\broker\SignIn.cs'), (Join-Path $here 'SignInTests.cs')))
if ($result.Errors.HasErrors) { $result.Errors | ForEach-Object { Write-Output $_.ToString() }; exit 2 }
$code = $result.CompiledAssembly.GetType('AutarkBroker.SignInTests').GetMethod('Main').Invoke($null, @())
exit $code
