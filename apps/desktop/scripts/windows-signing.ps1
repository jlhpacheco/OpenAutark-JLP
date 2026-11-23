# Owns: one candidate file's Authenticode sign/verify operation using the configured Azure profile, or (16.11.2026,
# AUTARK_WINDOWS_SIGNING=certum) a certificate in this user's store named by its thumbprint – Certum SimplySign, whose
# key stays on its virtual card; SignTool asks the card, nothing is read or exported here.
# Never: overwrites an invalid existing signature, exports credentials, or changes Windows trust settings.
param(
    [Parameter(Mandatory)][string]$FilePath,
    [ValidateSet('Sign','Verify')][string]$Mode = 'Verify',
    [switch]$OwnPublisher
)
$ErrorActionPreference = 'Stop'
$file = Get-Item -LiteralPath $FilePath
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular candidate file.' }
$before = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
function Has-EmbeddedSignature {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($file.FullName))
    try {
        $reader.BaseStream.Position = 60; $pe = $reader.ReadUInt32()
        $reader.BaseStream.Position = $pe + 24; $kind = $reader.ReadUInt16()
        $extra = if ($kind -eq 0x20b) { 112 } elseif ($kind -eq 0x10b) { 96 } else { throw 'Unsupported PE header.' }
        $reader.BaseStream.Position = $pe + 24 + $extra + 32
        $offset = $reader.ReadUInt32(); $size = $reader.ReadUInt32()
        return $offset -gt 0 -and $size -gt 0
    } finally { $reader.Dispose() }
}
function Verify-EmbeddedSignature {
    param([bool]$RequireTimestamp = $false)
    if (-not $env:AUTARK_SIGNTOOL_PATH) { throw 'Pinned SignTool path is missing.' }
    $arguments = @('verify','/pa','/all','/q')
    if ($RequireTimestamp) { $arguments += '/tw' }
    & $env:AUTARK_SIGNTOOL_PATH @arguments $file.FullName *> $null
    return $LASTEXITCODE -eq 0
}
$embedded = Has-EmbeddedSignature
# A valid local Windows catalog alone is not a portable embedded publisher signature.
if ($embedded -and -not (Verify-EmbeddedSignature)) { throw 'Existing embedded signature is invalid; no untrusted signature is overwritten.' }
$signedHere = $false
if (-not $embedded -and $signature.Status -in @('NotSigned','Valid') -and $Mode -eq 'Sign' -and $env:AUTARK_WINDOWS_SIGNING -eq 'certum') {
    foreach ($key in @('AUTARK_SIGNING_THUMBPRINT','AUTARK_SIGNING_PUBLISHER')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing signing setting: $key" }
    }
    $thumbprint = $env:AUTARK_SIGNING_THUMBPRINT.Trim().ToUpperInvariant()
    if ($thumbprint -notmatch '^[0-9A-F]{40}$') { throw 'Expected the signing certificate SHA-1 thumbprint.' }
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
    if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'The signing certificate is not in the store of this user with its key: is SimplySign Desktop signed in?' }
    $subject = $certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
    if ($subject -cne $env:AUTARK_SIGNING_PUBLISHER) { throw 'Certificate publisher does not match the verified release identity.' }
    if (-not $env:AUTARK_SIGNTOOL_PATH) { throw 'Pinned SignTool path is missing.' }
    & $env:AUTARK_SIGNTOOL_PATH sign /sha1 $thumbprint /fd SHA256 /tr 'http://time.certum.pl' /td SHA256 /q $file.FullName *> $null
    if ($LASTEXITCODE -ne 0) { throw "SignTool could not sign $($file.Name) (exit $LASTEXITCODE)." }
    $signedHere = $true
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $embedded = Has-EmbeddedSignature
} elseif (-not $embedded -and $signature.Status -in @('NotSigned','Valid') -and $Mode -eq 'Sign') {
    foreach ($key in @('AUTARK_SIGNING_ENDPOINT','AUTARK_SIGNING_ACCOUNT','AUTARK_SIGNING_PROFILE','AUTARK_SIGNING_PUBLISHER')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing signing setting: $key" }
    }
    Import-Module TrustedSigning -RequiredVersion 0.5.8 -ErrorAction Stop
    # This runner authenticates with azure/login OIDC; no interactive/password or unrelated cache fallback.
    Invoke-TrustedSigning -Endpoint $env:AUTARK_SIGNING_ENDPOINT -CodeSigningAccountName $env:AUTARK_SIGNING_ACCOUNT `
        -CertificateProfileName $env:AUTARK_SIGNING_PROFILE -Files $file.FullName -FileDigest SHA256 `
        -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256 `
        -ExcludeEnvironmentCredential -ExcludeWorkloadIdentityCredential -ExcludeManagedIdentityCredential `
        -ExcludeSharedTokenCacheCredential -ExcludeVisualStudioCredential -ExcludeVisualStudioCodeCredential `
        -ExcludeAzurePowerShellCredential -ExcludeAzureDeveloperCliCredential -ExcludeInteractiveBrowserCredential *> $null
    $signedHere = $true
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $embedded = Has-EmbeddedSignature
}
if ($signature.Status -ne 'Valid') { throw "Authenticode is $($signature.Status) for $($file.Name); no untrusted signature is overwritten." }
if (-not $embedded -or -not (Verify-EmbeddedSignature)) { throw 'No valid embedded signature; catalog-only trust is insufficient for distribution.' }
$embeddedCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($file.FullName))
$publisher = $embeddedCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
if (($OwnPublisher -or $signedHere) -and $publisher -cne $env:AUTARK_SIGNING_PUBLISHER) { throw 'Certificate publisher does not match the verified release identity.' }
if (($OwnPublisher -or $signedHere) -and -not (Verify-EmbeddedSignature $true)) { throw 'Release signature has no valid timestamped embedded trust chain.' }
$after = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $signedHere -and $before -ne $after) { throw 'A preserved signed dependency changed.' }
[ordered]@{
    file=$file.FullName; status=$signature.Status.ToString(); publisher=$publisher; embeddedVerified=$true
    thumbprint=$embeddedCertificate.Thumbprint; timestamped=($OwnPublisher -or $signedHere -or [bool]$signature.TimeStamperCertificate)
    signedHere=$signedHere; preserved=(-not $signedHere); beforeSha256=$before; sha256=$after
} | ConvertTo-Json -Compress
