# tokenomics installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/andrew44/tokenomics/main/install.ps1 | iex
#
# Downloads tokenomics to %USERPROFILE%\.tokenomics\app (no git needed), then sets up whichever
# assistants it finds: the Claude Code / Copilot CLI plugin (skills + hooks), the status bar, and a
# `tokenomics` command. It never replaces a status line you already have. Safe to run again.
#
# No Python? It downloads a private copy into %USERPROFILE%\.tokenomics\runtime (no admin rights,
# no installer windows, nothing else on your system changes).
#
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default %USERPROFILE%\.tokenomics),
#              TOKENOMICS_PYTHON (a python.exe to use, or "standalone" to always use a private copy),
#              TOKENOMICS_SETUP_ARGS (e.g. "--no-statusbar")

& { try {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'           # Invoke-WebRequest is very slow without this
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

    $repo = if ($env:TOKENOMICS_REPO) { $env:TOKENOMICS_REPO } else { 'andrew44/tokenomics' }
    $ref  = if ($env:TOKENOMICS_REF)  { $env:TOKENOMICS_REF }  else { 'main' }
    $tkHome = if ($env:TOKENOMICS_HOME) { $env:TOKENOMICS_HOME } else { Join-Path $HOME '.tokenomics' }
    $app = Join-Path $tkHome 'app'
    $runtime = Join-Path $tkHome 'runtime'
    $privatePy = Join-Path $runtime 'python\python.exe'

    function Test-Python([string[]]$cmd) {
        # Returns the full path of a working Python 3.8+, or $null. The Microsoft Store "python"
        # placeholder exists on PATH but can't run code, so every candidate is actually run.
        if (-not (Get-Command $cmd[0] -ErrorAction SilentlyContinue)) { return $null }
        # No quotes inside the Python code: Windows PowerShell 5.1 strips them from native arguments.
        $pyArgs = @($cmd | Select-Object -Skip 1) + @('-c', 'import sys; print(sys.executable if sys.version_info >= (3, 8) else str())')
        try {
            $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
            $exe = & $cmd[0] @pyArgs 2>$null | Select-Object -Last 1
        } catch { $exe = $null } finally { $ErrorActionPreference = $old }
        if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        return $null
    }

    function Get-PrivatePython {
        # A self-contained CPython build (python-build-standalone, as used by uv).
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
        $rel = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'
        $asset = $rel.assets | Where-Object { $_.name -match "^cpython-3\.12\.\d+\+\d+-$arch-pc-windows-msvc-install_only\.tar\.gz$" } | Select-Object -First 1
        if (-not $asset) { return $null }
        Write-Host 'Downloading a private Python for tokenomics (one time, about 30 MB)...'
        $tgz = Join-Path $tmp 'python.tar.gz'
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $tgz
        if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        & tar.exe -xzf $tgz -C $runtime                # tar.exe ships with Windows 10 (1803) and later
        if ($LASTEXITCODE -ne 0) { return $null }
        return (Test-Python @($privatePy))
    }

    function Stop-WithMessage([string]$msg) {
        Write-Host ''
        Write-Host "tokenomics: $msg" -ForegroundColor Red
        throw 'tokenomics-stop'                          # caught below: no stack trace for users
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tokenomics-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp, $tkHome -Force | Out-Null
    try {
        # 1. Python 3.8+ (standard library only; nothing gets pip-installed)
        $py = $null
        if ($env:TOKENOMICS_PYTHON -and $env:TOKENOMICS_PYTHON -ne 'standalone') {
            $py = Test-Python @($env:TOKENOMICS_PYTHON)
            if (-not $py) { Stop-WithMessage "TOKENOMICS_PYTHON=$($env:TOKENOMICS_PYTHON) isn't a working Python 3.8+." }
        } elseif (-not $env:TOKENOMICS_PYTHON) {
            if (Test-Path $privatePy) { $py = Test-Python @($privatePy) }   # from an earlier install
            foreach ($candidate in 'py -3', 'python', 'python3') {
                if ($py) { break }
                $py = Test-Python ($candidate -split ' ')
            }
        }
        if (-not $py) {
            try { $py = Get-PrivatePython } catch { $py = $null }
        }
        if (-not $py) {
            Stop-WithMessage 'tokenomics needs Python 3.8 or newer and could not download it. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this installer again.'
        }

        # 2. Download tokenomics (a zip, so git isn't needed)
        $url = "https://github.com/$repo/archive/$ref.zip"
        Write-Host "Downloading tokenomics ($repo@$ref)..."
        $zip = Join-Path $tmp 'src.zip'
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip }
        catch { Stop-WithMessage "download failed: $url (check your internet connection and try again)" }
        Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'src') -Force
        $src = Get-ChildItem (Join-Path $tmp 'src') -Directory | Select-Object -First 1
        if (-not (Test-Path (Join-Path $src.FullName 'scripts\cli.py'))) { Stop-WithMessage "the download doesn't look like tokenomics." }
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
    $env:PYTHONIOENCODING = 'utf-8'
    $setupArgs = if ($env:TOKENOMICS_SETUP_ARGS) { $env:TOKENOMICS_SETUP_ARGS -split ' ' } else { @() }
    & $py (Join-Path $app 'scripts\cli.py') setup @setupArgs
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'setup did not finish; see the messages above.' }
} catch {
    # Show a plain message, not a PowerShell stack trace, and leave the window open (iex runs in
    # the user's own session, so `exit` would close their terminal).
    if ("$_" -ne 'tokenomics-stop') {
        Write-Host ''
        Write-Host "tokenomics: something went wrong: $_" -ForegroundColor Red
        Write-Host 'Please try again; if it keeps failing, open an issue at https://github.com/andrew44/tokenomics/issues' -ForegroundColor Red
    }
    $global:LASTEXITCODE = 1
} }
