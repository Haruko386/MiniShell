$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$project = Split-Path -Parent $PSScriptRoot
$source = Join-Path $project 'frontend/assets/icon.jpg'
$appicon = Join-Path $project 'build/appicon.png'
$ico = Join-Path $project 'build/windows/icon.ico'

if (-not (Test-Path -LiteralPath $source)) {
    throw "Icon source not found: $source"
}

$image = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $source))
try {
    # Find the artwork bounds on a small probe image, then crop around it
    # so the icon does not consist mostly of white margin.
    $size = 512
    $probeSize = 128
    $probe = New-Object System.Drawing.Bitmap -ArgumentList $probeSize, $probeSize
    $probeGraphics = [System.Drawing.Graphics]::FromImage($probe)
    try {
        $probeGraphics.DrawImage($image, 0, 0, $probeSize, $probeSize)
    } finally {
        $probeGraphics.Dispose()
    }

    $minX = $probeSize
    $minY = $probeSize
    $maxX = -1
    $maxY = -1
    try {
        for ($y = 0; $y -lt $probeSize; $y++) {
            for ($x = 0; $x -lt $probeSize; $x++) {
                $pixel = $probe.GetPixel($x, $y)
                if ($pixel.R -lt 240 -or $pixel.G -lt 240 -or $pixel.B -lt 240) {
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }
    } finally {
        $probe.Dispose()
    }

    if ($maxX -lt 0 -or $maxY -lt 0) {
        $side = [Math]::Min($image.Width, $image.Height)
        $srcX = [int](($image.Width - $side) / 2)
        $srcY = [int](($image.Height - $side) / 2)
    } else {
        $scaleX = $image.Width / $probeSize
        $scaleY = $image.Height / $probeSize
        $contentLeft = $minX * $scaleX
        $contentTop = $minY * $scaleY
        $contentRight = ($maxX + 1) * $scaleX
        $contentBottom = ($maxY + 1) * $scaleY
        $centerX = ($contentLeft + $contentRight) / 2
        $centerY = ($contentTop + $contentBottom) / 2

        # Roughly 9% padding on every side.
        $side = [int]([Math]::Max($contentRight - $contentLeft, $contentBottom - $contentTop) * 1.18)
        $side = [Math]::Min($side, [Math]::Min($image.Width, $image.Height))
        $srcX = [int]($centerX - $side / 2)
        $srcY = [int]($centerY - $side / 2)
        if ($srcX -lt 0) { $srcX = 0 }
        if ($srcY -lt 0) { $srcY = 0 }
        if (($srcX + $side) -gt $image.Width) { $srcX = $image.Width - $side }
        if (($srcY + $side) -gt $image.Height) { $srcY = $image.Height - $side }
    }

    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $bitmap.SetResolution(96, 96)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.Clear([System.Drawing.Color]::Transparent)

            $destRect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $size, $size
            $srcRect = New-Object System.Drawing.Rectangle -ArgumentList $srcX, $srcY, $side, $side
            $graphics.DrawImage($image, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        } finally {
            $graphics.Dispose()
        }

        $dir = Split-Path -Parent $appicon
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $temp = "$appicon.tmp"
        $bitmap.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
        Move-Item -LiteralPath $temp -Destination $appicon -Force
    } finally {
        $bitmap.Dispose()
    }
} finally {
    $image.Dispose()
}

# Wails only generates icon.ico when it does not exist.
if (Test-Path -LiteralPath $ico) {
    Remove-Item -LiteralPath $ico -Force
}

Write-Host "Generated $appicon from $source"
