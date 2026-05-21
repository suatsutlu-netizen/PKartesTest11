(function(){
'use strict';

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════
var CELL      = 0.5;
var THR_MS    = 800;
var TRACE_MAX = 2000;
var TL_H      = 52;
var SPD_BUF   = 4;
var FREEZE_KM = 0.3;

// Seuils sonores
var SPD_ROULAGE = 7;   // km/h → annonce vocale
var SPD_MARCHE  = 10;  // km/h → bip + vitesse orange triple

// ═══════════════════════════════════════════════════════════════
// ETAT
// ═══════════════════════════════════════════════════════════════
var S = {
  pos:null, lastProcTs:0,
  capLisse:0, speedBuf:[], speedKmh:0,
  odometre:0, tracePts:[],
  watchId:null, hqGps:true,
  headingUp:true, autoCentre:true, nightMode:false,
  curLigne:null, curPK:null, curVmax:null, curVseg:null,
  sensMarche:0, prevPKval:null, prevPKts:0,
  tlStations:[], tlOffset:0,
  loggedSet:{},
  chronoRun:false, chronoStart:0, chronoElapsed:0,
  journal:[],
  ligneFeats:[],
  garesArr:[], garesIdx:{},
  iteArr:[],   iteIdx:{},
  triArr:[],   triIdx:{},
  vmaxArr:[],
  spatialIdx:{},
  layerVis:{lignes:true,gares:true,ite:true,triages:true,trace:true,vmax:false},
  iFrom:null, iTo:null, iT0:0,
  mapReady:false,
  // Audio state
  audioCtx:null,
  audioUnlocked:false,
  prevSpdZone:0,       // 0=arret, 1=roulage(7-10), 2=marche(>10)
  voiceLastTs:0,       // timestamp derniere annonce vocale
  bipLastTs:0,         // timestamp dernier bip
};

// ═══════════════════════════════════════════════════════════════
// HELPERS DOM
// ═══════════════════════════════════════════════════════════════
function $(id){ return document.getElementById(id); }
function tx(id,v){ var e=$(id); if(e) e.textContent=v; }
function on(id,ev,fn){ var e=$(id); if(e) e.addEventListener(ev,fn); }
function loadPct(p,msg){
  $('loading-bar').style.width=p+'%';
  if(msg) tx('loading-msg',msg);
}
function loadDone(){ $('loading').classList.add('done'); }

// ═══════════════════════════════════════════════════════════════
// AUDIO — Web Audio API, suit le volume systeme Android
// ═══════════════════════════════════════════════════════════════

function getAudioCtx(){
  if(!S.audioCtx){
    try{
      S.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    }catch(e){ console.warn('AudioContext indisponible'); }
  }
  return S.audioCtx;
}

// Deverrouillage audio sur premier geste utilisateur
function unlockAudio(){
  if(S.audioUnlocked) return;
  var ctx=getAudioCtx();
  if(!ctx) return;
  // Jouer un son silencieux de 0.001s pour deverrouiller
  var buf=ctx.createBuffer(1,1,ctx.sampleRate);
  var src=ctx.createBufferSource();
  src.buffer=buf;
  src.connect(ctx.destination);
  src.start(0);
  if(ctx.state==='suspended'){
    ctx.resume().then(function(){ S.audioUnlocked=true; });
  } else {
    S.audioUnlocked=true;
  }
}

// Bip court (880 Hz, 80 ms) — alerte marche >10 km/h
function jouerBip(){
  var ctx=getAudioCtx();
  if(!ctx||ctx.state==='suspended') return;
  var now=ctx.currentTime;
  var osc=ctx.createOscillator();
  var gain=ctx.createGain();
  osc.type='sine';
  osc.frequency.setValueAtTime(880,now);
  gain.gain.setValueAtTime(0.0001,now);
  gain.gain.linearRampToValueAtTime(0.85,now+0.005);  // attaque rapide
  gain.gain.exponentialRampToValueAtTime(0.0001,now+0.08);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now+0.09);
}

// Double bip descendant (alerte retour arret depuis roulage)
function jouerDoubleBip(){
  var ctx=getAudioCtx();
  if(!ctx||ctx.state==='suspended') return;
  var now=ctx.currentTime;
  [0, 0.12].forEach(function(offset, i){
    var osc=ctx.createOscillator();
    var gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(i===0?660:440,now+offset);
    gain.gain.setValueAtTime(0.0001,now+offset);
    gain.gain.linearRampToValueAtTime(0.6,now+offset+0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+offset+0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now+offset);
    osc.stop(now+offset+0.08);
  });
}

// Annonce vocale TTS — suit le volume systeme via speechSynthesis
function parler(texte){
  if(!window.speechSynthesis) return;
  // Annuler toute annonce en cours
  window.speechSynthesis.cancel();
  var utt=new SpeechSynthesisUtterance(texte);
  utt.lang='fr-FR';
  utt.rate=0.92;
  utt.pitch=1.0;
  // Choisir voix francaise si disponible
  var voix=window.speechSynthesis.getVoices();
  for(var i=0;i<voix.length;i++){
    if(voix[i].lang&&voix[i].lang.indexOf('fr')===0){
      utt.voice=voix[i]; break;
    }
  }
  window.speechSynthesis.speak(utt);
}

// Gestion des zones de vitesse et alertes sonores
// Appele a chaque mise a jour GPS
function gererAlertesSonores(kmh){
  var zone = kmh < SPD_ROULAGE ? 0 : kmh < SPD_MARCHE ? 1 : 2;
  var now  = Date.now();

  // --- Zone 1 : 7-10 km/h — annonce vocale ---
  if(zone===1){
    // Annonce si on vient de passer en zone 1, ou toutes les 30s si on y reste
    if(S.prevSpdZone!==1 || (now-S.voiceLastTs>30000)){
      S.voiceLastTs=now;
      parler('Essai de roulage, essai V.A.');
    }
    // Afficher le bandeau
    var b=$('alerte-bande');
    b.textContent='Essai de roulage — Essai V.A.';
    b.classList.add('visible');
  }

  // --- Zone 2 : >10 km/h — bip continu toutes les 4s ---
  if(zone===2){
    // Effacer le bandeau roulage et afficher marche
    var b=$('alerte-bande');
    b.textContent='Marche — '+Math.round(kmh)+' km/h';
    b.classList.add('visible');
    // Bip toutes les 4 secondes
    if(now-S.bipLastTs>4000){
      S.bipLastTs=now;
      jouerBip();
    }
  }

  // --- Retour a l'arret (<7 km/h) ---
  if(zone===0){
    if(S.prevSpdZone>0){
      // Double bip descendant pour signaler l'arret
      jouerDoubleBip();
    }
    $('alerte-bande').classList.remove('visible');
  }

  // Affichage vitesse — taille et couleur dynamiques
  var spdEl=$('spd-val');
  spdEl.textContent=Math.round(kmh);
  if(zone===2){
    spdEl.classList.add('warn');
  } else {
    spdEl.classList.remove('warn');
  }

  S.prevSpdZone=zone;
}

// ═══════════════════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════════════════
var map = new maplibregl.Map({
  container:'map',
  style:{
    version:8,
    sources:{osm:{
      type:'raster',
      tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize:256,
      attribution:'(c) OpenStreetMap contributors'
    }},
    layers:[{id:'osm-tiles',type:'raster',source:'osm'}]
  },
  center:[2.430,48.625], zoom:13, bearing:0
});
map.addControl(new maplibregl.AttributionControl({compact:true}));

// Marqueur flèche GPS
var markerEl=document.createElement('div');
markerEl.style.cssText='width:32px;height:32px;display:flex;align-items:center;justify-content:center;';
markerEl.innerHTML='<svg width="32" height="32" viewBox="0 0 32 32" id="arr-svg">'
  +'<polygon points="16,2 27,29 16,22 5,29" fill="#0284c7" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>'
  +'</svg>';
var arrSvg=markerEl.querySelector('#arr-svg');
var gpsMk=new maplibregl.Marker({element:markerEl,anchor:'center'})
  .setLngLat([2.430,48.625]).addTo(map);

// ═══════════════════════════════════════════════════════════════
// SPATIAL INDEX
// ═══════════════════════════════════════════════════════════════
function cellKey(lat,lon){
  return Math.floor(lat/CELL)+'_'+Math.floor(lon/CELL);
}
function neighbors9(lat,lon){
  var r=Math.floor(lat/CELL),c=Math.floor(lon/CELL),k=[];
  for(var dr=-1;dr<=1;dr++) for(var dc=-1;dc<=1;dc++) k.push((r+dr)+'_'+(c+dc));
  return k;
}
function neighbors25(lat,lon){
  var r=Math.floor(lat/CELL),c=Math.floor(lon/CELL),k=[];
  for(var dr=-2;dr<=2;dr++) for(var dc=-2;dc<=2;dc++) k.push((r+dr)+'_'+(c+dc));
  return k;
}
function idxPt(idx,lat,lon,obj){
  var k=cellKey(lat,lon);
  if(!idx[k]) idx[k]=[];
  idx[k].push(obj);
}
function idxLine(feat){
  var cs=feat.geometry.coordinates,n=cs.length;
  for(var i=0;i<n;i+=5){
    var k=cellKey(cs[i][1],cs[i][0]);
    if(!S.spatialIdx[k]) S.spatialIdx[k]=[];
    var a=S.spatialIdx[k],f=false;
    for(var j=0;j<a.length;j++) if(a[j]===feat){f=true;break;}
    if(!f) a.push(feat);
  }
  var k2=cellKey(cs[n-1][1],cs[n-1][0]);
  if(!S.spatialIdx[k2]) S.spatialIdx[k2]=[];
  var a2=S.spatialIdx[k2],f2=false;
  for(var j2=0;j2<a2.length;j2++) if(a2[j2]===feat){f2=true;break;}
  if(!f2) a2.push(feat);
}

// ═══════════════════════════════════════════════════════════════
// GEOMETRIE
// ═══════════════════════════════════════════════════════════════
function hav(la1,lo1,la2,lo2){
  var R=6371000,p1=la1*Math.PI/180,p2=la2*Math.PI/180;
  var dp=(la2-la1)*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;
  var a=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function brng(la1,lo1,la2,lo2){
  var p1=la1*Math.PI/180,p2=la2*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;
  var y=Math.sin(dl)*Math.cos(p2);
  var x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}
function capCard(d){return['N','NE','E','SE','S','SO','O','NO'][Math.round(d/45)%8];}
function aDiff(a,b){var d=((b-a)%360+360)%360;return d>180?d-360:d;}
function parsePK(s){
  if(!s) return NaN;
  s=String(s).trim();
  var m=s.match(/^(\d+)\+(\d+)$/);
  if(m) return parseFloat(m[1])+parseFloat(m[2])/1000;
  return parseFloat(s)||0;
}
function fmtPK(pk){
  if(pk==null||isNaN(pk)) return '--+---';
  var km=Math.floor(pk),m=Math.round((pk-km)*1000);
  return km+'+'+('000'+m).slice(-3);
}
function normCL(s){
  return String(parseInt(String(s||'0'),10)||0);
}
function ptSegT(px,py,ax,ay,bx,by){
  var dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
  if(l2===0) return 0;
  var t=((px-ax)*dx+(py-ay)*dy)/l2;
  return t<0?0:t>1?1:t;
}
function ptSegDist(px,py,ax,ay,bx,by){
  var t=ptSegT(px,py,ax,ay,bx,by);
  return Math.hypot(px-(ax+t*(bx-ax)),py-(ay+t*(by-ay)));
}

// ═══════════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════════
function parseCSV(txt,sep){
  var lines=txt.replace(/\r/g,'').split('\n');
  if(lines.length<2) return [];
  var hdrs=lines[0].replace(/^\uFEFF/,'').split(sep);
  for(var i=0;i<hdrs.length;i++) hdrs[i]=hdrs[i].trim();
  var out=[];
  for(var r=1;r<lines.length;r++){
    if(!lines[r].trim()) continue;
    var v=lines[r].split(sep),o={};
    for(var c=0;c<hdrs.length;c++) o[hdrs[c]]=(v[c]||'').trim();
    out.push(o);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// CHARGEMENT DONNEES
// ═══════════════════════════════════════════════════════════════
function loadAll(){
  loadPct(5,'Chargement des donnees...');
  Promise.allSettled([
    fetch('formes-des-lignes-du-rfn.geojson').then(function(r){return r.json();}),
    fetch('liste-des-gares.csv').then(function(r){return r.text();}),
    fetch('liste-des-installations-terminales-embranchees.csv').then(function(r){return r.text();}),
    fetch('liste-des-triages.csv').then(function(r){return r.text();}),
    fetch('vitesse-maximale-nominale-sur-ligne.csv').then(function(r){return r.text();}),
  ]).then(function(res){
    var gj=null;

    loadPct(20,'Index des lignes...');
    if(res[0].status==='fulfilled'){
      gj=res[0].value;
      S.ligneFeats=gj.features.filter(function(f){return f.geometry&&f.geometry.type==='LineString';});
      for(var i=0;i<S.ligneFeats.length;i++) idxLine(S.ligneFeats[i]);
    } else console.warn('GeoJSON manquant — servir via HTTP, pas file://');

    loadPct(40,'Gares...');
    if(res[1].status==='fulfilled'){
      var rows=parseCSV(res[1].value,';');
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var lon=parseFloat(r.X_WGS84),lat=parseFloat(r.Y_WGS84),pk=parsePK(r.PK);
        if(isNaN(lon)||isNaN(lat)||isNaN(pk)) continue;
        r._lon=lon;r._lat=lat;r._pk=pk;r._type='gare';
        r._voy=(r.VOYAGEURS||'').toUpperCase()==='O';
        r._fret=(r.FRET||'').toUpperCase()==='O';
        if(!r.IDGAIA) r.IDGAIA='g_'+r.CODE_UIC;
        S.garesArr.push(r); idxPt(S.garesIdx,lat,lon,r);
      }
    }

    loadPct(55,'ITE...');
    if(res[2].status==='fulfilled'){
      var rows=parseCSV(res[2].value,';');
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var lon=parseFloat(r.X_WGS84),lat=parseFloat(r.Y_WGS84);
        if(isNaN(lon)||isNaN(lat)) continue;
        r._lon=lon;r._lat=lat;r._pk=parsePK(r.PK);r._type='ite';
        r.LIBELLE=r.GARE||'ITE';
        if(!r.IDGAIA) r.IDGAIA='i_'+r.CODE_LIGNE+'_'+r.PK;
        S.iteArr.push(r); idxPt(S.iteIdx,lat,lon,r);
      }
    }

    loadPct(65,'Triages...');
    if(res[3].status==='fulfilled'){
      var rows=parseCSV(res[3].value,';');
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var lon=parseFloat(r.X_WGS84),lat=parseFloat(r.Y_WGS84);
        if(isNaN(lon)||isNaN(lat)) continue;
        r._lon=lon;r._lat=lat;r._pk=parsePK(r.PK);r._type='triage';
        if(!r.IDGAIA) r.IDGAIA='t_'+r.CODE_LIGNE+'_'+r.PK;
        S.triArr.push(r); idxPt(S.triIdx,lat,lon,r);
      }
    }

    loadPct(78,'Vitesses...');
    if(res[4].status==='fulfilled'){
      var rows=parseCSV(res[4].value,';');
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var xd=parseFloat(r.X_D_WGS84),yd=parseFloat(r.Y_D_WGS84);
        var xf=parseFloat(r.X_F_WGS84),yf=parseFloat(r.Y_F_WGS84);
        if(isNaN(xd)||isNaN(yd)||isNaN(xf)||isNaN(yf)) continue;
        var pkd=parsePK(r.PKD),pkf=parsePK(r.PKF);
        if(isNaN(pkd)||isNaN(pkf)) continue;
        S.vmaxArr.push({cl:normCL(r.CODE_LIGNE),lib:r.LIB_LIGNE||'',
          vmax:parseInt(r.V_MAX)||0,pkd:pkd,pkf:pkf,
          lonD:xd,latD:yd,lonF:xf,latF:yf});
      }
    }

    loadPct(90,'Carte...');
    whenMapReady(function(){ initLayers(gj); });
  });
}

function whenMapReady(fn){
  if(S.mapReady) fn();
  else map.once('load',fn);
}
map.on('load',function(){ S.mapReady=true; });

// ═══════════════════════════════════════════════════════════════
// CALQUES CARTE
// ═══════════════════════════════════════════════════════════════
var LAYER_DEFS=[
  {key:'lignes',  ids:['lignes-l'],              name:'Voies ferrees',  desc:'Reseau ferre national'},
  {key:'gares',   ids:['gvoy-l','gfret-l','glbl-l'], name:'Gares',     desc:'Voyageurs (bleu) + Fret (gris)'},
  {key:'ite',     ids:['ite-l','ite-lbl'],       name:'ITE',            desc:'Install. terminales embranchees'},
  {key:'triages', ids:['tri-l','tri-lbl'],       name:'Triages',        desc:'Triages fret'},
  {key:'vmax',    ids:['vmax-l','vmax-lbl'],     name:'Vitesses ligne', desc:'Segments Vmax colores'},
  {key:'trace',   ids:['trace-l'],               name:'Trace GPS',      desc:'Trajet en cours'},
];
function visProp(key){ return S.layerVis[key]?'visible':'none'; }
function applyVis(){
  for(var i=0;i<LAYER_DEFS.length;i++){
    var def=LAYER_DEFS[i];
    for(var j=0;j<def.ids.length;j++){
      try{ map.setLayoutProperty(def.ids[j],'visibility',visProp(def.key)); }catch(e){}
    }
  }
}
function mkGJ(arr,propFn){
  var feats=[];
  for(var i=0;i<arr.length;i++){
    var r=arr[i];
    feats.push({type:'Feature',geometry:{type:'Point',coordinates:[r._lon,r._lat]},properties:propFn(r)});
  }
  return {type:'FeatureCollection',features:feats};
}

function initLayers(gj){
  if(gj){
    map.addSource('lignes',{type:'geojson',data:gj});
    map.addLayer({id:'lignes-l',type:'line',source:'lignes',
      layout:{visibility:visProp('lignes')},
      paint:{'line-color':'#16a34a',
        'line-width':['interpolate',['linear'],['zoom'],6,1,10,2.5,14,4.5]}
    });
  }

  // Gares
  var gjG=mkGJ(S.garesArr,function(r){return{name:r.LIBELLE||'',pk:r.PK||'',
    ligne:r.CODE_LIGNE||'',voy:r._voy?1:0,fret:r._fret?1:0};});
  map.addSource('gares',{type:'geojson',data:gjG});
  map.addLayer({id:'gvoy-l',type:'circle',source:'gares',
    filter:['==',['get','voy'],1],layout:{visibility:visProp('gares')},
    paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,1.5,9,3,13,6,16,9],
      'circle-color':'#3b82f6','circle-stroke-color':'#93c5fd',
      'circle-stroke-width':['interpolate',['linear'],['zoom'],8,0,12,1]}
  });
  map.addLayer({id:'gfret-l',type:'circle',source:'gares',
    filter:['all',['==',['get','voy'],0],['==',['get','fret'],1]],
    layout:{visibility:visProp('gares')},
    paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,1,9,2,13,4,16,6],
      'circle-color':'#6b7280','circle-stroke-color':'#9ca3af','circle-stroke-width':0.5}
  });
  map.addLayer({id:'glbl-l',type:'symbol',source:'gares',minzoom:12,
    layout:{visibility:visProp('gares'),'text-field':['get','name'],
      'text-size':['interpolate',['linear'],['zoom'],12,8,15,11],
      'text-anchor':'top','text-offset':[0,0.6],'text-allow-overlap':false},
    paint:{'text-color':'#e5e7eb','text-halo-color':'#000','text-halo-width':1}
  });

  // ITE
  var gjI=mkGJ(S.iteArr,function(r){return{name:r.LIBELLE||'',pk:r.PK||'',ligne:r.CODE_LIGNE||''};});
  map.addSource('ite',{type:'geojson',data:gjI});
  map.addLayer({id:'ite-l',type:'circle',source:'ite',
    layout:{visibility:visProp('ite')},
    paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,1,9,2.5,13,5,16,7],
      'circle-color':'#8b5cf6','circle-stroke-color':'#c4b5fd','circle-stroke-width':0.8}
  });
  map.addLayer({id:'ite-lbl',type:'symbol',source:'ite',minzoom:13,
    layout:{visibility:visProp('ite'),'text-field':['get','name'],'text-size':8,
      'text-anchor':'top','text-offset':[0,0.5],'text-allow-overlap':false},
    paint:{'text-color':'#c4b5fd','text-halo-color':'#000','text-halo-width':1}
  });

  // Triages
  var gjT=mkGJ(S.triArr,function(r){return{name:r.LIBELLE||'',pk:r.PK||'',ligne:r.CODE_LIGNE||''};});
  map.addSource('triages',{type:'geojson',data:gjT});
  map.addLayer({id:'tri-l',type:'circle',source:'triages',
    layout:{visibility:visProp('triages')},
    paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,2,9,3.5,13,6,16,9],
      'circle-color':'#f97316','circle-stroke-color':'#fed7aa','circle-stroke-width':1}
  });
  map.addLayer({id:'tri-lbl',type:'symbol',source:'triages',minzoom:11,
    layout:{visibility:visProp('triages'),'text-field':['get','name'],'text-size':9,
      'text-anchor':'top','text-offset':[0,0.6],'text-allow-overlap':false},
    paint:{'text-color':'#fb923c','text-halo-color':'#000','text-halo-width':1}
  });

  // Vmax
  if(S.vmaxArr.length){
    var vf=[];
    for(var i=0;i<S.vmaxArr.length;i++){
      var v=S.vmaxArr[i],spd=v.vmax;
      var col=spd>=220?'#b91c1c':spd>=160?'#ef4444':spd>=120?'#f97316':spd>=80?'#fbbf24':'#16a34a';
      vf.push({type:'Feature',
        geometry:{type:'LineString',coordinates:[[v.lonD,v.latD],[v.lonF,v.latF]]},
        properties:{vmax:spd,color:col,ligne:v.cl}});
    }
    map.addSource('vmax',{type:'geojson',data:{type:'FeatureCollection',features:vf}});
    var bef=map.getLayer('lignes-l')?'lignes-l':undefined;
    map.addLayer({id:'vmax-l',type:'line',source:'vmax',
      layout:{visibility:'none'},
      paint:{'line-color':['get','color'],
        'line-width':['interpolate',['linear'],['zoom'],7,1.5,12,3.5,15,5.5],
        'line-opacity':0.85}
    },bef);
    map.addLayer({id:'vmax-lbl',type:'symbol',source:'vmax',minzoom:12,
      layout:{visibility:'none','text-field':['concat',['to-string',['get','vmax']],' km/h'],
        'text-size':9,'symbol-placement':'line','text-allow-overlap':false},
      paint:{'text-color':'#fff','text-halo-color':'#000','text-halo-width':1}
    });
  }

  // Trace
  map.addSource('trace',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:[]}}});
  map.addLayer({id:'trace-l',type:'line',source:'trace',
    layout:{visibility:visProp('trace')},
    paint:{'line-color':'#22d3ee','line-width':2}
  });

  buildLayerPanel();
  loadPct(100,'Pret');
  setTimeout(loadDone,400);
  startGPS();
}

// ═══════════════════════════════════════════════════════════════
// PANNEAU CALQUES
// ═══════════════════════════════════════════════════════════════
function buildLayerPanel(){
  var body=$('layers-body');
  body.innerHTML='';
  for(var i=0;i<LAYER_DEFS.length;i++){
    (function(def){
      var row=document.createElement('div');
      row.className='layer-row';
      var cid='tog-'+def.key;
      row.innerHTML='<div><div class="layer-name">'+def.name+'</div>'
        +'<div class="layer-desc">'+def.desc+'</div></div>'
        +'<label class="toggle"><input type="checkbox" id="'+cid+'"'
        +(S.layerVis[def.key]?' checked':'')+'><span class="slider"></span></label>';
      body.appendChild(row);
      row.querySelector('#'+cid).addEventListener('change',function(){
        S.layerVis[def.key]=this.checked; applyVis();
      });
    })(LAYER_DEFS[i]);
  }
}

// ═══════════════════════════════════════════════════════════════
// RECHERCHE LIGNE + PK
// ═══════════════════════════════════════════════════════════════
function findLine(lat,lon){
  if(!S.ligneFeats.length) return null;
  var keys=neighbors9(lat,lon),cands=[];
  for(var ki=0;ki<keys.length;ki++){
    var arr=S.spatialIdx[keys[ki]];
    if(!arr) continue;
    for(var fi=0;fi<arr.length;fi++){
      var f=arr[fi],found=false;
      for(var ci=0;ci<cands.length;ci++) if(cands[ci]===f){found=true;break;}
      if(!found) cands.push(f);
    }
  }
  if(!cands.length) return null;

  var top=[];
  for(var fi=0;fi<cands.length;fi++){
    var feat=cands[fi],cs=feat.geometry.coordinates;
    for(var si=0;si<cs.length-1;si++){
      var ax=cs[si][0],ay=cs[si][1],bx=cs[si+1][0],by=cs[si+1][1];
      var dd=ptSegDist(lon,lat,ax,ay,bx,by)*111320;
      var entry={feat:feat,si:si,dd:dd,t:ptSegT(lon,lat,ax,ay,bx,by)};
      if(top.length<3){ top.push(entry); top.sort(function(a,b){return a.dd-b.dd;}); }
      else if(dd<top[2].dd){ top[2]=entry; top.sort(function(a,b){return a.dd-b.dd;}); }
    }
  }
  if(!top.length) return null;

  var res=[];
  for(var i=0;i<top.length;i++){
    var e=top[i],p=e.feat.properties;
    var pkDeb=parsePK(p.pk_debut_r),pkFin=parsePK(p.pk_fin_r);
    var cs=e.feat.geometry.coordinates,cum=0,total=0;
    for(var j=0;j<cs.length-1;j++){
      var d=hav(cs[j][1],cs[j][0],cs[j+1][1],cs[j+1][0]);
      if(j<e.si) cum+=d; total+=d;
    }
    var sl=hav(cs[e.si][1],cs[e.si][0],cs[e.si+1][1],cs[e.si+1][0]);
    var ratio=total>0?(cum+e.t*sl)/total:0;
    res.push({pk:pkDeb+ratio*(pkFin-pkDeb),cl:p.code_ligne,lib:p.libelle,dd:e.dd});
  }
  var wS=0,pkS=0;
  for(var i=0;i<res.length;i++){var w=res[i].dd>0?1/res[i].dd:1e9;wS+=w;pkS+=w*res[i].pk;}
  return{pk:wS>0?pkS/wS:res[0].pk,cl:res[0].cl,lib:res[0].lib,dd:res[0].dd};
}

// ═══════════════════════════════════════════════════════════════
// VMAX
// ═══════════════════════════════════════════════════════════════
function findVmax(cl,pk){
  if(!S.vmaxArr.length||!cl||pk==null) return null;
  var ncl=normCL(cl);
  for(var i=0;i<S.vmaxArr.length;i++){
    var v=S.vmaxArr[i];
    if(v.cl!==ncl) continue;
    var lo=v.pkd<v.pkf?v.pkd:v.pkf,hi=v.pkd>v.pkf?v.pkd:v.pkf;
    if(pk>=lo&&pk<=hi) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// GARES PROCHES
// ═══════════════════════════════════════════════════════════════
function gatherStations(lat,lon,cl,curPK){
  var ncl=normCL(cl),keys=neighbors25(lat,lon),seen={},pts=[];
  function addFrom(idx){
    for(var ki=0;ki<keys.length;ki++){
      var arr=idx[keys[ki]]; if(!arr) continue;
      for(var i=0;i<arr.length;i++){
        var r=arr[i];
        if(seen[r.IDGAIA]) continue;
        if(normCL(r.CODE_LIGNE)!==ncl) continue;
        seen[r.IDGAIA]=true; pts.push(r);
      }
    }
  }
  addFrom(S.garesIdx); addFrom(S.iteIdx); addFrom(S.triIdx);
  if(!pts.length){
    var arrs=[S.garesArr,S.iteArr,S.triArr];
    for(var ai=0;ai<arrs.length;ai++){
      for(var i=0;i<arrs[ai].length;i++){
        var r=arrs[ai][i];
        if(normCL(r.CODE_LIGNE)===ncl&&!seen[r.IDGAIA]){seen[r.IDGAIA]=true;pts.push(r);}
      }
    }
  }
  pts.sort(function(a,b){return Math.abs(a._pk-curPK)-Math.abs(b._pk-curPK);});
  if(pts.length>20) pts=pts.slice(0,20);
  for(var i=0;i<pts.length;i++) pts[i]._dist=hav(lat,lon,pts[i]._lat,pts[i]._lon);
  return pts;
}

// ═══════════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════════
function startGPS(){
  if(S.watchId!=null) navigator.geolocation.clearWatch(S.watchId);
  var opts=S.hqGps
    ?{enableHighAccuracy:true,maximumAge:0,timeout:8000}
    :{enableHighAccuracy:false,maximumAge:2000,timeout:15000};
  S.watchId=navigator.geolocation.watchPosition(onGPS,function(e){
    console.warn('GPS err:',e.code,e.message);
  },opts);
}

function onGPS(pos){
  var now=Date.now();
  var lo=pos.coords.longitude,la=pos.coords.latitude;
  if(S.pos){S.iFrom=[S.pos.lon,S.pos.lat];S.iTo=[lo,la];S.iT0=now;requestAnimationFrame(animInterp);}
  if(now-S.lastProcTs<THR_MS) return;
  S.lastProcTs=now;
  procGPS(pos);
}

function procGPS(pos){
  var lat=pos.coords.latitude,lon=pos.coords.longitude,acc=pos.coords.accuracy;
  var now=Date.now();

  // Vitesse
  var spd=0;
  if(S.pos){
    var d=hav(S.pos.lat,S.pos.lon,lat,lon),dt=(now-S.pos.ts)/1000;
    if(dt>0) spd=(d/dt)*3.6;
  }
  S.speedBuf.push(spd);
  if(S.speedBuf.length>SPD_BUF) S.speedBuf.shift();
  var s=0; for(var i=0;i<S.speedBuf.length;i++) s+=S.speedBuf[i];
  S.speedKmh=s/S.speedBuf.length;

  // Cap
  if(S.pos){
    var rc=brng(S.pos.lat,S.pos.lon,lat,lon);
    S.capLisse=(S.capLisse+0.3*aDiff(S.capLisse,rc)+360)%360;
  }

  // Odometrie
  if(S.pos) S.odometre+=hav(S.pos.lat,S.pos.lon,lat,lon)/1000;

  S.pos={lat:lat,lon:lon,ts:now};
  gpsMk.setLngLat([lon,lat]);

  // Trace
  S.tracePts.push([lon,lat]);
  if(S.tracePts.length>TRACE_MAX) S.tracePts.shift();
  try{ map.getSource('trace').setData({type:'Feature',geometry:{type:'LineString',coordinates:S.tracePts}}); }catch(e){}

  // Camera
  if(S.autoCentre){
    var opts={center:[lon,lat],duration:350};
    if(S.headingUp) opts.bearing=S.capLisse;
    map.easeTo(opts);
  }
  arrSvg.style.transform=S.headingUp?'':'rotate('+S.capLisse+'deg)';

  // Alertes sonores (appel systematique)
  gererAlertesSonores(S.speedKmh);

  // Ligne
  var info=findLine(lat,lon);
  if(info){
    S.curLigne=info.cl; S.curPK=info.pk;
    detectSens(info.pk);
    var vseg=findVmax(info.cl,info.pk);
    S.curVmax=vseg?vseg.vmax:null; S.curVseg=vseg;
    updateHdr(info,acc);
    renderTL(lat,lon);
  }

  tx('b-cap',Math.round(S.capLisse)+' '+capCard(S.capLisse));
  tx('b-voie','voie '+(info?Math.round(info.dd):'--')+'m');
  tx('b-odo',S.odometre.toFixed(1)+' km');
  var ga=$('b-gps');
  ga.textContent='GPS '+Math.round(acc)+'m';
  ga.className='b '+(acc<15?'gr':acc<40?'or':'rd');
}

// ═══════════════════════════════════════════════════════════════
// SENS DE MARCHE
// ═══════════════════════════════════════════════════════════════
function detectSens(pk){
  var now=Date.now();
  if(S.prevPKval!==null&&now-S.prevPKts<15000){
    var d=pk-S.prevPKval;
    if(Math.abs(d)>0.005) S.sensMarche=d>0?1:-1;
  }
  S.prevPKval=pk; S.prevPKts=now;
}

// ═══════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════
function updateHdr(info,acc){
  var pkel=$('pk-el');
  pkel.textContent='PK '+fmtPK(info.pk);
  if(S.curVmax&&S.speedKmh>S.curVmax+2){pkel.classList.add('blink');doFlash();}
  else pkel.classList.remove('blink');
  $('ligne-el').textContent='L'+info.cl+(info.lib?' - '+info.lib.slice(0,28):'');
  var bv=$('b-vmax'),bs=$('b-seg');
  if(S.curVmax){
    var pct=Math.min(100,S.speedKmh/S.curVmax*100);
    $('vmx-wrap').style.display='block';
    $('vmx-bar').style.width=pct+'%';
    $('vmx-bar').style.background=pct<80?'#16a34a':pct<100?'#f97316':'#ef4444';
    bv.style.display=''; bv.textContent='Vmax '+S.curVmax;
    bv.className='b '+(pct<80?'gr':pct<100?'or':'rd');
    if(S.curVseg){
      bs.style.display='';
      bs.textContent=fmtPK(S.curVseg.pkd)+' '+fmtPK(S.curVseg.pkf);
      bs.className='b bg';
    }
  } else { bv.style.display='none'; bs.style.display='none'; }
}

function doFlash(){
  var el=$('flash');
  el.style.opacity='0.28';
  clearTimeout(doFlash._t);
  doFlash._t=setTimeout(function(){el.style.opacity='0';},400);
}

// ═══════════════════════════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════════════════════════
var tlRaf=null,tlLast=0;

function renderTL(lat,lon){
  if(!S.curLigne||S.curPK==null) return;
  S.tlStations=gatherStations(lat,lon,S.curLigne,S.curPK);
  var sb=$('sens-b');
  if(S.sensMarche>0){sb.textContent='Impair V1';sb.className='b bl';}
  else if(S.sensMarche<0){sb.textContent='Pair V2';sb.className='b yw';}
  else{sb.textContent='--';sb.className='b bg';}
  drawTL(lat,lon);
  if(!tlRaf) tlRaf=requestAnimationFrame(animTL);
}

function drawTL(lat,lon){
  var track=$('tl-track');
  var items=track.querySelectorAll('.si');
  for(var i=0;i<items.length;i++) items[i].parentNode.removeChild(items[i]);
  if(!S.tlStations.length) return;
  var body=$('tl-body'),centerY=body.offsetHeight/2;
  var ordered=S.tlStations.slice();
  if(S.sensMarche>=0) ordered.sort(function(a,b){return a._pk-b._pk;});
  else ordered.sort(function(a,b){return b._pk-a._pk;});
  var curIdx=0,minD=Infinity;
  for(var i=0;i<ordered.length;i++){
    var d=Math.abs(ordered[i]._pk-S.curPK);
    if(d<minD){minD=d;curIdx=i;}
  }
  for(var i=0;i<ordered.length;i++){
    var g=ordered[i],el=document.createElement('div');
    el.className='si';
    var dm=g._dist;
    var dtxt=dm<1000?Math.round(dm)+'m':(dm/1000).toFixed(1)+'km';
    var dcls=dm<100?'vnear':dm<500?'near':'';
    var pkd=g._pk-S.curPK;
    var passed=S.sensMarche>=0?pkd<0:pkd>0;
    var frozen=Math.abs(pkd)<FREEZE_KM;
    el.style.top=(centerY+(i-curIdx)*TL_H-TL_H/2)+'px';
    var typeL=g._type==='ite'?'ITE':g._type==='triage'?'TRIAGE':'GARE';
    var extra=g._type==='gare'?(g._voy?' [V]':'')+(g._fret?' [F]':''):'';
    el.innerHTML='<div class="si-dot"></div>'
      +'<div class="si-info">'
      +'<div class="si-name">'+(g.LIBELLE||'--')+extra+'</div>'
      +'<div class="si-pk">'+(g.PK||'')+'</div>'
      +'<div class="si-dist '+dcls+'">'+dtxt
      +' <span class="si-type '+g._type+'">'+typeL+'</span></div>'
      +'</div>';
    if(frozen){
      el.classList.add('frozen');
      if(!S.loggedSet[g.IDGAIA]&&Math.abs(pkd)<0.05){
        logStation(g); S.loggedSet[g.IDGAIA]=true;
      }
    } else { delete S.loggedSet[g.IDGAIA]; }
    if(passed&&!frozen) el.classList.add('passed');
    track.appendChild(el);
  }
}

function animTL(ts){
  tlRaf=null; if(!S.pos) return;
  var dt=ts-(tlLast||ts); tlLast=ts;
  S.tlOffset+=(S.sensMarche>=0?-1:1)*S.speedKmh*0.5*(dt/1000);
  if(Math.abs(S.tlOffset)>=TL_H){
    S.tlOffset=S.tlOffset%TL_H;
    if(S.pos&&S.curLigne) drawTL(S.pos.lat,S.pos.lon);
  }
  $('tl-track').style.transform='translateY('+S.tlOffset+'px)';
  tlRaf=requestAnimationFrame(animTL);
}

// ═══════════════════════════════════════════════════════════════
// JOURNAL
// ═══════════════════════════════════════════════════════════════
function logStation(g){
  S.journal.push({
    heure:new Date().toTimeString().slice(0,8),
    gare:g.LIBELLE||'--',pk:fmtPK(g._pk),type:g._type||'gare',
    vitesse:Math.round(S.speedKmh),odometre:S.odometre.toFixed(2),
    ligne:g.CODE_LIGNE||'--',vmax:S.curVmax||'--'
  });
  refreshLog();
}
function refreshLog(){
  var list=$('log-list');
  if(!S.journal.length){
    list.innerHTML='<p style="color:#6b7280;padding:12px;font-size:12px">Aucune entree.</p>';
    return;
  }
  var html='';
  for(var i=S.journal.length-1;i>=0;i--){
    var e=S.journal[i];
    html+='<div class="log-e"><span class="lt">'+e.heure+'</span> '
      +'<span class="lg">'+e.gare+'</span>'
      +' <span class="lt">['+e.type.toUpperCase()+']</span><br>'
      +'<span class="ld">PK '+e.pk+' - '+e.vitesse+' km/h - '+e.odometre
      +' km - L'+e.ligne+(e.vmax!=='--'?' - Vmax '+e.vmax:'')+'</span></div>';
  }
  list.innerHTML=html;
}

// ═══════════════════════════════════════════════════════════════
// INTERPOLATION MARQUEUR
// ═══════════════════════════════════════════════════════════════
function animInterp(){
  if(!S.iFrom||!S.iTo) return;
  var t=Math.min(1,(Date.now()-S.iT0)/THR_MS);
  gpsMk.setLngLat([S.iFrom[0]+t*(S.iTo[0]-S.iFrom[0]),S.iFrom[1]+t*(S.iTo[1]-S.iFrom[1])]);
  if(S.autoCentre) map.setCenter([S.iFrom[0]+t*(S.iTo[0]-S.iFrom[0]),S.iFrom[1]+t*(S.iTo[1]-S.iFrom[1])]);
  if(t<1) requestAnimationFrame(animInterp);
}

// ═══════════════════════════════════════════════════════════════
// HORLOGE + CHRONO
// ═══════════════════════════════════════════════════════════════
setInterval(function(){
  tx('clock-el',new Date().toTimeString().slice(0,8));
  if(S.chronoRun) tx('chrono-el',msHMS(S.chronoElapsed+(Date.now()-S.chronoStart)));
},1000);
function msHMS(ms){
  var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;
  return pad(h)+':'+pad(m)+':'+pad(sc);
}
function pad(n){return n<10?'0'+n:''+n;}

// ═══════════════════════════════════════════════════════════════
// WAKE LOCK
// ═══════════════════════════════════════════════════════════════
function reqWL(){try{navigator.wakeLock&&navigator.wakeLock.request('screen');}catch(e){}}
reqWL();
document.addEventListener('visibilitychange',function(){if(!document.hidden)reqWL();});

// ═══════════════════════════════════════════════════════════════
// EVENEMENTS CARTE
// ═══════════════════════════════════════════════════════════════
map.on('dragstart',function(e){
  if(e.originalEvent){S.autoCentre=false;$('btn-ctr').style.display='flex';}
});
map.on('zoomstart',function(e){
  if(e.originalEvent){S.autoCentre=false;$('btn-ctr').style.display='flex';}
});

// ═══════════════════════════════════════════════════════════════
// BOUTONS
// ═══════════════════════════════════════════════════════════════

// Deverrouillage audio sur premier toucher n'importe ou
document.addEventListener('touchstart',unlockAudio,{once:true});
document.addEventListener('click',unlockAudio,{once:true});

on('btn-hup','click',function(){
  S.headingUp=!S.headingUp;
  tx('btn-hup',S.headingUp?'Heading N':'Nord fixe');
  if(!S.headingUp){map.easeTo({bearing:0,duration:400});arrSvg.style.transform='rotate('+S.capLisse+'deg)';}
  else arrSvg.style.transform='';
});
on('btn-ctr','click',function(){
  S.autoCentre=true;$('btn-ctr').style.display='none';
  if(S.pos){var o={center:[S.pos.lon,S.pos.lat],duration:400};if(S.headingUp)o.bearing=S.capLisse;map.easeTo(o);}
});
on('btn-night','click',function(){
  S.nightMode=!S.nightMode;
  $('map').style.filter=S.nightMode?'brightness(0.45)':'';
  document.body.style.background=S.nightMode?'#000':'#0a0a0a';
  tx('btn-night',S.nightMode?'Jour':'Nuit');
  this.classList.toggle('on',S.nightMode);
});
on('btn-reset','click',function(){
  navigator.geolocation.clearWatch(S.watchId); S.watchId=null;
  S.pos=null;S.lastProcTs=0;S.capLisse=0;S.speedBuf=[];S.speedKmh=0;
  S.odometre=0;S.tracePts=[];S.journal=[];S.loggedSet={};
  S.chronoRun=false;S.chronoElapsed=0;S.prevPKval=null;S.sensMarche=0;S.tlOffset=0;
  S.prevSpdZone=0;S.voiceLastTs=0;S.bipLastTs=0;
  tx('chrono-el','00:00:00');tx('btn-chr','DEPART');
  tx('b-odo','0.0 km');tx('pk-el','PK --+---');
  $('spd-val').textContent='--';$('spd-val').classList.remove('warn');
  $('alerte-bande').classList.remove('visible');
  try{map.getSource('trace').setData({type:'Feature',geometry:{type:'LineString',coordinates:[]}});}catch(e){}
  refreshLog(); startGPS();
});
on('btn-hq','click',function(){
  S.hqGps=!S.hqGps;
  tx('btn-hq',S.hqGps?'GPS HQ':'GPS STD');
  this.classList.toggle('on',S.hqGps);
  navigator.geolocation.clearWatch(S.watchId); startGPS();
});
on('btn-log','click',function(){$('log-panel').classList.add('open');});
on('log-close','click',function(){$('log-panel').classList.remove('open');});
on('btn-layers','click',function(){$('layers-panel').classList.add('open');});
on('layers-close','click',function(){$('layers-panel').classList.remove('open');});
on('btn-exp','click',function(){
  if(!S.journal.length){alert('Aucune donnee.');return;}
  var hdrs='heure,gare,type,pk,vitesse_kmh,odometre_km,ligne,vmax\n',rows='';
  for(var i=0;i<S.journal.length;i++){
    var e=S.journal[i];
    rows+=e.heure+',"'+e.gare+'",'+e.type+','+e.pk+','+e.vitesse+','+e.odometre+','+e.ligne+','+e.vmax+'\n';
  }
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([hdrs+rows],{type:'text/csv'}));
  a.download='trajet_rfn_'+new Date().toISOString().slice(0,10)+'.csv'; a.click();
});
on('btn-chr','click',function(){
  if(!S.chronoRun){S.chronoRun=true;S.chronoStart=Date.now()-S.chronoElapsed;tx('btn-chr','STOP');}
  else{S.chronoRun=false;S.chronoElapsed=Date.now()-S.chronoStart;tx('btn-chr','DEPART');}
});

// ═══════════════════════════════════════════════════════════════
// PWA
// ═══════════════════════════════════════════════════════════════
var deferredPrompt=null;
window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault(); deferredPrompt=e;
  $('install-banner').classList.remove('hidden');
});
on('btn-install','click',function(){
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(function(){
    $('install-banner').classList.add('hidden'); deferredPrompt=null;
  });
});
on('btn-install-dismiss','click',function(){$('install-banner').classList.add('hidden');});

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════════════════════════
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(function(e){console.warn('SW:',e);});
}

// ═══════════════════════════════════════════════════════════════
// DEMO (si GPS absent/refuse apres 10s)
// ═══════════════════════════════════════════════════════════════
function startDemo(){
  console.log('Mode demo actif');
  var path=[
    [48.8445,2.3735],[48.8380,2.3692],[48.8300,2.3645],
    [48.8220,2.3601],[48.8140,2.3560],[48.8060,2.3521],
    [48.7980,2.3490],[48.7900,2.3461],[48.7820,2.3432],[48.7740,2.3400]
  ];
  var idx=0;
  setInterval(function(){
    if(idx>=path.length) idx=0;
    var pt=path[idx++];
    procGPS({coords:{latitude:pt[0],longitude:pt[1],accuracy:8,speed:25}});
  },1600);
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
loadAll();
setTimeout(function(){if(!S.pos&&S.mapReady) startDemo();},10000);

})();
