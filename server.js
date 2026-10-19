'use strict';
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 7, MAX_CHASERS = 6, TICK_MS = 50;
const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();
const wrap = a => (a + Math.PI * 2) % (Math.PI * 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rndCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
function send(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { for (const p of room.players) send(p.ws, msg); }
function publicLobby(room) { return { type:'lobby', room:room.code, phase:room.phase, players:room.players.map(p=>({id:p.id,name:p.name,ready:p.ready,role:p.role,carIndex:p.carIndex})), isHost:false }; }
function assignRoles(room) {
  const ps = room.players;
  if (!ps.length) return;
  const driver = ps[room.round % ps.length];
  let carIndex=0;
  for (const p of ps) { if (p===driver) { p.role='trailer'; p.carIndex=null; } else { p.role='chaser'; p.carIndex=carIndex++; } }
  room.driverId=driver.id;
}
function broadcastLobby(room) {
  const base=publicLobby(room);
  for (const p of room.players) send(p.ws,{...base,isHost:p.id===room.hostId});
}
function newRoom(code, mode) { return {code,mode,players:[],hostId:null,phase:'lobby',round:0,time:0,angle:.55,weather:{rain:0,fog:0,cloud:0,wet:0,phase:'CLEAR'},cars:[],lastTick:Date.now(),countdown:null,results:[]}; }
function initRace(room) {
  room.phase='race'; room.time=0; room.angle=.55; room.weather={rain:0,fog:0,cloud:0,wet:0,phase:'CLEAR'};
 room.cars=Array.from({length:MAX_CHASERS},(_,i)=>({x:Math.sin(i*Math.PI/3)*15,z:34+Math.cos(i*Math.PI/3)*15,heading:0,speed:0,boarded:false,touchedRamp:false,score:0,aiPhase:i*1.31}));
  for (const p of room.players) { p.input={}; p.ready=false; send(p.ws,{type:'raceStart',role:p.role,carIndex:p.carIndex,round:room.round}); }
  room.lastTick=Date.now();
}
function finishRace(room) {
  if(room.phase!=='race') return;
  room.phase='results';
  const results=room.players.map(p=>({name:p.name,score:p.role==='trailer'? (room.cars.filter(c=>c.boarded).length===0?100:40): (room.cars[p.carIndex]?.boarded?100:Math.round((room.cars[p.carIndex]?.score||0)))})).sort((a,b)=>b.score-a.score);
  room.results=results; broadcast(room,{type:'snapshot',phase:'results',results,cars:room.cars,trailer:trailerState(room),hauler:haulerState(room),weather:room.weather,time:room.time});
}
function trailerState(room){const a=room.angle;return {x:Math.cos(a)*54,z:Math.sin(a)*33.75,heading:Math.atan2(-54*Math.sin(a),33.75*Math.cos(a))};}
function haulerState(room){const t=trailerState(room);const off={x:Math.sin(room.time*2.4)*4.3,z:-41.04};const h=t.heading;return {x:t.x+off.x*Math.cos(h)-off.z*Math.sin(h),z:t.z+off.x*Math.sin(h)+off.z*Math.cos(h),heading:h};}
function simulate(room,dt){
  room.time+=dt;
  // Same synchronized clear -> clouds -> rain -> mist -> clearing schedule as the game client.
  const cycle=room.time%78;let rain=0,fog=0,cloud=0,phase='CLEAR';
  if(cycle>=10&&cycle<20){cloud=(cycle-10)/10;phase='CLOUDING';}
  else if(cycle>=20&&cycle<39){cloud=1;rain=clamp(cycle<24?(cycle-20)/4:cycle>35?(39-cycle)/4:1,0,1);phase=rain>.6?'HEAVY RAIN':'RAIN STARTING';}
  else if(cycle>=39&&cycle<53){cloud=.85;fog=clamp(cycle<43?(cycle-39)/4:cycle>49?(53-cycle)/4:.85,0,.85);phase='MIST';}
  else if(cycle>=53&&cycle<68){cloud=cycle<60?.6*(1-(cycle-53)/7):0;phase='CLEARING';}
  const damp=(v,t,k)=>v+(t-v)*(1-Math.exp(-k*dt));
  room.weather.rain=damp(room.weather.rain,rain,1.4);room.weather.fog=damp(room.weather.fog,fog,1.1);room.weather.cloud=damp(room.weather.cloud,cloud,1);room.weather.wet=damp(room.weather.wet,rain>.12?1:0,rain>.12?.16:.045);room.weather.phase=phase;
  const wet=room.weather.wet;
  // Driver controls trailer pace and slight lane position. Direction remains the game's established orbit direction.
  const driver=room.players.find(p=>p.id===room.driverId);const di=driver?.input||{};
  const pace=clamp(.22+(di.up?0.09:0)-(di.down?0.11:0),.12,.34);room.angle-=pace*dt;
  const trailer=trailerState(room);
  const humans=new Map(room.players.filter(p=>p.role==='chaser').map(p=>[p.carIndex,p]));
  for(let i=0;i<MAX_CHASERS;i++){
    const c=room.cars[i];if(c.boarded)continue;
    const p=humans.get(i),inp=p?.input||{};
    if(p){
      const throttle=inp.up?1:0,brake=inp.down?1:0,turn=(inp.left?1:0)-(inp.right?1:0);
      c.speed=clamp(c.speed+(throttle*17*(1-wet*.24)-brake*24-c.speed*(.9+wet*.3))*dt,0,14*(1-wet*.08)+(inp.boost?3:0));
      c.heading+=turn*dt*(2+Math.abs(c.speed)*.045)*(1-wet*.22);
    }else{
      c.aiPhase+=dt;const dx=trailer.x-c.x,dz=trailer.z-c.z,dist=Math.hypot(dx,dz);
      const targetHeading=Math.atan2(-dx,-dz);let diff=Math.atan2(Math.sin(targetHeading-c.heading),Math.cos(targetHeading-c.heading));
      c.heading+=clamp(diff,-dt*2.2*(1-wet*.16),dt*2.2*(1-wet*.16));
      const desired=clamp(10.4+Math.sin(c.aiPhase*.8+i)*.45+(dist<20?-2:1)-wet*1.3,4.6,14.2);c.speed+=(desired-c.speed)*(1-Math.exp(-2.4*dt));
    }
    c.x+=-Math.sin(c.heading)*c.speed*dt;c.z+=-Math.cos(c.heading)*c.speed*dt;
    const rad=Math.hypot(c.x/73,c.z/47);if(rad>1){c.x*=.99;c.z*=.99;c.speed*=.7;}
    if(Math.hypot(c.x/8,c.z/5)<1){c.x*=1.03;c.z*=1.03;}
    // Basic server-authoritative ramp/boarding detection, evaluated against the trailer's moving local frame.
    const dx=c.x-trailer.x,dz=c.z-trailer.z,h=trailer.heading;
    const lx=dx*Math.cos(h)-dz*Math.sin(h),lz=dx*Math.sin(h)+dz*Math.cos(h);
    if(Math.abs(lx)<2.05&&lz>6&&lz<11.5)c.touchedRamp=true;
    if(c.touchedRamp&&Math.abs(lx)<3.55&&lz>-7.2&&lz<8.2&&Math.hypot(dx,dz)<9){c.boarded=true;c.speed=0;c.score=100;}
    else c.score=Math.max(c.score,Math.round((1-Math.min(1,Math.hypot(dx,dz)/150))*80));
  }
  if(room.cars.some(c=>c.boarded)||room.time>=100){finishRace(room);return;}
  const hauler=haulerState(room);
  broadcast(room,{type:'snapshot',phase:room.phase,time:room.time,weather:room.weather,trailer,hauler,cars:room.cars.map(c=>({x:c.x,z:c.z,heading:c.heading,speed:c.speed,boarded:c.boarded,score:c.score})),aboard:room.cars.filter(c=>c.boarded).length});
}
function removePlayer(p){const room=p.room;if(!room)return;room.players=room.players.filter(x=>x!==p);p.room=null;if(!room.players.length){rooms.delete(room.code);return;}if(room.hostId===p.id)room.hostId=room.players[0].id;if(room.phase==='race'){room.phase='lobby';room.round++;}assignRoles(room);broadcastLobby(room);}
function enterRoom(p,mode,code){let room;if(mode==='create'){let c;do{c=rndCode()}while(rooms.has(c));room=newRoom(c,'private');rooms.set(c,room);}else if(mode==='join'){room=rooms.get(String(code||'').toUpperCase());if(!room)throw Error('Room code not found.');}else{room=[...rooms.values()].find(r=>r.mode==='public'&&r.phase==='lobby'&&r.players.length<MAX_PLAYERS);if(!room){let c;do{c=rndCode()}while(rooms.has(c));room=newRoom(c,'public');rooms.set(c,room);}}
if(room.players.length>=MAX_PLAYERS)throw Error('Room is full (7 players maximum).');if(room.phase==='race')throw Error('That race has already started.');room.players.push(p);p.room=room;if(!room.hostId)room.hostId=p.id;assignRoles(room);send(p.ws,{type:'joined',room:room.code,playerId:p.id,role:p.role,carIndex:p.carIndex,phase:room.phase,isHost:p.id===room.hostId});broadcastLobby(room);}
function startCountdown(room){if(room.phase!=='lobby')return;room.phase='countdown';let n=3;broadcast(room,{type:'countdown',seconds:n});const t=setInterval(()=>{n--;if(n>0)broadcast(room,{type:'countdown',seconds:n});else{clearInterval(t);if(!room.players.length){room.phase='lobby';return;}initRace(room);}},1000);}
wss.on('connection',ws=>{const p={id:randomUUID(),ws,name:'Racer',ready:false,input:{},room:null};ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}try{
if(m.type==='join'){p.name=String(m.name||'Racer').slice(0,20);enterRoom(p,m.mode||'quick',m.code);return;}
const room=p.room;if(!room){send(ws,{type:'error',message:'Join a room first.'});return;}
if(m.type==='ready'){p.ready=!!m.ready;broadcastLobby(room);}
else if(m.type==='start'){if(p.id!==room.hostId){send(ws,{type:'error',message:'Only the host can start the race.'});return;}if(room.players.some(x=>!x.ready)){send(ws,{type:'error',message:'Everyone must ready up first.'});return;}startCountdown(room);}
else if(m.type==='input'&&room.phase==='race'){const v=m.input||{};p.input={up:!!v.up,down:!!v.down,left:!!v.left,right:!!v.right,boost:!!v.boost,brake:!!v.brake};}
else if(m.type==='rematch'&&room.phase==='results'){room.phase='lobby';room.round++;room.time=0;for(const x of room.players)x.ready=false;assignRoles(room);broadcast(room,{type:'rematch'});broadcastLobby(room);}
else if(m.type==='leave')removePlayer(p);
}catch(e){send(ws,{type:'error',message:e.message||'Request failed.'})}});ws.on('close',()=>removePlayer(p));ws.on('error',()=>removePlayer(p));});
setInterval(()=>{const now=Date.now();for(const room of rooms.values())if(room.phase==='race'){const dt=clamp((now-room.lastTick)/1000,0,.1);room.lastTick=now;simulate(room,dt);}},TICK_MS);
console.log(`Trailer Race multiplayer server listening on ws://localhost:${PORT}`);
