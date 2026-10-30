const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');

test('Spotify detection retains the last devices on failure, exposes the error and recovers on retry',async()=>{
  const text=fs.readFileSync('public/integrations/feedme/app.js','utf8');
  const functionSource=text.slice(text.indexOf('async function fetchSpotifyDevices()'),text.indexOf('async function transferSpotify('));
  const events=[],speaker={id:'speaker',name:'Echo Dot',active:false};
  let resolve,requests=0;
  const c={Store:{spotifyDevices:[speaker],spotifyDevicesLoading:false,spotifyDevicesError:null},Bus:{emit:()=>events.push(c.Store.spotifyDevicesLoading)},api:()=>{requests++;return new Promise(done=>resolve=done);}};
  vm.createContext(c);vm.runInContext(functionSource,c);
  const first=c.fetchSpotifyDevices();assert.equal(c.Store.spotifyDevicesLoading,true);
  await c.fetchSpotifyDevices();assert.equal(requests,1);
  resolve({devices:[speaker]});await first;assert.equal(c.Store.spotifyDevicesLoading,false);
  c.api=async()=>{throw Error('Spotify temporairement indisponible');};await c.fetchSpotifyDevices();
  assert.equal(c.Store.spotifyDevices[0].id,'speaker');assert.equal(c.Store.spotifyDevicesError,'Spotify temporairement indisponible');assert.equal(c.Store.spotifyDevicesLoading,false);
  c.api=async()=>({devices:[{id:'pc',name:'PC'}]});await c.fetchSpotifyDevices();
  assert.equal(c.Store.spotifyDevicesError,null);assert.equal(c.Store.spotifyDevices[0].id,'pc');
  c.api=async()=>({});await c.fetchSpotifyDevices();assert.equal(c.Store.spotifyDevices[0].id,'pc');assert.match(c.Store.spotifyDevicesError,/invalide/);
  assert.deepEqual(events,[true,false,true,false,true,false,true,false]);
});
