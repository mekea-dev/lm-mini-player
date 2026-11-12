# LM Mini Player - compila o programa (LMMiniPlayer.exe).
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1             # so compila
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Package    # compila e gera o .zip em dist\
#
# Nao precisa instalar nada: usa o compilador C# que ja vem no Windows (.NET Framework 4).
# A unica dependencia externa e a biblioteca oficial da Microsoft "Microsoft.Web.WebView2"
# (pacote do NuGet). Se a pasta lib\ ainda nao tiver os arquivos dela, este script baixa o
# pacote de api.nuget.org, confere a assinatura digital da Microsoft e copia o que precisa.
param(
    [switch]$Package
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$src     = Join-Path $root 'src'
$lib     = Join-Path $root 'lib'
$exe     = Join-Path $root 'LMMiniPlayer.exe'
$csc     = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wv2     = '1.0.4314.35'     # versao do pacote Microsoft.Web.WebView2
$version = '1.4.0'           # versao do programa (igual a AssemblyVersion em src\Program.cs)

if (-not (Test-Path $csc)) { throw "Nao achei o compilador C# em $csc (precisa do .NET Framework 4)." }

function Install-WebView2Lib {
    Write-Host "Baixando Microsoft.Web.WebView2 $wv2 de api.nuget.org ..."
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('lmmp-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $pkg = Join-Path $tmp 'webview2.zip'
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wv2/microsoft.web.webview2.$wv2.nupkg"
        Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $ex = Join-Path $tmp 'x'
        [IO.Compression.ZipFile]::ExtractToDirectory($pkg, $ex)

        New-Item -ItemType Directory -Force -Path $lib | Out-Null
        $map = [ordered]@{
            'lib\net462\Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
            'runtimes\win-x64\native\WebView2Loader.dll' = 'WebView2Loader.dll'
            'LICENSE.txt'                                = 'WebView2-LICENSE.txt'
            'NOTICE.txt'                                 = 'WebView2-NOTICE.txt'
        }
        foreach ($k in $map.Keys) {
            $from = Join-Path $ex $k
            if (-not (Test-Path $from)) { throw "O pacote nao tem o arquivo esperado: $k" }
            Copy-Item $from (Join-Path $lib $map[$k]) -Force
        }

        foreach ($dll in 'Microsoft.Web.WebView2.Core.dll', 'WebView2Loader.dll') {
            $sig = Get-AuthenticodeSignature (Join-Path $lib $dll)
            if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') {
                throw "Assinatura digital da Microsoft nao confere em $dll (status: $($sig.Status))."
            }
        }
        Write-Host 'Assinatura digital da Microsoft conferida.'
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

$coreDll   = Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'
$loaderDll = Join-Path $lib 'WebView2Loader.dll'
if (-not (Test-Path $coreDll) -or -not (Test-Path $loaderDll)) { Install-WebView2Lib }

Write-Host 'Compilando LMMiniPlayer.exe ...'
$cscArgs = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    "/out:$exe",
    "/win32icon:$(Join-Path $src 'app.ico')",
    "/win32manifest:$(Join-Path $src 'app.manifest')",
    "/reference:$coreDll",
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',        # atualizacao automatica: le o .zip
    '/reference:System.Web.Extensions.dll'         # atualizacao automatica: le o JSON do GitHub
)
$cscArgs += @(Get-ChildItem (Join-Path $src '*.cs') | Sort-Object Name | ForEach-Object { $_.FullName })
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw 'A compilacao falhou.' }

# o programa procura as DLLs na mesma pasta do .exe
Copy-Item $coreDll, $loaderDll $root -Force
Write-Host "Pronto: $exe"

if ($Package) {
    $dist  = Join-Path $root 'dist'
    $stage = Join-Path $dist 'LM-Mini-Player'
    $zip   = Join-Path $dist "LM-Mini-Player-v$version-win-x64.zip"
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Remove-Item -Recurse -Force $stage, $zip -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    Copy-Item $exe, $coreDll, $loaderDll $stage
    Copy-Item (Join-Path $root 'web') (Join-Path $stage 'web') -Recurse
    Copy-Item (Join-Path $root 'LICENSE'), (Join-Path $root 'README.md') $stage
    $third = Join-Path $stage 'THIRD-PARTY'
    New-Item -ItemType Directory -Force -Path $third | Out-Null
    Copy-Item (Join-Path $lib 'WebView2-*.txt') $third

    # monta o zip arquivo por arquivo para os nomes internos usarem "/" (o padrao ZIP);
    # CreateFromDirectory do Windows PowerShell 5.1 grava "\" e alguns extratores se confundem
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fs = [IO.File]::Open($zip, [IO.FileMode]::Create)
    $za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem $stage -Recurse -File | ForEach-Object {
            $rel = 'LM-Mini-Player/' + $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $_.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal)
        }
    }
    finally {
        $za.Dispose()
        $fs.Dispose()
    }
    Remove-Item -Recurse -Force $stage

    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
    Write-Host ("Pacote: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
    Write-Host "SHA-256: $hash"
}
