# Runs only on disposable GitHub-hosted Windows runners. Never deletes user profiles.
[CmdletBinding()]
param([string]$CompilerPath = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$package = Get-Content package.json -Raw | ConvertFrom-Json
$version = $package.version
$packageDirectory = Join-Path $repo 'release/Cinema Bar-win32-x64'
$releaseDirectory = Join-Path $repo 'release/windows-release'
$evidenceDirectory = Join-Path $repo 'release/windows-evidence'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs/Cinema Bar'
$installedExecutable = Join-Path $installDirectory 'Cinema Bar.exe'
$profileDirectory = Join-Path $env:APPDATA 'Cinema Bar'
$stateFile = Join-Path $profileDirectory 'state.json'
$sentinelFile = Join-Path $profileDirectory 'installer-preservation-sentinel.txt'
$setup = Join-Path $releaseDirectory "Cinema-Bar-$version-Windows-x64-Setup.exe"
$zip = Join-Path $releaseDirectory "Cinema-Bar-$version-Windows-x64.zip"
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\dev.cinemabar.desktop_is1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Cinema Bar.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cinema Bar.lnk')
)
$assertions = [Collections.Generic.List[object]]::new()
$result = [ordered]@{
    schemaVersion = 1
    startedAt = [DateTime]::UtcNow.ToString('o')
    finishedAt = $null
    passed = $false
    error = $null
    source = $null
    environment = $null
    releaseVersion = $version
    setupHash = $null
    zipHash = $null
    packageASARHash = $null
    installedASARHash = $null
    paths = [ordered]@{
        packageDirectory = $packageDirectory; setup = $setup; zip = $zip
        installDirectory = $installDirectory; installedExecutable = $installedExecutable
        profileDirectory = $profileDirectory
    }
    assertions = $assertions
    payload = [ordered]@{ package = @(); installed = @() }
    normalLaunch = $null
    profileHashes = [ordered]@{}
    smoke = $null
    cleanup = @()
}
$hasOwnership = $false
$initialRunNames = @()
$smokeEnvironment = @{}
New-Item -ItemType Directory -Force $evidenceDirectory | Out-Null

function Assert-Check([string]$Name, [bool]$Passed, $Details) {
    $assertions.Add([ordered]@{ name = $Name; passed = $Passed; details = $Details })
    Write-Host "$Name : $Passed"
    if (!$Passed) { throw "Assertion failed: $Name" }
}
function Get-Hash([string]$File) {
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-Manifest([string]$Directory, [switch]$Installed) {
    return @(Get-ChildItem -LiteralPath $Directory -File -Recurse | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($Directory, $_.FullName).Replace('\', '/')
        if (!$Installed -or $relative -notmatch '^unins\d+\.(exe|dat|msg)$') {
            [ordered]@{ path = $relative; hash = Get-Hash $_.FullName }
        }
    } | Sort-Object { $_.path })
}
function Test-Manifest($Expected, $Actual) {
    return ($Expected.Count -eq $Actual.Count -and
        (($Expected | ConvertTo-Json -Depth 5 -Compress) -ceq
         ($Actual | ConvertTo-Json -Depth 5 -Compress)))
}
function Invoke-Installer([string]$Executable, [string[]]$Arguments, [string]$Name) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru
    if (!$process.WaitForExit(120000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "$Name timed out"
    }
    Assert-Check "$Name-exit" ($process.ExitCode -eq 0) @{ exitCode = $process.ExitCode }
}
function Assert-Payload([string]$Phase) {
    $manifest = Get-Manifest $installDirectory -Installed
    Assert-Check "$Phase-payload" (Test-Manifest $result.payload.package $manifest) @{
        packageFiles = $result.payload.package.Count; installedFiles = $manifest.Count
    }
    $result.payload.installed = $manifest
    $result.installedASARHash = Get-Hash (Join-Path $installDirectory 'resources/app.asar')
}
function Assert-Shortcuts([string]$Phase) {
    $shell = New-Object -ComObject WScript.Shell
    $observed = @($shortcuts | ForEach-Object {
        if (!(Test-Path -LiteralPath $_)) { return [ordered]@{ path = $_; target = $null } }
        [ordered]@{ path = $_; target = $shell.CreateShortcut($_).TargetPath }
    })
    Assert-Check "$Phase-shortcuts" (@($observed | Where-Object {
        $_.target -ine $installedExecutable
    }).Count -eq 0) $observed
}
function Assert-Registration([string]$Phase) {
    $key = Get-ItemProperty -LiteralPath "HKCU:\$uninstallKey"
    $valid = $key.DisplayName -eq 'Cinema Bar' -and $key.DisplayVersion -eq $version -and
        $key.InstallLocation.TrimEnd('\') -ieq $installDirectory.TrimEnd('\') -and
        $key.UninstallString.Contains($installDirectory) -and
        !(Test-Path -LiteralPath "HKLM:\$uninstallKey") -and
        !(Test-Path -LiteralPath 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\dev.cinemabar.desktop_is1')
    Assert-Check "$Phase-registration" $valid @{
        hive = 'HKCU'; key = $uninstallKey; displayName = $key.DisplayName
        version = $key.DisplayVersion; installLocation = $key.InstallLocation
        uninstallString = $key.UninstallString
    }
}
function Get-ProfileHashes {
    return [ordered]@{ state = Get-Hash $stateFile; sentinel = Get-Hash $sentinelFile }
}
function Stop-OwnedProcesses {
    if (!$hasOwnership) { return }
    $owned = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath -ieq $installedExecutable
    })
    foreach ($process in $owned) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $remaining = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath -ieq $installedExecutable
        })
        if (!$remaining.Count) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'Owned app processes did not exit'
}

try {
    Assert-Check 'ephemeral-windows-runner' (
        $IsWindows -and $env:GITHUB_ACTIONS -eq 'true' -and
        $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows'
    ) @{ runnerOS = $env:RUNNER_OS; runnerEnvironment = $env:RUNNER_ENVIRONMENT }
    $os = Get-CimInstance Win32_OperatingSystem
    $result.source = [ordered]@{
        commit = (git rev-parse HEAD).Trim()
        tree = (git rev-parse 'HEAD^{tree}').Trim()
        clean = @(git status --porcelain).Count -eq 0
    }
    $result.environment = [ordered]@{
        os = $os.Caption; osVersion = $os.Version; osArchitecture = $os.OSArchitecture
        nodeArchitecture = (& node -p process.arch).Trim()
        node = (& node --version).Trim()
        electron = (Get-Content node_modules/electron/package.json -Raw | ConvertFrom-Json).version
        electronExecutableVersion = (Get-Item (Join-Path $packageDirectory 'Cinema Bar.exe')).VersionInfo.FileVersion
        inno = (Get-Item -LiteralPath $CompilerPath).VersionInfo.ProductVersion
        runnerImage = $env:ImageOS; runnerImageVersion = $env:ImageVersion
    }
    Assert-Check 'source-clean' $result.source.clean $result.source
    if (Test-Path -LiteralPath $runKey) {
        $initialRunNames = @((Get-Item -LiteralPath $runKey).GetValueNames())
    }
    $occupied = @($installDirectory, $profileDirectory, $shortcuts[0], $shortcuts[1],
        "HKCU:\$uninstallKey", "HKLM:\$uninstallKey",
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\dev.cinemabar.desktop_is1'
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $existingStartup = @($initialRunNames | Where-Object {
        [string](Get-Item -LiteralPath $runKey).GetValue($_) -match [regex]::Escape($installedExecutable)
    })
    Assert-Check 'fresh-environment' (@($occupied).Count -eq 0 -and $existingStartup.Count -eq 0) @{
        occupied = @($occupied); existingStartupNames = $existingStartup
    }
    $hasOwnership = $true
    $exeBytes = [IO.File]::ReadAllBytes((Join-Path $packageDirectory 'Cinema Bar.exe'))
    $peOffset = [BitConverter]::ToInt32($exeBytes, 0x3c)
    $machine = [BitConverter]::ToUInt16($exeBytes, $peOffset + 4)
    Assert-Check 'package-x64-pe' (
        $result.environment.nodeArchitecture -eq 'x64' -and $exeBytes[0] -eq 0x4d -and
        $exeBytes[1] -eq 0x5a -and [BitConverter]::ToUInt32($exeBytes, $peOffset) -eq 0x4550 -and
        $machine -eq 0x8664
    ) @{ machine = $machine; nodeArchitecture = $result.environment.nodeArchitecture }
    $result.setupHash = Get-Hash $setup
    $result.packageASARHash = Get-Hash (Join-Path $packageDirectory 'resources/app.asar')
    $result.payload.package = Get-Manifest $packageDirectory
    $installArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
        '/TASKS=desktopicon', ('/DIR="{0}"' -f $installDirectory))
    Invoke-Installer $setup ($installArguments + ('/LOG="{0}"' -f (Join-Path $evidenceDirectory 'install.log'))) 'install'
    Assert-Payload 'install'
    Assert-Shortcuts 'install'
    Assert-Registration 'install'

    # Use a normal launch with the canonical, previously absent profile and no smoke switches.
    foreach ($entry in @(Get-ChildItem Env: | Where-Object {
        $_.Name -like 'CINEMA_SMOKE*' -or $_.Name -in @('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS')
    })) {
        $smokeEnvironment[$entry.Name] = $entry.Value
        Remove-Item "Env:$($entry.Name)"
    }
    $normal = Start-Process -FilePath $installedExecutable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $renderers = @()
    $isReady = $false
    do {
        Start-Sleep -Milliseconds 300
        $normal.Refresh()
        if ($normal.HasExited) { break }
        $renderers = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ParentProcessId -eq $normal.Id -and $_.CommandLine -like '*--type=renderer*' -and
            $_.ExecutablePath -ieq $installedExecutable
        })
        $isReady = (Test-Path -LiteralPath $stateFile) -and $normal.MainWindowHandle -ne 0 -and
            $normal.MainWindowTitle -like '*Cinema Bar*' -and $renderers.Count -gt 0
    } until ($isReady -or [DateTime]::UtcNow -ge $deadline)
    $actualProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($normal.Id)"
    $result.normalLaunch = [ordered]@{
        pid = $normal.Id; executable = $actualProcess.ExecutablePath
        windowHandle = $normal.MainWindowHandle.ToInt64(); windowTitle = $normal.MainWindowTitle
        rendererPids = @($renderers | ForEach-Object { $_.ProcessId }); profileDirectory = $profileDirectory
        smokeEnvironmentCleared = $true
    }
    Assert-Check 'normal-launch' (
        !$normal.HasExited -and $isReady -and $actualProcess.ExecutablePath -ieq $installedExecutable
    ) $result.normalLaunch
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $secretProperties = @($state.secret.PSObject.Properties.Name)
    Assert-Check 'normal-empty-profile' (
        $state.schemaVersion -eq 2 -and $state.rules.Count -eq 0 -and $state.history.Count -eq 0 -and
        $state.outbox.Count -eq 0 -and $state.localOutbox.Count -eq 0 -and
        $state.secret.revision -eq 0 -and !$state.secret.isTerminal -and
        $secretProperties.Count -eq 2 -and $secretProperties -contains 'revision' -and
        $secretProperties -contains 'isTerminal'
    ) $state
    $state | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $evidenceDirectory 'normal-state.json')
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save((Join-Path $evidenceDirectory 'normal-desktop.png'))
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Stop-OwnedProcesses
    # A non-default setting ensures retention covers customized state as well as a sentinel.
    $retainedState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $retainedState.settings.intervalSeconds = 180
    $retainedState | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $stateFile -Encoding utf8NoBOM
    [IO.File]::WriteAllText($sentinelFile, 'Cinema Bar installer preservation fixture v1')
    $result.profileHashes.beforeReinstall = Get-ProfileHashes

    $env:CINEMA_SMOKE_EXECUTABLE = $installedExecutable
    $env:CINEMA_SMOKE_OUTPUT = Join-Path $evidenceDirectory 'smoke'
    & node scripts/desktopSmoke.mjs 2>&1 | Tee-Object (Join-Path $evidenceDirectory 'desktop-smoke.log')
    $smokeExit = $LASTEXITCODE
    Assert-Check 'installed-smoke' ($smokeExit -eq 0) @{ exitCode = $smokeExit }
    $smoke = Get-Content (Join-Path $env:CINEMA_SMOKE_OUTPUT 'desktop-smoke.json') -Raw | ConvertFrom-Json
    $primary = Get-Content (Join-Path $env:CINEMA_SMOKE_OUTPUT 'smoke-primary-identity.json') -Raw | ConvertFrom-Json
    $secondary = Get-Content (Join-Path $env:CINEMA_SMOKE_OUTPUT 'smoke-secondary-identity.json') -Raw | ConvertFrom-Json
    $result.smoke = [ordered]@{
        actionCount = $smoke.actions.Count; excludedMacActionNames = @(
            'synthetic-valid-tray-clears-warning-and-hides-dock',
            'synthetic-invalid-tray-publishes-warning-and-shows-dock',
            'synthetic-valid-tray-restores-hidden-dock',
            'synthetic-external-dock-show-observed',
            'stable-tray-new-dock-show-settles-hidden',
            'stable-tray-reconciles-new-dock-show-once',
            'native-dock-policy-restored-after-fixture'
        ); primary = $primary; secondary = $secondary
    }
    Assert-Check 'smoke-identities' (
        $smoke.passed -and $smoke.isPackaged -and $smoke.platform -eq 'win32' -and
        $primary.executable -ieq $installedExecutable -and $secondary.executable -ieq $installedExecutable -and
        $primary.isolatedUserData -eq $secondary.isolatedUserData -and
        $primary.isolatedUserData -ne $profileDirectory -and
        $primary.hasLock -and !$secondary.hasLock -and
        $primary.codec -eq 'in-memory' -and $secondary.codec -eq 'in-memory' -and
        $primary.realSafeStorageCalls -eq 0 -and $secondary.realSafeStorageCalls -eq 0 -and
        $smoke.realSafeStorageCalls -eq 0 -and $smoke.realDiscordSends -eq 0 -and
        $smoke.realLoginWrites -eq 0 -and $smoke.mockProviders -and $smoke.mockDiscord
    ) $result.smoke
    # Exact shared action set: frozen macOS 107-check baseline minus the seven Dock-only fixtures.
    $expectedActions = @(
        'primary-smoke-identity-isolated',
        'smoke-memory-codec-roundtrip',
        'actual-renderer-mounted',
        'header-native-drag-css-boundary',
        'sandbox-contextIsolation-nodeIntegration',
        'renderer-narrow-api',
        'reduced-motion-disables-decoration',
        'tab-감시 목록',
        'tab-알림 기록',
        'tab-설정',
        'tab-대시보드',
        'keyboard-tab-arrow',
        'form-controls-excluded-from-native-drag',
        'catalog-no-manual-theater-inputs',
        'earliest-button-click-selected',
        'earliest-button-keyboard-does-not-submit',
        'ui-rule-form-save',
        'earliest-button-save-disk-reload',
        'earliest-button-edit-persisted',
        'mock-poster-real-raster-decode-and-banner',
        'poster-natural-ratio-440-portrait',
        'poster-controls-reachable-440-portrait',
        'poster-natural-ratio-440-square',
        'poster-controls-reachable-440-square',
        'poster-natural-ratio-440-landscape',
        'poster-controls-reachable-440-landscape',
        'poster-natural-ratio-340-portrait',
        'poster-controls-reachable-340-portrait',
        'poster-natural-ratio-340-square',
        'poster-controls-reachable-340-square',
        'poster-natural-ratio-340-landscape',
        'poster-controls-reachable-340-landscape',
        'poster-decode-error-restores-70px-ticket-fallback',
        'poster-recovers-after-decode-error-remount',
        'poster-ipc-rejects-arbitrary-url',
        'renderer-csp-retains-image-and-network-boundary',
        'native-keepawake-default-off',
        'native-prevent-app-suspension-start',
        'native-blocker-released-on-pause',
        'native-blocker-resumes-for-active-rule',
        'native-blocker-released-on-suspend',
        'native-blocker-explicit-optout',
        'catalog-input-rejection',
        'invalid-ipc-rejected',
        'external-url-rejected',
        'mock-login-enabled-roundtrip',
        'mock-login-optout-persisted',
        'mock-login-optout-reinitialize',
        'native-login-read-only',
        'injected-suspend',
        'injected-offline',
        'injected-resume-online',
        'tray-toggle-hide',
        'tray-toggle-show',
        'close-hides-process-survives',
        'dock-activate-reopens-visible',
        'invalid-tray-cursor-safe-placement',
        'small-work-area-800',
        'small-work-area-320',
        'single-instance-second-exits',
        'second-instance-reopens-window',
        'second-instance-verification-identity',
        'single-instance-keeps-one-window',
        'tray-valid-template-bitmap',
        'tray-CB-identity',
        'dock-and-warning-match-tray-placement',
        'tray-visibility-warning-factual',
        'capture-dom-is-current-dashboard',
        'owned-popup-actual-show',
        'popup-security-preferences',
        'popup-no-focus-steal',
        'popup-escaped-no-capabilities',
        'popup-window-open-denied',
        'popup-real-capture',
        'popup-limit-three',
        'popup-within-work-area',
        'popup-native-dismiss',
        'popup-pre-abort-no-window',
        'popup-cancel-closes-window',
        'popup-load-failure-bounded',
        'popup-auto-close-eight-seconds',
        'popup-single-slot-full-readiness',
        'popup-zero-slot-processes-unsupported',
        'popup-no-screen-processes-unsupported',
        'popup-full-readiness-preserves-queue',
        'engine-popup-earliest-actually-first',
        'engine-popup-capacity-queues-overflow',
        'engine-popup-earliest-survives-later-burst',
        'engine-popup-next-slot-drains-without-repoll',
        'engine-popup-burst-completes-before-history-assertion',
        'engine-popup-all-four-attempted-once',
        'day-popup-one-native-false',
        'day-popup-wording-false',
        'day-popup-no-repeat-false',
        'day-popup-one-native-true',
        'day-popup-wording-true',
        'day-popup-no-repeat-true',
        'popup-quit-cleanup',
        'capturePage-real-electron',
        'snapshot-no-plaintext-webhook'
    )
    $actualNames = @($smoke.actions | ForEach-Object { $_.name })
    $difference = @(Compare-Object ($expectedActions | Sort-Object) ($actualNames | Sort-Object))
    Assert-Check 'smoke-actions' (
        $smoke.actions.Count -eq 100 -and $difference.Count -eq 0 -and
        @($smoke.actions | Where-Object { !$_.passed }).Count -eq 0
    ) @{ expected = $expectedActions; actual = $actualNames; difference = $difference }
    Stop-OwnedProcesses

    Invoke-Installer $setup ($installArguments + ('/LOG="{0}"' -f (Join-Path $evidenceDirectory 'reinstall.log'))) 'reinstall'
    Assert-Payload 'reinstall'
    Assert-Shortcuts 'reinstall'
    Assert-Registration 'reinstall'
    $result.profileHashes.afterReinstall = Get-ProfileHashes
    Assert-Check 'reinstall-preserves-profile' (
        ($result.profileHashes.beforeReinstall | ConvertTo-Json -Compress) -ceq
        ($result.profileHashes.afterReinstall | ConvertTo-Json -Compress)
    ) $result.profileHashes
    $uninstaller = Join-Path $installDirectory 'unins000.exe'
    Invoke-Installer $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        ('/LOG="{0}"' -f (Join-Path $evidenceDirectory 'uninstall.log'))) 'uninstall'
    $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Test-Path -LiteralPath $installDirectory) -and [DateTime]::UtcNow -lt $uninstallDeadline) {
        Start-Sleep -Milliseconds 200
    }
    $hasUninstallPayload = Test-Path -LiteralPath $installDirectory
    $uninstallLeftovers = @()
    if ($hasUninstallPayload) {
        $uninstallLeftovers = @(Get-ChildItem -LiteralPath $installDirectory -Force -Recurse -ErrorAction SilentlyContinue |
            Select-Object FullName, PSIsContainer)
    }
    Assert-Check 'uninstall-removes-payload' (!$hasUninstallPayload) @{
        directory = $installDirectory; timeoutSeconds = 15; leftovers = $uninstallLeftovers
    }
    Assert-Check 'uninstall-removes-shortcuts' (@($shortcuts | Where-Object {
        Test-Path -LiteralPath $_
    }).Count -eq 0) $shortcuts
    Assert-Check 'uninstall-removes-registration' (!(Test-Path -LiteralPath "HKCU:\$uninstallKey")) $uninstallKey
    $result.profileHashes.afterUninstall = Get-ProfileHashes
    Assert-Check 'uninstall-preserves-profile' (
        ($result.profileHashes.beforeReinstall | ConvertTo-Json -Compress) -ceq
        ($result.profileHashes.afterUninstall | ConvertTo-Json -Compress)
    ) $result.profileHashes

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($packageDirectory, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $zipManifest = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object {
            $entry = $_
            $stream = $entry.Open()
            try {
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $hash = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() }
                finally { $sha.Dispose() }
            } finally { $stream.Dispose() }
            [ordered]@{
                path = $entry.FullName.Substring('Cinema Bar-win32-x64/'.Length).Replace('\', '/')
                hash = $hash
            }
        } | Sort-Object { $_.path })
        $badEntries = @($archive.Entries | Where-Object {
            !$_.FullName.StartsWith('Cinema Bar-win32-x64/') -or
            $_.FullName -match '(^|/)(state\.json|\.env[^/]*|node_modules|profile|staging)(/|$)'
        })
        Assert-Check 'zip-payload' (
            $badEntries.Count -eq 0 -and (Test-Manifest $result.payload.package $zipManifest)
        ) @{ files = $zipManifest.Count; rejected = @($badEntries | ForEach-Object { $_.FullName }) }
    } finally { $archive.Dispose() }
    $result.zipHash = Get-Hash $zip
    @("$($result.setupHash)  $([IO.Path]::GetFileName($setup))",
      "$($result.zipHash)  $([IO.Path]::GetFileName($zip))") |
        Set-Content (Join-Path $releaseDirectory 'SHA256SUMS-Windows.txt') -Encoding utf8NoBOM
    $result.passed = $true
} catch {
    $result.error = $_.ToString()
    Write-Host "Windows verification failed: $_"
} finally {
    try {
        Stop-OwnedProcesses
        if ($hasOwnership) {
            # Clean up only this test's registration; keep the normal profile for preservation proof.
            if (Test-Path -LiteralPath $runKey) {
                $key = Get-Item -LiteralPath $runKey
                foreach ($name in @($key.GetValueNames())) {
                    if ($name -notin $initialRunNames -and
                        [string]$key.GetValue($name) -match [regex]::Escape($installedExecutable)) {
                        Remove-ItemProperty -LiteralPath $runKey -Name $name
                        $result.cleanup += "Removed test startup value: $name"
                    }
                }
            }
            $cleanupUninstaller = Join-Path $installDirectory 'unins000.exe'
            if (Test-Path -LiteralPath $cleanupUninstaller) {
                $process = Start-Process $cleanupUninstaller -ArgumentList @('/VERYSILENT',
                    '/SUPPRESSMSGBOXES', '/NORESTART',
                    ('/LOG="{0}"' -f (Join-Path $evidenceDirectory 'cleanup-uninstall.log'))) -PassThru
                if (!$process.WaitForExit(120000) -or $process.ExitCode -ne 0) {
                    throw 'Cleanup uninstaller failed'
                }
            }
        }
    } catch {
        $result.cleanup += $_.ToString()
        $result.passed = $false
        if (!$result.error) { $result.error = $_.ToString() }
    }
    foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'CINEMA_SMOKE*' })) {
        Remove-Item "Env:$($entry.Name)"
    }
    foreach ($name in $smokeEnvironment.Keys) { Set-Item "Env:$name" $smokeEnvironment[$name] }
    $result.finishedAt = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $evidenceDirectory 'windows-verification.json') -Encoding utf8NoBOM
}
if (!$result.passed) { exit 1 }
