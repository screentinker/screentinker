const R='/home/owner/Downloads/remote_display';
const Database=require(R+'/server/node_modules/better-sqlite3');
const io=require(R+'/server/node_modules/socket.io-client');
const crypto=require('crypto'), fs=require('fs');
const db=new Database(R+'/server/db/remote_display.db');
const WS='cdd08e87-cc2a-4dd8-a432-61ab17690171', USER='643818a2-06a1-49aa-bedf-bc12a2d34731';
const PL=(db.prepare("SELECT id FROM playlists WHERE workspace_id=? LIMIT 1").get(WS)||{}).id||null;
const FLEET=[
 {name:'Lobby — Main Entrance',rssi:-38,ssid:'Corp-WiFi',free:52400},
 {name:'Café Menu Board',rssi:-46,ssid:'Corp-WiFi',free:41200},
 {name:'Reception Desk',rssi:-41,ssid:'Corp-WiFi',free:48600},
 {name:'Warehouse Ops Board',rssi:-53,ssid:'Warehouse-5G',free:37800},
 {name:'Conference Room A',rssi:-35,ssid:'Corp-WiFi',free:55100},
];
const now=Math.floor(Date.now()/1000);
const devs=FLEET.map((f,i)=>{
 const id=crypto.randomUUID(), token=crypto.randomBytes(32).toString('hex');
 db.prepare(`INSERT INTO devices (id,name,status,last_heartbeat,user_id,workspace_id,playlist_id,screen_width,screen_height,render_width,render_height,android_version,app_version,orientation,created_at,updated_at,ota_status,blocked,tier,ota_enabled,sort_order,device_token,timezone)
  VALUES (?,?,'online',?,?,?,?,1920,1080,1920,1080,'13','1.9.7','landscape',?,?,'none',0,0,1,?,?,'America/Chicago')`)
  .run(id,f.name,now,USER,WS,PL,now-86400*40,now,i+10,token);
 return {...f,id,token,i};
});
fs.writeFileSync('/home/owner/screentinker-video/fake_devices.json',JSON.stringify(devs.map(d=>d.id)));
console.log('seeded',devs.length,'devices; playlist',PL);
function tel(d){return{battery_level:100,battery_charging:true,storage_free_mb:d.free,storage_total_mb:64000,ram_free_mb:1380,ram_total_mb:2048,cpu_usage:9+d.i*3,wifi_ssid:d.ssid,wifi_rssi:d.rssi,uptime_seconds:86400*(3+d.i)};}
devs.forEach(d=>{
 const s=io('https://localhost:3443/device',{transports:['websocket'],rejectUnauthorized:false,forceNew:true});
 s.on('connect',()=>s.emit('device:register',{device_id:d.id,device_token:d.token,device_info:{android_version:'13',app_version:'1.9.7',screen_width:1920,screen_height:1080,render_width:1920,render_height:1080},fingerprint:'fk-'+d.id}));
 s.on('device:registered',()=>s.emit('device:heartbeat',{device_id:d.id,client_ms:Date.now(),telemetry:tel(d)}));
 setInterval(()=>{if(s.connected)s.emit('device:heartbeat',{device_id:d.id,client_ms:Date.now(),telemetry:tel(d)});},9000);
});
console.log('fleet connected — staying online');
setInterval(()=>{},1e9);
