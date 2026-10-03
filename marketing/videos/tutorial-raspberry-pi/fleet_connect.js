const R='/home/owner/Downloads/remote_display';
const Database=require(R+'/server/node_modules/better-sqlite3');
const io=require(R+'/server/node_modules/socket.io-client');
const db=new Database(R+'/server/db/remote_display.db',{readonly:true});
const ids=JSON.parse(require('fs').readFileSync('/home/owner/screentinker-video/fake_devices.json','utf8'));
const rows=ids.map(id=>db.prepare("SELECT id,device_token name FROM devices WHERE id=?").get(id)).filter(Boolean);
const full=ids.map((id,i)=>{const r=db.prepare("SELECT device_token FROM devices WHERE id=?").get(id);return{id,token:r&&r.device_token,i};}).filter(x=>x.token);
const T=[{rssi:-38,ssid:'Corp-WiFi',free:52400},{rssi:-46,ssid:'Corp-WiFi',free:41200},{rssi:-41,ssid:'Corp-WiFi',free:48600},{rssi:-53,ssid:'Warehouse-5G',free:37800},{rssi:-35,ssid:'Corp-WiFi',free:55100}];
function tel(i){const t=T[i%T.length];return{battery_level:100,battery_charging:true,storage_free_mb:t.free,storage_total_mb:64000,ram_free_mb:1380,ram_total_mb:2048,cpu_usage:9+i*3,wifi_ssid:t.ssid,wifi_rssi:t.rssi,uptime_seconds:86400*(3+i)};}
full.forEach(d=>{
 const s=io('https://localhost:3443/device',{transports:['websocket'],rejectUnauthorized:false,forceNew:true});
 s.on('connect',()=>s.emit('device:register',{device_id:d.id,device_token:d.token,device_info:{android_version:'13',app_version:'1.9.7',screen_width:1920,screen_height:1080,render_width:1920,render_height:1080},fingerprint:'fk-'+d.id}));
 s.on('device:registered',()=>s.emit('device:heartbeat',{device_id:d.id,client_ms:Date.now(),telemetry:tel(d.i)}));
 setInterval(()=>{if(s.connected)s.emit('device:heartbeat',{device_id:d.id,client_ms:Date.now(),telemetry:tel(d.i)});},9000);
});
console.log('connected',full.length);
setInterval(()=>{},1e9);
