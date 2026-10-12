' What this Roku tells the server about itself: registration identity, capabilities, telemetry.
'
' ⚠️ UNKNOWN IS null, NEVER A GUESS. The web player once sent battery_charging=false and an SSID of
' "Web Player" from every screen; both looked like data and were not. A Roku app cannot read free RAM
' in MB, storage, CPU or temperature, so those go as invalid (JSON null) — the dashboard then shows
' "unknown", which is true.

function ST_AppVersion() as string
    ai = CreateObject("roAppInfo")
    return ai.GetVersion()
end function

' Roku's Autoplay setting (Settings > Accessibility on recent Roku OS). A Roku OS old enough not to
' have the call predates the setting, so autoplay is on there.
function ST_AutoPlayEnabled() as boolean
    di = CreateObject("roDeviceInfo")
    if FindMemberFunction(di, "IsAutoPlayEnabled") = invalid then return true
    return di.IsAutoPlayEnabled() = true
end function

function ST_OsVersionString() as string
    di = CreateObject("roDeviceInfo")
    v = di.GetOSVersion()
    if ST_IsAA(v) then
        return ST_Str(v, "major") + "." + ST_Str(v, "minor") + "." + ST_Str(v, "revision") + " build " + ST_Str(v, "build")
    end if
    return ""
end function

' Per-install identity the server matches on. Roku gives each channel a stable client id per device
' (it survives app updates and reboots, and changes on factory reset), which is exactly the
' "per install" meaning the other players' fingerprint has.
function ST_Fingerprint() as string
    di = CreateObject("roDeviceInfo")
    id = di.GetChannelClientId()
    if id = invalid or id = "" then
        id = ST_RegRead("fallback_fp")
        if id = "" then
            id = ST_RandomHex(32)
            ST_RegWrite("fallback_fp", id)
        end if
    end if
    return "roku:" + id
end function

function ST_DeviceInfo() as object
    di = CreateObject("roDeviceInfo")
    ds = di.GetDisplaySize()
    ui = di.GetUIResolution()
    info = {
        app_version: ST_AppVersion(),
        screen_width: ds.w,
        screen_height: ds.h,
        render_width: ui.width,
        render_height: ui.height,
        hardware_model: di.GetModel(),
        hardware_os_version: ST_OsVersionString(),
        video_mode: di.GetVideoMode(),
        model_name: di.GetModelDisplayName(),
        device_name: di.GetFriendlyName()
    }
    return info
end function

' The capabilities this build actually implements. Names come from the server's vocabulary
' (server/lib/player-capabilities.js); anything not listed is treated as unsupported by the dashboard.
function ST_Capabilities() as object
    ' The roku BASELINE (server/lib/player-capabilities.js) plus what this build adds on top: HLS,
    ' the weekly power schedule and screen on/off, both of which a Roku honours by blanking the
    ' screen (an app cannot switch the TV off).
    return [
        "playback.video", "playback.image", "playback.widget", "playback.bundle",
        "playback.zones", "playback.transitions", "playback.hls",
        "audio.mute", "system.restart_player",
        "display.power", "display.power_schedule",
        "clock.tz_table", "render.server_raster"
    ]
end function

function ST_Telemetry() as object
    di = CreateObject("roDeviceInfo")
    conn = di.GetConnectionInfo()
    rssi = invalid
    ip = invalid
    if ST_IsAA(conn) then
        if ST_IsNumber(conn.signal) then rssi = conn.signal
        if ST_IsString(conn.ip) then ip = conn.ip
    end if
    if ip = invalid then
        addrs = di.GetIPAddrs()
        if ST_IsAA(addrs) then
            for each k in addrs
                if ip = invalid then ip = addrs[k]
            end for
        end if
    end if
    vm = di.GetVideoMode()
    return {
        battery_level: invalid,
        battery_charging: invalid,
        storage_free_mb: invalid,
        storage_total_mb: invalid,
        ram_free_mb: invalid,
        ram_total_mb: invalid,
        cpu_usage: invalid,
        wifi_rssi: rssi,
        uptime_seconds: invalid,
        local_ip: ip,
        temperature_c: invalid,
        video_mode: vm,
        timezone: di.GetTimeZone(),
        device_utc: ST_NowMs()
    }
end function
