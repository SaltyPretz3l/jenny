'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-browser-cert-'));
}

function writeWindowsCertificate(directory, certificatePath, keyPath) {
  const scriptPath = path.join(directory, 'make-cert.ps1');
  const script = [
    'param([string] $CertificatePath, [string] $KeyPath)',
    '$ErrorActionPreference = "Stop"',
    '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
    'try {',
    '  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(',
    '    "CN=localhost", $rsa,',
    '    [System.Security.Cryptography.HashAlgorithmName]::SHA256,',
    '    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
    '  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
    '  $san.AddDnsName("localhost")',
    '  $san.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))',
    '  $request.CertificateExtensions.Add($san.Build())',
    '  $certificate = $request.CreateSelfSigned(',
    '    [System.DateTimeOffset]::Now.AddMinutes(-5),',
    '    [System.DateTimeOffset]::Now.AddHours(2))',
    '  [System.IO.File]::WriteAllText($CertificatePath, $certificate.ExportCertificatePem())',
    '  [System.IO.File]::WriteAllText($KeyPath, $rsa.ExportPkcs8PrivateKeyPem())',
    '} finally {',
    '  if ($certificate) { $certificate.Dispose() }',
    '  $rsa.Dispose()',
    '}',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o600 });
  try {
    execFileSync('pwsh.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, certificatePath, keyPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function writeUnixCertificate(certificatePath, keyPath) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificatePath,
    '-subj', '/CN=localhost', '-days', '1',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Create a short-lived localhost certificate for the in-process HTTPS proxy.
 * The private key is returned only in memory and all generated files live in
 * one unique temporary directory owned by the returned cleanup function.
 */
function createTestCertificate() {
  const directory = createTemporaryDirectory();
  const certificatePath = path.join(directory, 'localhost-cert.pem');
  const keyPath = path.join(directory, 'localhost-key.pem');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (process.platform === 'win32') writeWindowsCertificate(directory, certificatePath, keyPath);
    else writeUnixCertificate(certificatePath, keyPath);
    const certificate = fs.readFileSync(certificatePath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    if (!certificate.includes('BEGIN CERTIFICATE') || !key.includes('BEGIN PRIVATE KEY')) {
      throw new Error('Generated browser certificate is not PEM encoded.');
    }
    return Object.freeze({ certificate, key, cleanup });
  } catch (error) {
    cleanup();
    throw new Error('Could not create the ephemeral browser test certificate.', { cause: error });
  }
}

module.exports = { createTestCertificate };
