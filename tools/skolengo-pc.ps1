# Flashcards : renouvelle le jeton Skolengo depuis ton ordinateur (Windows).
# Le serveur de connexion de Mon Bureau Numérique refuse les serveurs en ligne (GitHub, Supabase) :
# ce script fait cette seule étape depuis ta connexion, comme l'appli Skolengo, puis range le jeton
# frais dans ton compte Flashcards. Le robot GitHub lit ensuite l'emploi du temps et les notes avec.
#
#   Installation :   powershell -ExecutionPolicy Bypass -File skolengo-pc.ps1 -Install   (sans droits administrateur)
#   Désinstallation : powershell -ExecutionPolicy Bypass -File skolengo-pc.ps1 -Uninstall
#   Changer de compte Flashcards : ... -Reset
param([switch]$Install, [switch]$Uninstall, [switch]$Reset)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SB = 'https://nqrnqpoklbcfncyxagcz.supabase.co'
$KEY = 'sb_publishable_filQAlr3dYL3jmKZ3UlrGQ_H2FdZGUF'
$Domain = 'comptes.flashcards-tsi.fr'
# Identifiants publics de l'appli mobile Skolengo (les mêmes que la bibliothèque scolengo-api).
$ClientId = 'SkoApp.Prod.0d349217-9a4e-41ec-9af9-df9e69e09494'
$ClientSecret = '7cb4d9a8-2580-4041-9ae8-d5803869183f'
$Dir = Join-Path $env:LOCALAPPDATA 'FlashcardsEDT'
$SessFile = Join-Path $Dir 'session.dat'
$LogFile = Join-Path $Dir 'journal.txt'
$Self = Join-Path $Dir 'skolengo-pc.ps1'
$TaskName = 'Flashcards - jeton Skolengo'

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

function Write-Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm') + '  ' + $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  # Le journal garde les 200 dernières lignes.
  $all = Get-Content -Path $LogFile -Encoding UTF8
  if ($all.Count -gt 200) { $all | Select-Object -Last 200 | Set-Content -Path $LogFile -Encoding UTF8 }
}

# ---------- Session Flashcards (gardée chiffrée pour ton compte Windows) ----------
function Save-Session($refresh) {
  ConvertTo-SecureString $refresh -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $SessFile
}
function Read-SessionToken {
  if (-not (Test-Path $SessFile)) { return $null }
  $sec = Get-Content -Path $SessFile | ConvertTo-SecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
function Invoke-Supa($method, $path, $body, $token) {
  $headers = @{ apikey = $KEY }
  if ($token) { $headers['Authorization'] = 'Bearer ' + $token }
  $json = $null
  if ($null -ne $body) { $json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 20 -Compress)) }
  return Invoke-RestMethod -Method $method -Uri ($SB + $path) -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $json
}
function Connect-Flashcards {
  $refresh = Read-SessionToken
  if ($refresh) {
    try {
      $s = Invoke-Supa 'Post' '/auth/v1/token?grant_type=refresh_token' @{ refresh_token = $refresh } $null
      Save-Session $s.refresh_token
      return $s.access_token
    } catch { Write-Log 'Session Flashcards expirée : reconnecte-toi.' }
  }
  if (-not [Environment]::UserInteractive -or $env:FLASHCARDS_SILENT) { throw 'Pas de session Flashcards : relance le script à la main avec -Reset.' }
  $user = Read-Host 'Identifiant Flashcards'
  $pw = Read-Host 'Mot de passe Flashcards' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $s = Invoke-Supa 'Post' '/auth/v1/token?grant_type=password' @{ email = ($user.Trim().ToLower() + '@' + $Domain); password = $plain } $null
  Save-Session $s.refresh_token
  return $s.access_token
}

# ---------- Renouvellement du jeton Skolengo ----------
function Update-SkolengoToken {
  $token = Connect-Flashcards
  $rows = Invoke-Supa 'Get' '/rest/v1/docs?select=content,version&path=eq.edt%2Fauth.json' $null $token
  if (-not $rows -or @($rows).Count -eq 0) { throw 'Pas de jeton Skolengo dans ton compte (Réglages › Emploi du temps).' }
  $row = @($rows)[0]
  $auth = $row.content | ConvertFrom-Json
  $wellKnown = $auth.school.emsOIDCWellKnownUrl
  $conf = Invoke-RestMethod -Method Get -Uri $wellKnown
  $form = @{ grant_type = 'refresh_token'; refresh_token = $auth.tokenSet.refresh_token; client_id = $ClientId; client_secret = $ClientSecret }
  try {
    $t = Invoke-RestMethod -Method Post -Uri $conf.token_endpoint -Body $form -ContentType 'application/x-www-form-urlencoded'
  } catch {
    throw ('Le serveur de Mon Bureau Numérique refuse de renouveler le jeton (' + $_.Exception.Message + '). Colle un nouveau jeton dans l''appli : Réglages › Emploi du temps.')
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $ts = [ordered]@{
    access_token = $t.access_token
    refresh_token = $(if ($t.refresh_token) { $t.refresh_token } else { $auth.tokenSet.refresh_token })
    id_token = $(if ($t.id_token) { $t.id_token } else { $auth.tokenSet.id_token })
    token_type = $(if ($t.token_type) { $t.token_type } else { 'Bearer' })
    scope = $(if ($t.scope) { $t.scope } else { $auth.tokenSet.scope })
    expires_at = $now + [int]$t.expires_in
  }
  $auth.tokenSet = [pscustomobject]$ts
  $content = $auth | ConvertTo-Json -Depth 20 -Compress
  Invoke-Supa 'Post' '/rest/v1/rpc/put_doc' @{ p_path = 'edt/auth.json'; p_content = $content; p_version = [long]$row.version } $token | Out-Null
  Write-Log ('Jeton Skolengo renouvelé, valable jusqu''à ' + (Get-Date).AddSeconds([int]$t.expires_in).ToString('HH:mm') + '.')
}

# ---------- Installation : copie du script et tâche planifiée ----------
if ($Uninstall) {
  Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Startup')) 'Flashcards jeton Skolengo.lnk') -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
  Write-Host 'Désinstallé.'
  exit 0
}
if ($Reset) { Remove-Item -Force $SessFile -ErrorAction SilentlyContinue }
if ($Install) {
  if ($PSCommandPath -ne $Self) { Copy-Item -Force $PSCommandPath $Self }
  Remove-Item -Force $SessFile -ErrorAction SilentlyContinue
  $silent = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$env:FLASHCARDS_SILENT=1; & ''' + $Self + '''"'
  # À l'ouverture de session : raccourci dans le dossier Démarrage (pas besoin des droits administrateur).
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'Flashcards jeton Skolengo.lnk'))
  $lnk.TargetPath = 'powershell.exe'
  $lnk.Arguments = $silent
  $lnk.WindowStyle = 7
  $lnk.Save()
  # Toutes les 3 heures tant que l'ordinateur est allumé.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $silent
  $every = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $every -Settings $settings -Force | Out-Null
  Write-Host 'Installé : le jeton sera renouvelé à chaque démarrage et toutes les 3 heures.'
  Write-Host ''
  Write-Host 'Premier essai maintenant (connecte-toi avec ton compte Flashcards) :'
  try { Update-SkolengoToken; Write-Host 'Tout fonctionne.' } catch { Write-Log ('Erreur : ' + $_.Exception.Message) }
  Write-Host ('Journal : ' + $LogFile)
  exit 0
}

try {
  # Petite attente au démarrage, le temps que le réseau soit prêt.
  if ($env:FLASHCARDS_SILENT) { Start-Sleep -Seconds 30 }
  Update-SkolengoToken
} catch {
  Write-Log ('Erreur : ' + $_.Exception.Message)
  exit 1
}
