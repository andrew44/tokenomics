# tokenomics installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/andrew44/tokenomics/main/install.ps1 | iex
#
# Downloads tokenomics to %USERPROFILE%\.tokenomics\app (no git needed), then sets up whichever
# assistants it finds: the Claude Code / Copilot CLI plugin (skills + hooks), the statusline, and a
# `tokenomics` command. It never replaces a status line you already have. Safe to run again.
#
# tokenomics is TypeScript run directly by Node.js 22.18 or newer (no build step, no npm install).
# No Node.js, or an older one? It downloads a private copy into %USERPROFILE%\.tokenomics\runtime
# (no admin rights, no installer windows, nothing else on your system changes).
#
# Environment: TOKENOMICS_REPO (default andrew44/tokenomics), TOKENOMICS_REF (default main),
#              TOKENOMICS_HOME (default %USERPROFILE%\.tokenomics),
#              TOKENOMICS_NODE (a node.exe to use, or "standalone" to always use a private copy),
#              TOKENOMICS_SETUP_ARGS (e.g. "--no-statusline")

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
    $privateNode = Join-Path $runtime 'node\node.exe'

    function Test-Node([string]$cmd) {
        # Returns the full path of a working Node.js 22.18+, or $null. Every candidate is actually run.
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { return $null }
        # No quotes inside the JavaScript: Windows PowerShell 5.1 strips them from native arguments.
        $js = 'const v=process.versions.node.split(String.fromCharCode(46)).map(Number);console.log(v[0]>22||(v[0]==22&&v[1]>=18)?process.execPath:String())'
        try {
            $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
            $exe = & $cmd -e $js 2>$null | Select-Object -Last 1
        } catch { $exe = $null } finally { $ErrorActionPreference = $old }
        if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        return $null
    }

    function Get-PrivateNode {
        # The official Node.js 24 LTS build from nodejs.org, pinned and checked against its
        # published SHA-256. No API calls, so no rate limits.
        $version = 'v24.22.2'
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
            $plat = 'win-arm64'; $sum = 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'
        } else {
            $plat = 'win-x64';   $sum = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
        }
        $url = "https://nodejs.org/dist/$version/node-$version-$plat.zip"
        Write-Host 'Downloading a private Node.js for tokenomics (one time, about 35 MB)...'
        $zipFile = Join-Path $tmp 'node.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipFile
        if ((Get-FileHash -Algorithm SHA256 $zipFile).Hash.ToLower() -ne $sum) {
            Write-Host "The Node.js download didn't match its checksum; not using it."
            return $null
        }
        if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        Expand-Archive -Path $zipFile -DestinationPath $runtime -Force
        Move-Item (Join-Path $runtime "node-$version-$plat") (Join-Path $runtime 'node')
        return (Test-Node $privateNode)
    }

    function Stop-WithMessage([string]$msg) {
        Write-Host ''
        Write-Host "tokenomics: $msg" -ForegroundColor Red
        throw 'tokenomics-stop'                          # caught below: no stack trace for users
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tokenomics-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp, $tkHome -Force | Out-Null
    try {
        # 1. Node.js 22.18+ (built-in modules only; nothing gets npm-installed)
        $node = $null
        if ($env:TOKENOMICS_NODE -and $env:TOKENOMICS_NODE -ne 'standalone') {
            $node = Test-Node $env:TOKENOMICS_NODE
            if (-not $node) { Stop-WithMessage "TOKENOMICS_NODE=$($env:TOKENOMICS_NODE) isn't a working Node.js 22.18+." }
        } elseif (-not $env:TOKENOMICS_NODE) {
            if (Test-Path $privateNode) { $node = Test-Node $privateNode }   # from an earlier install
            if (-not $node) { $node = Test-Node 'node' }
        }
        if (-not $node) {
            try { $node = Get-PrivateNode } catch { $node = $null }
        }
        if (-not $node) {
            Stop-WithMessage 'tokenomics needs Node.js 22.18 or newer and could not download it. Install it from https://nodejs.org, then run this installer again.'
        }

        # 2. Download tokenomics (a zip, so git isn't needed)
        $url = "https://github.com/$repo/archive/$ref.zip"
        Write-Host "Downloading tokenomics ($repo@$ref)..."
        $zip = Join-Path $tmp 'src.zip'
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip }
        catch { Stop-WithMessage "download failed: $url (check your internet connection and try again)" }
        Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'src') -Force
        $src = Get-ChildItem (Join-Path $tmp 'src') -Directory | Select-Object -First 1
        if (-not (Test-Path (Join-Path $src.FullName 'scripts\cli.ts'))) { Stop-WithMessage "the download doesn't look like tokenomics." }
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

    # 4. Set everything up (plugin, statusline, `tokenomics` command)
    Write-Host ''
    $setupArgs = if ($env:TOKENOMICS_SETUP_ARGS) { $env:TOKENOMICS_SETUP_ARGS -split ' ' } else { @() }
    & $node --disable-warning=ExperimentalWarning (Join-Path $app 'scripts\cli.ts') setup @setupArgs
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
