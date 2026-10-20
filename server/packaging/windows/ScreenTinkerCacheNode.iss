; ScreenTinker studio cache node: a local replica of a ScreenTinker server, run as a Windows service.
; Built by build.ps1, which passes AppVersion, AppVersionNumeric, StageDir and OutputDir.
;
; The wizard asks for what a studio is given by whoever runs the main server (docs: README.md):
;   main server address, invite code, shared secret, cache size, port, data folder.
; The same values can be passed for a silent install (by us or a partner):
;   ScreenTinker-CacheNode-Setup-X.Y.Z.exe /VERYSILENT /PRIMARY_URL=https://... /JOIN_CODE=ABCDE-FGHJK
;       /JWT_SECRET=... [/CACHE_GB=100] [/PORT=3001] [/PLAYERS=1] [/DATADIR=D:\ScreenTinker]
; An upgrade (settings file already present) asks nothing and keeps the settings, the copy and the cache.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppVersionNumeric
  #define AppVersionNumeric AppVersion
#endif

[Setup]
AppId={{5C7E2F4A-9B1D-4E8B-A6C2-3D1F0B7E9A55}
AppName=ScreenTinker Cache Node
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersionNumeric}
AppPublisher=ScreenTinker
AppPublisherURL=https://screentinker.com
DefaultDirName={autopf}\ScreenTinker Cache Node
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=ScreenTinker-CacheNode-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=ScreenTinker Cache Node
CloseApplications=no

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
Name: "{commonappdata}\ScreenTinker"
Name: "{commonappdata}\ScreenTinker\logs"

[INI]
; A plain .url shortcut, so the status page opens in whatever browser the studio uses.
Filename: "{autoprograms}\ScreenTinker Cache Node status.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:CfgPort}/cache-node.html"

[Icons]
Name: "{autoprograms}\ScreenTinker Cache Node logs"; Filename: "{commonappdata}\ScreenTinker\logs"

[Run]
Filename: "{autoprograms}\ScreenTinker Cache Node status.url"; Description: "Open the status page"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\ScreenTinkerCacheNode.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\ScreenTinkerCacheNode.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ScreenTinker Cache Node"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[UninstallDelete]
Type: files; Name: "{autoprograms}\ScreenTinker Cache Node status.url"
; The settings, the copy and the cached media in ProgramData are KEPT on uninstall, so a reinstall
; picks up where it left off. README.md says how to remove them.

[Code]
var
  ServerPage, CachePage: TInputQueryWizardPage;
  DataPage: TInputDirWizardPage;
  ScreensPage: TInputOptionWizardPage;

function EnvFile(): String;
begin
  Result := ExpandConstant('{commonappdata}\ScreenTinker\screentinker.env');
end;

function IsUpgrade(): Boolean;
begin
  Result := FileExists(EnvFile());
end;

{ The port in the settings file (upgrade) or chosen now (fresh install). }
function CfgPort(Param: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '3001';
  if (CachePage <> nil) and (Trim(CachePage.Values[1]) <> '') and not IsUpgrade() then begin
    Result := Trim(CachePage.Values[1]);
    exit;
  end;
  if LoadStringsFromFile(EnvFile(), Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('PORT=', Lines[I]) = 1 then Result := Trim(Copy(Lines[I], 6, 10));
end;

function RunHidden(const Exe, Params: String): Integer;
var
  Code: Integer;
begin
  if not Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then Code := -1;
  Result := Code;
end;

function ServiceExe(): String;
begin
  Result := ExpandConstant('{app}\ScreenTinkerCacheNode.exe');
end;

procedure InitializeWizard();
begin
  ServerPage := CreateInputQueryPage(wpWelcome, 'Main server',
    'Which ScreenTinker server should this PC copy?',
    'Whoever runs your main ScreenTinker server gives you these three things. The invite is created on that server under Servers > Let a replica connect to this server.');
  ServerPage.Add('Main server address (for example https://signage.example.com):', False);
  ServerPage.Add('Invite code:', False);
  ServerPage.Add('Shared secret (JWT_SECRET of the main server):', True);
  ServerPage.Values[0] := ExpandConstant('{param:PRIMARY_URL|}');
  ServerPage.Values[1] := ExpandConstant('{param:JOIN_CODE|}');
  ServerPage.Values[2] := ExpandConstant('{param:JWT_SECRET|}');

  CachePage := CreateInputQueryPage(ServerPage.ID, 'Storage and network',
    'How much disk may the copy of the media use?',
    'Files the playlists still use are always kept; the least recently used of the rest are removed to stay under this size.');
  CachePage.Add('Media cache size in GB:', False);
  CachePage.Add('Port screens on this network connect to:', False);
  CachePage.Values[0] := ExpandConstant('{param:CACHE_GB|100}');
  CachePage.Values[1] := ExpandConstant('{param:PORT|3001}');

  ScreensPage := CreateInputOptionPage(CachePage.ID, 'Screens',
    'Should screens in this studio connect to this PC?',
    'If they do, they keep playing and can still be set up while the internet is down. Whoever runs the main server must then allow it there (What this server may change).',
    False, False);
  ScreensPage.Add('Let screens connect to this PC');
  ScreensPage.Values[0] := ExpandConstant('{param:PLAYERS|0}') = '1';

  DataPage := CreateInputDirPage(ScreensPage.ID, 'Data folder',
    'Where should the copy and the media cache be kept?',
    'Choose a drive with room for the media cache. The folder is kept if the cache node is uninstalled.', False, '');
  DataPage.Add('');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|}');
  if DataPage.Values[0] = '' then DataPage.Values[0] := ExpandConstant('{commonappdata}\ScreenTinker\data');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { An upgrade keeps its settings; nothing to ask. }
  Result := IsUpgrade() and ((PageID = ServerPage.ID) or (PageID = CachePage.ID) or
                            (PageID = ScreensPage.ID) or (PageID = DataPage.ID));
end;

function ValidServerPage(var Msg: String): Boolean;
var
  Url: String;
begin
  Result := False;
  Url := Lowercase(Trim(ServerPage.Values[0]));
  if (Pos('https://', Url) <> 1) and (Pos('http://', Url) <> 1) then begin
    Msg := 'Enter the main server address, starting with https:// (or http://).'; exit;
  end;
  if Length(Trim(ServerPage.Values[1])) < 10 then begin
    Msg := 'Enter the invite code from the main server.'; exit;
  end;
  if Length(Trim(ServerPage.Values[2])) < 32 then begin
    Msg := 'The shared secret must be the main server''s JWT_SECRET (at least 32 characters).'; exit;
  end;
  Result := True;
end;

function ValidCachePage(var Msg: String): Boolean;
var
  Gb, Port: Integer;
begin
  Result := False;
  Gb := StrToIntDef(Trim(CachePage.Values[0]), 0);
  Port := StrToIntDef(Trim(CachePage.Values[1]), 0);
  if Gb < 1 then begin Msg := 'Enter the media cache size as a whole number of GB (at least 1).'; exit; end;
  if (Port < 1) or (Port > 65535) then begin Msg := 'Enter a port between 1 and 65535.'; exit; end;
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Msg: String;
begin
  Result := True;
  if (CurPageID = ServerPage.ID) and not ValidServerPage(Msg) then begin MsgBox(Msg, mbError, MB_OK); Result := False; end;
  if (CurPageID = CachePage.ID) and not ValidCachePage(Msg) then begin MsgBox(Msg, mbError, MB_OK); Result := False; end;
end;

{ A silent install skips the pages, so the same checks run here before anything is copied. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Msg: String;
begin
  Result := '';
  if not IsUpgrade() then begin
    if not ValidServerPage(Msg) then begin Result := Msg; exit; end;
    if not ValidCachePage(Msg) then begin Result := Msg; exit; end;
  end;
  { Upgrade: stop the running service so its files can be replaced. Ignored when it is not installed. }
  if FileExists(ServiceExe()) then RunHidden(ServiceExe(), 'stop');
end;

procedure WriteSettings();
var
  S, Url, Roles: String;
  Bytes: Int64;
begin
  Roles := 'caches-content';
  if ScreensPage.Values[0] then Roles := Roles + ',terminates-players';
  Url := Trim(ServerPage.Values[0]);
  while (Length(Url) > 0) and (Url[Length(Url)] = '/') do Url := Copy(Url, 1, Length(Url) - 1);
  Bytes := StrToInt64Def(Trim(CachePage.Values[0]), 100) * 1073741824;
  S :=
    '# ScreenTinker cache node settings, written by the installer.' + #13#10 +
    '# Edit, then restart the "ScreenTinker Cache Node" service (services.msc).' + #13#10 +
    '# Holds JWT_SECRET: readable only by Administrators and SYSTEM. Keep it that way.' + #13#10 +
    #13#10 +
    'NODE_ENV=production' + #13#10 +
    '# Screens on this network connect to http://<this PC>:PORT' + #13#10 +
    'PORT=' + Trim(CachePage.Values[1]) + #13#10 +
    '# The copy (database) and the media cache live here.' + #13#10 +
    'DATA_DIR=' + DataPage.Values[0] + #13#10 +
    'SELF_HOSTED=true' + #13#10 +
    #13#10 +
    '# This PC is a replica of the main server below. It connects OUT to it; nothing needs to reach this PC.' + #13#10 +
    'MESH_ACCEPT_ENROLLMENT=true' + #13#10 +
    'PRIMARY_URL=' + Url + #13#10 +
    '# Must equal the main server''s JWT_SECRET: a login there works here.' + #13#10 +
    'JWT_SECRET=' + Trim(ServerPage.Values[2]) + #13#10 +
    '# Used once, at first start, to join the main server. Harmless afterwards (single use).' + #13#10 +
    'REPLICA_JOIN_CODE=' + Trim(ServerPage.Values[1]) + #13#10 +
    '# Roles taken on at the join: keep media copies here; terminates-players lets screens connect to this PC.' + #13#10 +
    'REPLICA_JOIN_ROLES=' + Roles + #13#10 +
    '# Media cache size in bytes (' + Trim(CachePage.Values[0]) + ' GB).' + #13#10 +
    'REPLICA_CACHE_BYTES=' + IntToStr(Bytes) + #13#10;
  ForceDirectories(DataPage.Values[0]);
  if not SaveStringToFile(EnvFile(), S, False) then RaiseException('Could not write ' + EnvFile());
  { Administrators and SYSTEM only: the file holds the secret that signs every login. }
  RunHidden(ExpandConstant('{sys}\icacls.exe'),
    '"' + EnvFile() + '" /inheritance:r /grant:r *S-1-5-32-544:F *S-1-5-18:F');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Port: String;
begin
  if CurStep <> ssPostInstall then exit;
  if not IsUpgrade() then WriteSettings();
  Port := CfgPort('');
  { install fails harmlessly when the service already exists (upgrade). }
  RunHidden(ServiceExe(), 'install');
  RunHidden(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="ScreenTinker Cache Node"');
  RunHidden(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall add rule name="ScreenTinker Cache Node" dir=in action=allow protocol=TCP localport=' + Port + ' profile=private,domain');
  if RunHidden(ServiceExe(), 'start') <> 0 then
    MsgBox('The ScreenTinker Cache Node service did not start. See the logs in ' +
           ExpandConstant('{commonappdata}\ScreenTinker\logs') + '.', mbError, MB_OK);
end;
