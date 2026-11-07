# Renders the PNG app icons used by the manifest and iOS home screen.
# Requires Windows PowerShell 5.1+ (System.Drawing). Run from the project root:
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Icon {
  param([int]$Size, [string]$File, [bool]$Maskable = $false, [bool]$Rounded = $true)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Background
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($Size, $Size)),
    [System.Drawing.ColorTranslator]::FromHtml('#176b4d'),
    [System.Drawing.ColorTranslator]::FromHtml('#0b2e22'))
  if ($Maskable) {
    $g.FillRectangle($bg, 0, 0, $Size, $Size)
  } elseif ($Rounded) {
    $r = [Math]::Max(1, [int]($Size * 0.2265))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)
  } else {
    $g.FillRectangle($bg, 0, 0, $Size, $Size)
  }

  # Shield (slightly smaller for maskable safe zone)
  $inset = if ($Maskable) { 0.17 } else { 0.10 }
  $s = $Size * (1 - 2 * $inset)
  $ox = $Size * $inset
  $oy = $Size * $inset

  $shield = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = @(
    (New-Object System.Drawing.PointF(($ox + $s * 0.5), ($oy + $s * 0.06))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.94), ($oy + $s * 0.24))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.94), ($oy + $s * 0.55))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.86), ($oy + $s * 0.70))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.50), ($oy + $s * 0.96))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.14), ($oy + $s * 0.70))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.06), ($oy + $s * 0.55))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.06), ($oy + $s * 0.24)))
  )
  $shield.AddPolygon($pts)
  $shield.CloseFigure()

  $white = [System.Drawing.ColorTranslator]::FromHtml('#eaf5ee')
  $stroke = New-Object System.Drawing.Pen($white, ($s * 0.075))
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($stroke, $shield)

  # Check mark
  $gold = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#e9c46a'), ($s * 0.095))
  $gold.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $gold.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $gold.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLines($gold, @(
    (New-Object System.Drawing.PointF(($ox + $s * 0.28), ($oy + $s * 0.52))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.44), ($oy + $s * 0.66))),
    (New-Object System.Drawing.PointF(($ox + $s * 0.73), ($oy + $s * 0.36)))
  ))

  $bmp.Save((Join-Path $outDir $File), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $shield.Dispose(); $stroke.Dispose(); $gold.Dispose(); $bg.Dispose()
}

New-Icon -Size 192 -File 'icon-192.png'
New-Icon -Size 512 -File 'icon-512.png'
New-Icon -Size 512 -File 'icon-maskable-512.png' -Maskable $true
New-Icon -Size 180 -File 'apple-touch-icon.png' -Rounded $false

Write-Host "Icons written to $outDir"
