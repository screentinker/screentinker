; ScreenTinker native player for Windows — Inno Setup script (built by build.ps1).
;
; Silent install (fleet rollout / the helper's self-update):
;   ScreenTinker-Setup-X.Y.Z.exe /VERYSILENT /SUPPRESSMSGBOXES /SERVER=https://your-server [/NAME="Lobby"]
;       [/ALLOWPACKAGES=1] [/MERGETASKS=audience]
; /SUPPRESSMSGBOXES: without it a message box still waits for a click under /VERYSILENT. (A failed
; add-on is only logged when silent, but keep it for anything else that asks.)
; /MERGETASKS=audience = the "Audience counting" checkbox (off by default): downloads the optional
; add-on (OpenCV + face model, ~55 MB) from the same server into {app}\addons\audience, verified
; against the sha256 the server publishes. An upgrade keeps the previous choice (UsePreviousTasks).
; An upgrade keeps ProgramData\ScreenTinker\config.json (server, options) and the pairing in state\.
;
; ⚠️ ACLs are the security model here, keep them as written:
;   ProgramData\ScreenTinker\config.json  — admin/SYSTEM write only. The SYSTEM helper trusts its
;                                           server_url to verify installers; a user-writable copy
;                                           would let the player user choose what SYSTEM runs.
;   ProgramData\ScreenTinker\state\       — the player users may write (pairing, cache, OTA downloads).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{7C2B3E3A-5D0B-4B5E-9F7A-5C1D2E3F4A5B}
AppName=ScreenTinker Player
AppVersion={#AppVersion}
AppPublisher=ScreenTinker
AppPublisherURL=https://screentinker.com
DefaultDirName={autopf}\ScreenTinker
DefaultGroupName=ScreenTinker
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=ScreenTinker-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName=ScreenTinker Player
LicenseFile=THIRD-PARTY-NOTICES.txt
MinVersion=10.0.17763

[Tasks]
Name: "audience"; Description: "Audience counting add-on (downloads about 55 MB from your ScreenTinker server). It only counts if your organization switches it on for this screen, and it needs a USB webcam."; Flags: unchecked

[Dirs]
Name: "{commonappdata}\ScreenTinker"
Name: "{commonappdata}\ScreenTinker\state"; Permissions: users-modify

[Files]
Source: "..\..\build\win\dist\ScreenTinker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[UninstallDelete]
Type: filesandordirs; Name: "{app}\addons"

[Icons]
Name: "{group}\ScreenTinker Player"; Filename: "{app}\ScreenTinker.exe"

[Run]
; Firewall: the LAN trigger listener (TCP 8079 / UDP 7847 by default, operator-configurable) and the
; local control API. A program rule covers whatever ports the dashboard configures.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ScreenTinker Player"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ScreenTinker Player"" dir=in action=allow program=""{app}\ScreenTinker.exe"" enable=yes profile=any"; Flags: runhidden
Filename: "{app}\screentinker-helper.exe"; Parameters: "--startup auto install"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "failure ScreenTinkerHelper reset= 86400 actions= restart/5000/restart/5000/restart/30000"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "start ScreenTinkerHelper"; Flags: runhidden

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop ScreenTinkerHelper"; Flags: runhidden; RunOnceId: "StopHelper"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ScreenTinker.exe"; Flags: runhidden; RunOnceId: "KillPlayer"
Filename: "{app}\screentinker-helper.exe"; Parameters: "remove"; Flags: runhidden; RunOnceId: "RemoveHelper"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ScreenTinker Player"""; Flags: runhidden; RunOnceId: "DelFw"

[Code]
var
  ServerPage: TInputQueryWizardPage;
  AddonError: String;

function ConfigPath(): String;
begin
  Result := ExpandConstant('{commonappdata}\ScreenTinker\config.json');
end;

function JsonEscape(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure InitializeWizard();
begin
  ServerPage := CreateInputQueryPage(wpSelectDir, 'ScreenTinker server',
    'Which ScreenTinker server should this display connect to?',
    'Enter the address you use for the dashboard, e.g. https://screentinker.com. A pairing code will ' +
    'appear on this screen after installation; enter it in the dashboard to add the display.');
  ServerPage.Add('Server URL:', False);
  ServerPage.Add('Display name (optional):', False);
  ServerPage.Values[0] := ExpandConstant('{param:SERVER|https://screentinker.com}');
  ServerPage.Values[1] := ExpandConstant('{param:NAME|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { An upgrade keeps the existing configuration: never ask again. }
  Result := (PageID = ServerPage.ID) and FileExists(ConfigPath()) and (ExpandConstant('{param:SERVER|}') = '');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  { Stop the helper (and with it the watchdog) and the player so their files can be replaced. }
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop ScreenTinkerHelper', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1500);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM ScreenTinker.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM screentinker-helper.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure WriteConfig();
var
  Server, Name, Json: String;
begin
  if FileExists(ConfigPath()) and (ExpandConstant('{param:SERVER|}') = '') then
    exit;
  Server := Trim(ServerPage.Values[0]);
  while (Length(Server) > 0) and (Server[Length(Server)] = '/') do
    Delete(Server, Length(Server), 1);
  Name := Trim(ServerPage.Values[1]);
  Json := '{' + #13#10 +
          '  "server_url": "' + JsonEscape(Server) + '",' + #13#10 +
          '  "device_name": "' + JsonEscape(Name) + '",' + #13#10 +
          '  "autostart": true,' + #13#10;
  if ExpandConstant('{param:ALLOWPACKAGES|0}') = '1' then
    Json := Json + '  "allow_package_install": true' + #13#10
  else
    Json := Json + '  "allow_package_install": false' + #13#10;
  Json := Json + '}' + #13#10;
  SaveStringToFile(ConfigPath(), Json, False);
end;

procedure SetupAccess();
var
  Code: Integer;
begin
  { The helper authorises pipe callers by executable (only the installed ScreenTinker.exe), so there is
    no group to manage. Admin/SYSTEM-only config (see the header). }
  Exec(ExpandConstant('{sys}\icacls.exe'), '"' + ConfigPath() + '" /inheritance:r /grant *S-1-5-32-544:F /grant *S-1-5-18:F /grant *S-1-5-32-545:R',
       '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ ---- the optional audience-counting add-on (server/routes/audience-addon.js) ------------------------ }
const
  AddonPlatform = 'win-x64-cp312';   { the Python the bundle carries: build.ps1 builds with 3.12 }

function ConfiguredServer(): String;
var
  Raw: AnsiString;
  S: String;
  P: Integer;
begin
  { The server the admin-only config names (just written, or kept from the previous install) — the
    same server the SYSTEM helper trusts, never one the user-level player could change. }
  Result := '';
  if not LoadStringFromFile(ConfigPath(), Raw) then exit;
  S := String(Raw);
  P := Pos('"server_url"', S);
  if P = 0 then exit;
  Delete(S, 1, P + Length('"server_url"') - 1);
  P := Pos('"', S);
  if P = 0 then exit;
  Delete(S, 1, P);
  P := Pos('"', S);
  if P = 0 then exit;
  Result := Copy(S, 1, P - 1);
  StringChangeEx(Result, '\/', '/', True);
end;

function AddonProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if ProgressMax > 0 then
    WizardForm.FilenameLabel.Caption := Format('%d of %d MB', [Integer(Progress div 1048576), Integer(ProgressMax div 1048576)])
  else
    WizardForm.FilenameLabel.Caption := Format('%d MB', [Integer(Progress div 1048576)]);
  Result := True;
end;

function InstallAudienceAddon(): String;
var
  Server, Sha, Dir, NewDir, Stamp: String;
  Raw: AnsiString;
  Code: Integer;
begin
  { '' on success, else why not. Never fatal: a failed add-on is a screen that cannot count, not a
    failed player install (the self-update runs this silently, and must still finish). }
  Result := '';
  Server := ConfiguredServer();
  if Server = '' then begin Result := 'no server configured'; exit; end;
  Dir := ExpandConstant('{app}\addons\audience');
  NewDir := Dir + '.new';
  Stamp := Dir + '\ADDON-SHA256';
  WizardForm.StatusLabel.Caption := 'Downloading the audience-counting add-on...';
  try
    DownloadTemporaryFile(Server + '/api/audience-addon/' + AddonPlatform + '/sha256', 'audience.sha256', '', nil);
  except
    Result := 'this server does not offer the add-on (' + GetExceptionMessage + ')';
    exit;
  end;
  if not LoadStringFromFile(ExpandConstant('{tmp}\audience.sha256'), Raw) then begin Result := 'no checksum'; exit; end;
  Sha := Lowercase(Trim(String(Raw)));
  if Length(Sha) <> 64 then begin Result := 'bad checksum from the server'; exit; end;
  { Already installed at exactly this build (an upgrade with the box still ticked): nothing to fetch. }
  if LoadStringFromFile(Stamp, Raw) and (Lowercase(Trim(String(Raw))) = Sha) and FileExists(Dir + '\ADDON.json') then exit;
  try
    { DownloadTemporaryFile verifies the sha256 itself and fails on a mismatch. }
    DownloadTemporaryFile(Server + '/download/audience-addon/' + AddonPlatform, 'audience.zip', Sha, @AddonProgress);
  except
    Result := 'download failed (' + GetExceptionMessage + ')';
    exit;
  end;
  WizardForm.StatusLabel.Caption := 'Installing the audience-counting add-on...';
  WizardForm.FilenameLabel.Caption := '';
  DelTree(NewDir, True, True, True);
  ForceDirectories(NewDir);
  { tar.exe (bsdtar) ships with Windows 10 1803+ and reads zip; MinVersion is 1809. }
  if not Exec(ExpandConstant('{sys}\tar.exe'), '-xf "' + ExpandConstant('{tmp}\audience.zip') + '" -C "' + NewDir + '"',
              '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) or not FileExists(NewDir + '\ADDON.json') then
  begin
    DelTree(NewDir, True, True, True);
    Result := 'could not unpack the add-on (tar exit ' + IntToStr(Code) + ')';
    exit;
  end;
  DelTree(Dir, True, True, True);
  if not RenameFile(NewDir, Dir) then begin Result := 'could not move the add-on into place'; exit; end;
  SaveStringToFile(Stamp, Sha, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { ssInstall, not ssPostInstall: the [Run] entries start the helper service, and the helper builds its
    configuration at start — the admin-only config must exist before that. }
  if CurStep = ssInstall then
  begin
    ForceDirectories(ExpandConstant('{commonappdata}\ScreenTinker'));
    WriteConfig();
    SetupAccess();
    { The add-on here too, not after the files: the [Run] entries start the helper, which starts the
      player, which looks for the add-on once at start. The player was stopped in PrepareToInstall. }
    if WizardIsTaskSelected('audience') then
    begin
      AddonError := InstallAudienceAddon();
      if AddonError <> '' then
      begin
        Log('audience add-on not installed: ' + AddonError);
        { Silent (a fleet rollout, the helper's self-update): log only. A box would wait for a click
          that never comes unless /SUPPRESSMSGBOXES was also passed. }
        if not WizardSilent() then
          SuppressibleMsgBox('The player will be installed, but the audience-counting add-on was not: ' + AddonError + '.'#13#10#13#10 +
                             'Run the installer again to retry. Everything else works without it.', mbError, MB_OK, IDOK);
      end;
    end
    else
      { Unticked on a reinstall: the add-on goes, and with it the capability. }
      DelTree(ExpandConstant('{app}\addons\audience'), True, True, True);
  end;
end;
