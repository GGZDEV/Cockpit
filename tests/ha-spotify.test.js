const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const clean=file=>fs.readFileSync('public/'+file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export \{[^\n]+\};?\r?\n/gm,'').replace(/\bexport /g,'');
function setup(){
 const HD={},c={HD,window:{HD},feedmeComponent:()=>{throw Error('FeedMe must not be used for HA Spotify');},read:()=>null,esc:String,num:String,icon:()=>'',safeUrl:s=>s,spark:()=>''};vm.createContext(c);
 for(const file of ['vendor/home-icons.js','vendor/home-model.js','vendor/home-modules.js','rooms.js','native-renderers.js'])vm.runInContext(clean(file),c);
 const spotify={entity_id:'media_player.music_account',state:'playing',attributes:{friendly_name:'Spotify Guillaume',media_title:'Titre depuis HA',media_artist:'Artiste HA',source:'PC',source_list:['PC','Echo Dot'],volume_level:.4,shuffle:false,repeat:'off'}};
 const tv={entity_id:'media_player.tv',state:'playing',attributes:{friendly_name:'TV'}};
 const sources={status:{ha:'connected',feedme:'connected'},ha:{baseUrl:'http://ha'},revision:1,data:{states:[tv,spotify]},registries:{areas:[],devices:[],entities:[{entity_id:spotify.entity_id,platform:'spotify'}]}};
 return {c,sources,spotify,tv,widget:{id:'music',type:'spotify',width:2,height:3}};
}
test('Spotify uses the HA integration and its source list even when FeedMe is connected and another player comes first',()=>{
 const {c,sources,spotify,widget}=setup();const picked=c.spotifyStatesForWidget(sources,widget,null);assert.equal(picked[0].entity_id,spotify.entity_id);
 const html=c.nativeContent({widget,sources,home:true},()=>{throw Error('fallback');});
 assert.match(html,/Titre depuis HA/);assert.match(html,/data-act="media-source"/);assert.match(html,/>Echo Dot<\/option>/);assert.match(html,/data-act="media-vol"/);assert.doesNotMatch(html,/data-native-feedme|Reconnecter/);
 widget.entities=['media_player.tv'];assert.equal(c.spotifyStatesForWidget(sources,widget,null)[0].entity_id,'media_player.tv');
 widget.entities=[];assert.equal(c.spotifyStatesForWidget(sources,widget,null).length,0);
});
test('Spotify playback, source, volume, shuffle and repeat commands target the same HA account that is rendered',async()=>{
 const {c,sources,spotify,widget}=setup(),calls=[];sources.action=async(...args)=>calls.push(args);
 Object.assign(c,{editing:false,sources,currentRoom:()=>null,findWidget:()=>widget,advancedHA:async()=>false,toast:()=>{throw Error('unhandled control');},detailId:null});
 const app=fs.readFileSync('public/app.js','utf8'),start=app.indexOf('async function originalControl(element)');vm.runInContext(app.slice(start,app.indexOf('\ndocument.addEventListener',start)),c);
 for(const [act,arg,value] of [['media-source',null,'Echo Dot'],['media-vol',null,'65'],['media-cmd','play_pause'],['media-cmd','next'],['media-cmd','prev'],['media-cmd','shuffle'],['media-cmd','repeat']])await c.originalControl({dataset:{act,arg},value,closest:()=>({dataset:{widget:'music'}})});
 assert.equal(calls.length,7);assert.ok(calls.every(call=>call[0]==='media_player'&&call[2]===spotify.entity_id));
 assert.deepEqual(Array.from(calls,call=>call[1]),['select_source','volume_set','media_play_pause','media_next_track','media_previous_track','shuffle_set','repeat_set']);
 assert.equal(calls[0][3].source,'Echo Dot');assert.equal(calls[1][3].volume_level,.65);assert.equal(calls[5][3].shuffle,true);assert.equal(calls[6][3].repeat,'all');
});
