# tokenomics installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/andrew44/tokenomics/main/install.ps1 | iex
#
# Downloads tokenomics to %USERPROFILE%\.tokenomics\app (no git needed), installs Python with
# winget if it's missing, then sets up whichever assistants it finds: the Claude Code / Copilot CLI
# plugin (skills + hooks), the status bar, and a `tokenomics` command. It never replaces a status
# line you already have. Safe to run again to repair.
#
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default %USERPROFILE%\.tokenomics), TOKENOMICS_SETUP_ARGS
#              (e.g. "--no-statusbar")

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $repo = if ($env:TOKENOMICS_REPO) { $env:TOKENOMICS_REPO } else { 'andrew44/tokenomics' }
    $ref  = if ($env:TOKENOMICS_REF)  { $env:TOKENOMICS_REF }  else { 'main' }
    $tkHome = if ($env:TOKENOMICS_HOME) { $env:TOKENOMICS_HOME } else { Join-Path $HOME '.tokenomics' }
    $app = Join-Path $tkHome 'app'

    function Find-Python {
        # The Microsoft Store "python" stub exists but can't run code, so test each candidate.
        foreach ($candidate in 'py -3', 'python', 'python3') {
            $c = $candidate -split ' '
            if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
            $pyArgs = @($c | Select-Object -Skip 1) + @('-c', 'import sys; print(sys.executable if sys.version_info >= (3, 8) else "")')
            try { $exe = (& $c[0] @pyArgs 2>$null | Select-Object -Last 1) } catch { $exe = $null }
            if ($exe -and (Test-Path $exe)) { return $exe.Trim() }
        }
        return $null
    }

    function Refresh-Path {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
    }

    # 1. Python 3.8+ (standard library only)
    $py = Find-Python
    if (-not $py) {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host 'Python 3.8+ is needed; installing it with winget...'
            winget install --exact --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host
            Refresh-Path
            $py = Find-Python
        }
        if (-not $py) {
            throw 'Python 3.8 or newer is needed. Get it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this installer again.'
        }
    }

    # 2. Download (a zip, so git isn't needed)
    $url = "https://github.com/$repo/archive/$ref.zip"
    Write-Host "Downloading tokenomics ($repo@$ref)..."
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tokenomics-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp, $tkHome -Force | Out-Null
    try {
        $zip = Join-Path $tmp 'src.zip'
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'src') -Force
        $src = Get-ChildItem (Join-Path $tmp 'src') -Directory | Select-Object -First 1
        if (-not (Test-Path (Join-Path $src.FullName 'scripts\cli.py'))) { throw "The download doesn't look like tokenomics." }
        if (Test-Path $app) { Remove-Item $app -Recurse -Force }
        Move-Item $src.FullName $app
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # 3. Put the `tokenomics` command on PATH (for new terminals and this one)
    $bin = Join-Path $tkHome 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $bin)) {
        [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'User')
    }
    if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

    # 4. Set everything up (plugin, status bar, `tokenomics` command)
    Write-Host ''
    $setupArgs = if ($env:TOKENOMICS_SETUP_ARGS) { $env:TOKENOMICS_SETUP_ARGS -split ' ' } else { @() }
    & $py (Join-Path $app 'scripts\cli.py') setup @setupArgs
}
