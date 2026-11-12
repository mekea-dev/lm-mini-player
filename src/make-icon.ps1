# LM Mini Player - gera src\app.ico (varios tamanhos, com PNG dentro do .ico).
#
#   powershell -ExecutionPolicy Bypass -File src\make-icon.ps1
#   powershell -ExecutionPolicy Bypass -File src\make-icon.ps1 -PreviewPng C:\temp\icone.png
#
# So precisa do Windows (System.Drawing). O app.ico ja vem pronto no repositorio;
# este script existe para quem quiser mudar o desenho.
param(
    [string]$Out = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'app.ico'),
    [string]$PreviewPng = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return ,$p
}

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $k = $size / 256.0
    $pw = [Math]::Max(9 * $k, 1.2)

    # fundo: quadrado arredondado escuro
    $bg = New-RoundRectPath (6 * $k) (6 * $k) (244 * $k) (244 * $k) (58 * $k)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(0, [single]$size)),
        [System.Drawing.Color]::FromArgb(255, 46, 46, 62), [System.Drawing.Color]::FromArgb(255, 16, 16, 22))
    $g.FillPath($bgBrush, $bg)

    # "tela" vermelha do video
    $scr = New-RoundRectPath (30 * $k) (52 * $k) (196 * $k) (128 * $k) (26 * $k)
    $scrBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, [single](52 * $k))), (New-Object System.Drawing.PointF(0, [single](180 * $k))),
        [System.Drawing.Color]::FromArgb(255, 255, 106, 94), [System.Drawing.Color]::FromArgb(255, 212, 32, 46))
    $g.FillPath($scrBrush, $scr)

    # triangulo de play (branco, pontas arredondadas)
    $tri = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF([single](106 * $k), [single](84 * $k))),
        (New-Object System.Drawing.PointF([single](106 * $k), [single](148 * $k))),
        (New-Object System.Drawing.PointF([single](160 * $k), [single](116 * $k))))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPolygon($white, $tri)
    $penW = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single](10 * $k))
    $penW.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPolygon($penW, $tri)

    # mini janela flutuante (canto inferior direito)
    $pip = New-RoundRectPath (118 * $k) (128 * $k) (118 * $k) (86 * $k) (18 * $k)
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 21, 21, 28))), $pip)
    $penPip = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 123, 112), [single]$pw)
    $penPip.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($penPip, $pip)

    $tri2 = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF([single](166 * $k), [single](154 * $k))),
        (New-Object System.Drawing.PointF([single](166 * $k), [single](188 * $k))),
        (New-Object System.Drawing.PointF([single](194 * $k), [single](171 * $k))))
    $g.FillPolygon($white, $tri2)
    $penW2 = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single](6 * $k))
    $penW2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPolygon($penW2, $tri2)

    $g.Dispose()
    return ,$bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$pngs.Add($ms.ToArray())
    if ($PreviewPng -and $s -eq 256) { $bmp.Save($PreviewPng, [System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp.Dispose()
    $ms.Dispose()
}

$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)               # reservado
$bw.Write([uint16]1)               # tipo: icone
$bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)             # cores na paleta
    $bw.Write([byte]0)             # reservado
    $bw.Write([uint16]1)           # planos
    $bw.Write([uint16]32)          # bits por pixel
    $bw.Write([uint32]$pngs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
for ($i = 0; $i -lt $sizes.Count; $i++) { $bw.Write([byte[]]$pngs[$i]) }
$bw.Close()
$fs.Close()

Write-Host ("Icone gerado: {0} ({1} tamanhos)" -f $Out, $sizes.Count)
